import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten";
import type { RunProgramLimits } from "./run-program.js";
import type {
  ProgramChildResult, ProgramErrorDiagnostic, ProgramVmRequest, ProgramVmResult,
} from "./run-program-protocol.js";

/** Only called by the trusted worker entry. All model code stays in QuickJS. */
export async function executeProgramVm(
  request: ProgramVmRequest,
  invoke: (name: string, inputJson: string) => Promise<ProgramChildResult>,
): Promise<ProgramVmResult> {
  const { code, toolNames, limits, deadline } = request;
  const cancelled = new Int32Array(request.cancellation);
  // Host initialization is bounded by the wall deadline, not the guest CPU
  // allowance. Start that allowance only when evaluating the user's program.
  let syncSliceStartedAt: number | undefined;
  let syncSliceTripped = false;
  let wallDeadlineTripped = false;
  let disposed = false;
  let runtime: QuickJSRuntime | null = null;
  let vm: QuickJSContext | null = null;
  let programPromiseHandle: QuickJSHandle | null = null;
  const pendingDeferreds = new Set<QuickJSDeferredPromise>();
  const failed = (message: string, error?: ProgramErrorDiagnostic, fallbackCode?: string): ProgramVmResult => ({
    status: "failed",
    code: Atomics.load(cancelled, 0) ? "E_PROGRAM_ABORTED"
      : wallDeadlineTripped ? "E_PROGRAM_TIMEOUT"
      : syncSliceTripped ? "E_PROGRAM_CPU_SLICE" : fallbackCode ?? classifyProgramError(message),
    message: syncSliceTripped ? syncSliceMessage(limits)
      : clarifyProgramApiError(message, code, toolNames),
    ...(error ? { error } : {}),
  });
  try {
    const module = await newQuickJSWASMModule();
    runtime = module.newRuntime();
    runtime.setMemoryLimit(limits.maxMemoryBytes);
    runtime.setMaxStackSize(limits.maxStackBytes);
    runtime.setInterruptHandler(() => {
      const now = Date.now();
      if (now >= deadline) wallDeadlineTripped = true;
      if (wallDeadlineTripped || Atomics.load(cancelled, 0)) return true;
      if (syncSliceStartedAt !== undefined && now - syncSliceStartedAt >= limits.maxSyncSliceMs) {
        syncSliceTripped = true;
        return true;
      }
      return false;
    });
    vm = runtime.newContext();
    const callToolHandle = vm.newFunction(
      "__orkas_call_tool",
      (nameHandle: QuickJSHandle, inputJsonHandle: QuickJSHandle) => {
        const deferred = vm!.newPromise();
        pendingDeferreds.add(deferred);
        const name = vm!.getString(nameHandle);
        const inputJson = vm!.getString(inputJsonHandle);
        void invoke(name, inputJson).then(
          (payload) => {
            if (disposed || !deferred.alive) return;
            const value = vm!.newString(JSON.stringify(payload));
            deferred.resolve(value);
            value.dispose();
          },
          (error) => {
            if (disposed || !deferred.alive) return;
            const quickError = vm!.newError({ name: "ProgramToolError", message: safeErrorMessage(error) });
            deferred.reject(quickError);
            quickError.dispose();
          },
        );
        void deferred.settled.finally(() => {
          pendingDeferreds.delete(deferred);
          if (!disposed && runtime?.alive) {
            syncSliceStartedAt = Date.now();
            const jobs = runtime.executePendingJobs();
            if (jobs.error) jobs.error.dispose();
          }
          if (deferred.alive) deferred.dispose();
        });
        return deferred.handle;
      },
    );
    callToolHandle.consume((handle) => vm!.setProp(vm!.global, "__orkas_call_tool", handle));
    const bootstrap = vm.evalCode(programBootstrap(toolNames), "run_program_bootstrap.js");
    if (bootstrap.error) {
      const diagnostic = quickJSError(vm, bootstrap.error);
      bootstrap.error.dispose();
      return failed(diagnostic.message, undefined, "E_PROGRAM_RUNTIME_INIT");
    }
    successfulHandle(bootstrap).dispose();
    syncSliceStartedAt = Date.now();
    const evaluated = vm.evalCode(`(async () => {\n${code}\n})()`, "run_program.js");
    if (evaluated.error) {
      const diagnostic = quickJSError(vm, evaluated.error, code);
      evaluated.error.dispose();
      return failed(diagnostic.message, diagnostic.error);
    }
    programPromiseHandle = successfulHandle(evaluated);
    const resolvedPromise = vm.resolvePromise(programPromiseHandle);
    const jobs = runtime.executePendingJobs();
    if (jobs.error) jobs.error.dispose();
    const settled = await resolvedPromise;
    programPromiseHandle.dispose();
    programPromiseHandle = null;
    if (settled.error) {
      const diagnostic = quickJSError(vm, settled.error, code);
      settled.error.dispose();
      return failed(diagnostic.message, diagnostic.error);
    }
    const settledValue = successfulHandle(settled);
    const returnedValue = vm.dump(settledValue);
    settledValue.dispose();
    const outputResult = vm.evalCode("JSON.stringify(globalThis.__orkas_outputs)", "run_program_output.js");
    if (outputResult.error) {
      const diagnostic = quickJSError(vm, outputResult.error);
      outputResult.error.dispose();
      return failed(diagnostic.message, undefined, "E_PROGRAM_OUTPUT");
    }
    const outputValue = successfulHandle(outputResult);
    const outputJson = vm.getString(outputValue);
    outputValue.dispose();
    const outputs = parseOutputs(outputJson);
    if (!outputs.length && returnedValue !== undefined) outputs.push(formatReturnedValue(returnedValue));
    if (!outputs.length) return { status: "completed" };
    const output = outputs.join("\n");
    if (Buffer.byteLength(output, "utf8") > limits.maxOutputBytes) {
      return {
        status: "failed", code: "E_PROGRAM_OUTPUT_LIMIT",
        message: `Program output exceeds the ${limits.maxOutputBytes}-byte limit. Return a smaller aggregate or summary.`,
      };
    }
    return { status: "completed", output };
  } catch (error) {
    return failed(safeErrorMessage(error));
  } finally {
    disposed = true;
    if (programPromiseHandle?.alive) programPromiseHandle.dispose();
    for (const deferred of pendingDeferreds) if (deferred.alive) deferred.dispose();
    pendingDeferreds.clear();
    if (vm?.alive) vm.dispose();
    if (runtime?.alive) runtime.dispose();
  }
}

function programBootstrap(toolNames: string[]): string {
  return `
globalThis.__orkas_outputs = [];
globalThis.text = (value) => {
  if (typeof value === "string") globalThis.__orkas_outputs.push(value);
  else if (value === undefined) globalThis.__orkas_outputs.push("undefined");
  else {
    try { globalThis.__orkas_outputs.push(JSON.stringify(value)); }
    catch { globalThis.__orkas_outputs.push(String(value)); }
  }
};
globalThis.json = (value) => globalThis.__orkas_outputs.push(JSON.stringify(value));
const __orkas_tools = Object.create(null);
for (const __name of ${JSON.stringify(toolNames)}) {
  Object.defineProperty(__orkas_tools, __name, {
    enumerable: true,
    configurable: false,
    writable: false,
    value: async (args = {}) => JSON.parse(await globalThis.__orkas_call_tool(__name, JSON.stringify(args))),
  });
}
globalThis.tools = Object.freeze(__orkas_tools);
Object.freeze(globalThis.tools);
`;
}


function clarifyProgramApiError(message: string, source: string, toolNames: readonly string[]): string {
  if (!/(?:not a function|not callable|undefined|cannot read propert)/i.test(message)) return message;

  const outputHelper = /\b(text|json)\s*\.\s*([A-Za-z_$][\w$]*)/.exec(source);
  if (outputHelper) {
    const helper = outputHelper[1];
    return `${message} ${helper}(value) is an output function; it has no .${outputHelper[2]} method.`.slice(0, 800);
  }

  const references = [
    ...source.matchAll(/\btools\s*\.\s*([A-Za-z_$][\w$]*)/g),
    ...source.matchAll(/\btools\s*\[\s*["']([^"']+)["']\s*\]/g),
  ];
  const unknown = references.map((match) => match[1]).find((name) => !toolNames.includes(name));
  if (!unknown) return message;
  const suggestion = nearestProgramToolName(unknown, toolNames);
  const guidance = suggestion
    ? `Unknown tools.${unknown}; use exact provider tool names. Did you mean tools.${suggestion}?`
    : `Unknown tools.${unknown}; use an exact provider snake_case tool name.`;
  return `${message} ${guidance}`.slice(0, 800);
}

function nearestProgramToolName(input: string, candidates: readonly string[]): string | undefined {
  const normalized = input.replace(/[_-]/g, "").toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const candidate = name.replace(/[_-]/g, "").toLowerCase();
    const distance = editDistance(normalized, candidate);
    if (!best || distance < best.distance || (distance === best.distance && name < best.name)) {
      best = { name, distance };
    }
  }
  if (!best) return undefined;
  return best.distance <= Math.max(2, Math.floor(Math.max(normalized.length, best.name.length) / 3))
    ? best.name
    : undefined;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = left[i - 1] === right[j - 1]
        ? diagonal
        : 1 + Math.min(diagonal, previous[j - 1], above);
      diagonal = above;
    }
  }
  return previous[right.length];
}


function parseOutputs(serialized: string): string[] {
  try {
    const parsed = JSON.parse(serialized);
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
}

function formatReturnedValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function quickJSError(
  vm: QuickJSContext,
  handle: QuickJSHandle,
  source?: string,
): { message: string; error?: ProgramErrorDiagnostic } {
  const dumped = vm.dump(handle) as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
  } | string | undefined;
  if (dumped && typeof dumped === "object") {
    const name = typeof dumped.name === "string" ? dumped.name : "Error";
    const message = typeof dumped.message === "string" ? dumped.message : "Program execution failed.";
    const error = source && typeof dumped.stack === "string"
      ? sourceErrorDiagnostic(dumped.stack, source)
      : undefined;
    return {
      message: `${name}: ${message}`.slice(0, 800),
      ...(error && Object.keys(error).length ? { error } : {}),
    };
  }
  return { message: String(dumped || "Program execution failed.").slice(0, 800) };
}

function sourceErrorDiagnostic(stack: string, source: string): ProgramErrorDiagnostic | undefined {
  const lines = source.split(/\r?\n/);
  const frames: Array<{ line: number; column: number }> = [];
  const framePattern = /run_program\.js:(\d+):(\d+)/g;
  for (const match of stack.matchAll(framePattern)) {
    // The user source is wrapped in one leading `(async () => {` line.
    const line = Number(match[1]) - 1;
    const column = Number(match[2]);
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) continue;
    if (line < 1 || line > lines.length || column < 1) continue;
    if (!frames.some((frame) => frame.line === line && frame.column === column)) {
      frames.push({ line, column });
    }
    if (frames.length >= 4) break;
  }
  const primary = frames[0];
  if (!primary) return undefined;
  const start = Math.max(1, primary.line - 1);
  const end = Math.min(lines.length, primary.line + 1);
  const sourceExcerpt: Array<{ line: number; text: string }> = [];
  for (let line = start; line <= end; line++) {
    const text = lines[line - 1] ?? "";
    sourceExcerpt.push({
      line,
      text: text.length > 180 ? `${text.slice(0, 177)}...` : text,
    });
  }
  return {
    line: primary.line,
    column: primary.column,
    frames,
    sourceExcerpt,
  };
}


function successfulHandle(result: unknown): QuickJSHandle {
  const value = (result as { value?: QuickJSHandle } | null)?.value;
  if (!value) throw new Error("QuickJS result did not contain a value.");
  return value;
}

function syncSliceMessage(limits: RunProgramLimits): string {
  return `Program ran ${limits.maxSyncSliceMs}ms of synchronous code without awaiting a tool call. `
    + "Break long loops into awaited tool calls or do the work in a direct bash/python job.";
}

function classifyProgramError(message: string): string {
  if (/interrupted/i.test(message)) return "E_PROGRAM_TIMEOUT";
  if (/out of memory|memory limit/i.test(message)) return "E_PROGRAM_MEMORY_LIMIT";
  if (/stack overflow/i.test(message)) return "E_PROGRAM_STACK_LIMIT";
  if (/syntaxerror/i.test(message)) return "E_PROGRAM_SYNTAX";
  return "E_PROGRAM_RUNTIME";
}

function safeErrorMessage(error: unknown): string {
  const code = errorCode(error);
  const raw = error instanceof Error ? error.message : String(error || "Program execution failed.");
  const message = raw.replace(/[\r\n]+/g, " ").slice(0, 700);
  return code ? `${code}: ${message}` : message;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}
