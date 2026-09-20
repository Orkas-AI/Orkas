import { createHash } from "node:crypto";
import { basename, isAbsolute, relative, sep } from "node:path";

import { programWorkerPool } from "./run-program-worker-pool.js";
import type { ProgramChildResult, ProgramErrorDiagnostic } from "./run-program-protocol.js";

import {
  type AgentTool,
  type ToolContext,
  type ToolObservations,
  type ToolResult,
} from "./base.js";

export const RUN_PROGRAM_TOOL_NAME = "run_program";
const PROGRAMMATIC_TOOL_CALL_STATE = Symbol("orkas.programmatic-tool-call");

/** Mark the state passed to a program child tool. The unexported symbol keeps
 * model input and unrelated tools from forging this Host-only boundary. */
export function markProgrammaticToolCallState<T extends Record<string, unknown>>(state: T): T {
  Object.defineProperty(state, PROGRAMMATIC_TOOL_CALL_STATE, { value: true });
  return state;
}

/** Whether a target tool is executing inside the isolated program runtime. */
export function isProgrammaticToolCallContext(ctx: ToolContext): boolean {
  return (ctx.state as Record<PropertyKey, unknown>)[PROGRAMMATIC_TOOL_CALL_STATE] === true;
}

export type ProgrammaticToolAuthorization =
  | { allowed: true }
  | {
      allowed: false;
      code: string;
      reason: string;
      directCallAllowed?: boolean;
    };

export type ProgrammaticToolPolicy = {
  /** Static, host-owned eligibility used to construct the injected tools object. */
  isEligible(name: string): boolean;
  /** Per-call authorization. This never replaces the target tool's own gates. */
  authorize(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): ProgrammaticToolAuthorization | Promise<ProgrammaticToolAuthorization>;
};

export type ProgrammaticToolInvokeOutcome =
  | { status: "completed"; result: ToolResult }
  | {
      status: "denied";
      code: string;
      reason: string;
      directCallAllowed?: boolean;
    }
  | { status: "aborted"; code: string; reason: string };

export type ProgramSourceLoadOutcome =
  | { status: "completed"; source: string; resolvedPath: string }
  | { status: "denied"; code: string; reason: string };

export type ProgramSourceLoader = (
  requestedPath: string,
  ctx: ToolContext,
  maxSourceChars: number,
) => Promise<ProgramSourceLoadOutcome>;

export type RunProgramLimits = {
  maxSourceChars: number;
  maxWallMs: number;
  /** Longest synchronous guest stretch between awaited tool calls. QuickJS
   *  runs in its own worker; this bounds CPU occupation independently of the
   *  original wall deadline, which also includes admission and tool waits. */
  maxSyncSliceMs: number;
  maxMemoryBytes: number;
  maxStackBytes: number;
  maxToolCalls: number;
  maxConcurrentToolCalls: number;
  maxToolResultBytes: number;
  maxAggregateToolResultBytes: number;
  maxOutputBytes: number;
};

export const DEFAULT_RUN_PROGRAM_LIMITS: Readonly<RunProgramLimits> = Object.freeze({
  maxSourceChars: 64_000,
  maxWallMs: 10 * 60_000,
  maxSyncSliceMs: 10_000,
  maxMemoryBytes: 64 * 1024 * 1024,
  maxStackBytes: 1 * 1024 * 1024,
  maxToolCalls: 100,
  maxConcurrentToolCalls: 8,
  maxToolResultBytes: 8 * 1024 * 1024,
  maxAggregateToolResultBytes: 32 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
});

export type CreateRunProgramToolOptions = {
  listToolNames: () => string[];
  invokeTool: (
    name: string,
    input: Record<string, unknown>,
    parentCtx: ToolContext,
  ) => Promise<ProgrammaticToolInvokeOutcome>;
  /** Host-owned file reader. The host must enforce the same path and
   * sensitive-file policy as its ordinary read tools before returning source. */
  loadSourceFile?: ProgramSourceLoader;
  limits?: Partial<RunProgramLimits>;
};

type ProgramFatal = {
  code: string;
  reason: string;
  directCallAllowed?: boolean;
};

type ProgramChildFailure = {
  tool: string;
  call: number;
  code?: string;
  message: string;
};

type ProgramExecutionReceipt = {
  source_kind: "inline" | "file";
  source_sha256: string;
  attempted_calls: number;
  completed_calls: number;
  failed_calls: number;
  changed_files: {
    total: number;
    items: Array<{
      path: string;
      operation: "create" | "update" | "delete" | "rename";
      bytes?: number;
      hash?: string;
    }>;
    truncated?: boolean;
  };
  failed_tool?: ProgramChildFailure;
  error?: ProgramErrorDiagnostic;
};

type QueueEntry = {
  resolve: () => void;
  reject: (error: Error) => void;
};

class ProgramSemaphore {
  private active = 0;
  private readonly queue: QueueEntry[] = [];
  private stopped: Error | null = null;

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<() => void> {
    if (this.stopped) throw this.stopped;
    if (this.active < this.capacity) {
      this.active += 1;
      return this.releaseOnce();
    }
    await new Promise<void>((resolve, reject) => this.queue.push({ resolve, reject }));
    if (this.stopped) throw this.stopped;
    this.active += 1;
    return this.releaseOnce();
  }

  stop(error: Error): void {
    if (this.stopped) return;
    this.stopped = error;
    for (const entry of this.queue.splice(0)) entry.reject(error);
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      if (!this.stopped) this.queue.shift()?.resolve();
    };
  }
}

export function createRunProgramTool(opts: CreateRunProgramToolOptions): AgentTool {
  const limits = normalizeLimits(opts.limits);
  const supportsSourcePath = typeof opts.loadSourceFile === "function";
  const properties: Record<string, unknown> = {
    code: {
      type: "string",
      maxLength: limits.maxSourceChars,
      description:
        "QuickJS with top-level await; no Node APIs or direct filesystem/network. tools.<exact_snake_case_name>(direct args): {ok,content} (boolean,string). Check ok; JSON only: JSON.parse(content). text(value) or json(value).",
    },
    ...(supportsSourcePath ? {
      path: {
        type: "string",
        description:
          "Workspace-visible UTF-8 QuickJS source to execute exactly as saved in the same sandbox. Use instead of code, not together.",
      },
    } : {}),
  };
  const description = programmaticToolDescription(limits);
  return {
    name: RUN_PROGRAM_TOOL_NAME,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(!supportsSourcePath ? { required: ["code"] } : {}),
      additionalProperties: false,
    },
    executionTimeoutOwner: "executor",
    async execute(input, ctx) {
      if ([input.code, input.path].some((value) => value != null && typeof value !== "string")) {
        return incompleteResult("E_PROGRAM_BAD_INPUT", "`code` and `path` must be strings when supplied.", 0);
      }
      const inlineCode = typeof input.code === "string" ? input.code : "";
      const requestedPath = typeof input.path === "string" ? input.path.trim() : "";
      if (Boolean(inlineCode.trim()) === Boolean(requestedPath)) {
        return incompleteResult(
          "E_PROGRAM_BAD_INPUT",
          supportsSourcePath
            ? "Provide exactly one non-empty `code` or `path`."
            : "`code` must be a non-empty string.",
          0,
        );
      }
      let code = inlineCode;
      let sourcePath: string | undefined;
      if (requestedPath) {
        if (!opts.loadSourceFile) {
          return incompleteResult(
            "E_PROGRAM_PATH_UNAVAILABLE",
            "Saved-file execution is unavailable in this host; use `code`.",
            0,
          );
        }
        const loaded = await opts.loadSourceFile(requestedPath, ctx, limits.maxSourceChars);
        if (loaded.status === "denied") {
          return incompleteResult(loaded.code, loaded.reason, 0);
        }
        code = loaded.source;
        sourcePath = loaded.resolvedPath;
      }
      if (!code.trim()) {
        return incompleteResult("E_PROGRAM_BAD_INPUT", "Program source must be non-empty.", 0);
      }
      if (code.length > limits.maxSourceChars) {
        return incompleteResult(
          "E_PROGRAM_SOURCE_LIMIT",
          `Program source exceeds the ${limits.maxSourceChars}-character limit.`,
          0,
        );
      }
      return runProgram(code, ctx, opts, limits, sourcePath);
    },
  };
}

async function runProgram(
  code: string,
  parentCtx: ToolContext,
  opts: CreateRunProgramToolOptions,
  limits: RunProgramLimits,
  sourcePath?: string,
): Promise<ToolResult> {
  const sourceSha256 = `sha256:${createHash("sha256").update(code, "utf8").digest("hex")}`;
  const observations: ToolObservations = {
    programExecution: {
      sourceKind: sourcePath ? "file" : "inline",
      sourceSha256,
      childCalls: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        failedTools: [],
      },
    },
    ...(sourcePath ? {
      fileReads: [{ path: sourcePath, hash: sourceSha256 }],
    } : {}),
  };
  const startedAt = Date.now();
  const deadline = startedAt + limits.maxWallMs;
  const programAbort = createLinkedAbortController(parentCtx.signal);
  const semaphore = new ProgramSemaphore(limits.maxConcurrentToolCalls);
  let fatal: ProgramFatal | null = null;
  let attemptedToolCalls = 0;
  let completedToolCalls = 0;
  let failedToolCalls = 0;
  let succeededChildCalls = 0;
  let failedChildCalls = 0;
  const failedChildTools = new Map<string, number>();
  let lastChildFailure: ProgramChildFailure | undefined;
  let aggregateToolResultBytes = 0;
  let disposed = false;

  const observeChildFailure = (name: string): void => {
    failedChildCalls += 1;
    failedChildTools.set(name, (failedChildTools.get(name) ?? 0) + 1);
  };
  const observed = (result: ToolResult): ToolResult => {
    observations.programExecution!.childCalls = {
      attempted: Math.max(0, attemptedToolCalls),
      succeeded: Math.max(0, succeededChildCalls),
      failed: Math.max(0, failedChildCalls),
      failedTools: [...failedChildTools]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, count]) => ({ name, count })),
    };
    return { ...result, observations };
  };

  const executionReceipt = (error?: ProgramErrorDiagnostic): ProgramExecutionReceipt => ({
    source_kind: sourcePath ? "file" : "inline",
    source_sha256: sourceSha256,
    attempted_calls: Math.max(0, attemptedToolCalls),
    completed_calls: Math.max(0, completedToolCalls),
    failed_calls: Math.max(0, failedToolCalls),
    changed_files: compactChangedFiles(observations, parentCtx.workingDir),
    ...(lastChildFailure ? { failed_tool: lastChildFailure } : {}),
    ...(error && Object.keys(error).length ? { error } : {}),
  });
  const incomplete = (
    reason: string,
    message: string,
    directCallAllowed?: boolean,
    error?: ProgramErrorDiagnostic,
  ): ToolResult => observed(incompleteResult(
    reason,
    message,
    attemptedToolCalls,
    completedToolCalls,
    directCallAllowed,
    executionReceipt(error),
  ));
  if (parentCtx.signal?.aborted) {
    return incomplete("E_PROGRAM_ABORTED", "Program execution was cancelled.", true);
  }

  const setFatal = (next: ProgramFatal): Error => {
    if (!fatal) fatal = next;
    const error = Object.assign(new Error(next.reason), { code: next.code });
    semaphore.stop(error);
    if (!programAbort.signal.aborted) programAbort.abort(error);
    return error;
  };

  const rejectForExternalStop = (next: ProgramFatal) => { setFatal(next); };
  const deadlineTimer = setTimeout(() => {
    rejectForExternalStop({
      code: "E_PROGRAM_TIMEOUT",
      reason: `Program exceeded the ${limits.maxWallMs}ms execution limit.`,
      directCallAllowed: true,
    });
  }, limits.maxWallMs);
  const rejectForParentAbort = () => rejectForExternalStop({
    code: "E_PROGRAM_ABORTED",
    reason: "Program execution was cancelled.",
    directCallAllowed: true,
  });
  if (parentCtx.signal?.aborted) rejectForParentAbort();
  else parentCtx.signal?.addEventListener("abort", rejectForParentAbort, { once: true });

  try {
    const settled = await programWorkerPool.execute({
      code,
      toolNames: programmaticToolNames(opts.listToolNames),
      limits,
      deadline,
      signal: programAbort.signal,
      invoke: invokeFromProgram,
    });
    const fatalAfterSettlement = fatal as ProgramFatal | null;
    if (fatalAfterSettlement) {
      return incomplete(fatalAfterSettlement.code, fatalAfterSettlement.reason, fatalAfterSettlement.directCallAllowed);
    }
    if (settled.status === "failed") {
      return incomplete(settled.code, settled.message, undefined, settled.error);
    }
    if (settled.output === undefined) {
      if (completedToolCalls > 0 && failedToolCalls === 0) {
        return observed({ content: completedProgramContent(completedToolCalls, executionReceipt(), undefined) });
      }
      return incomplete(
        "E_PROGRAM_NO_OUTPUT",
        failedToolCalls > 0
          ? "Program completed without output after one or more child-tool errors. Handle the errors and emit a result with text(value) or json(value)."
          : "Program completed without output or tool calls. Emit a result with text(value) or json(value).",
      );
    }
    return observed({ content: completedProgramContent(completedToolCalls, executionReceipt(), settled.output) });
  } catch (error) {
    const terminalFailure = fatal as ProgramFatal | null;
    if (terminalFailure) {
      return incomplete(terminalFailure.code, terminalFailure.reason, terminalFailure.directCallAllowed);
    }
    const code = errorCode(error);
    if (code === "E_PROGRAM_ABORTED" || parentCtx.signal?.aborted) {
      return incomplete("E_PROGRAM_ABORTED", "Program execution was cancelled.");
    }
    const message = safeErrorMessage(error);
    return incomplete(code === "E_PROGRAM_CAPACITY" ? code : classifyProgramError(message), message);
  } finally {
    clearTimeout(deadlineTimer);
    disposed = true;
    // A program that returned while a child call it never awaited is still
    // running would otherwise report "completed" and leave that child alive
    // with a live signal, holding the sequential tail for the next program
    // (2026-08-28 review C-1). The program is over: cancel its children.
    if (!programAbort.signal.aborted) {
      programAbort.abort(Object.assign(new Error("program finished"), { code: "E_PROGRAM_ABORTED" }));
    }
    parentCtx.signal?.removeEventListener("abort", rejectForParentAbort);
    programAbort.cleanup();
    semaphore.stop(Object.assign(new Error("Program execution finished."), { code: "E_PROGRAM_ABORTED" }));
  }

  async function invokeFromProgram(
    name: string,
    inputJson: string,
  ): Promise<ProgramChildResult> {
    if (fatal) throw Object.assign(new Error(fatal.reason), { code: fatal.code });
    if (programAbort.signal.aborted) {
      throw setFatal({
        code: parentCtx.signal?.aborted ? "E_PROGRAM_ABORTED" : "E_PROGRAM_TIMEOUT",
        reason: parentCtx.signal?.aborted
          ? "Program execution was cancelled."
          : `Program exceeded the ${limits.maxWallMs}ms execution limit.`,
        directCallAllowed: true,
      });
    }
    attemptedToolCalls += 1;
    if (attemptedToolCalls > limits.maxToolCalls) {
      failedToolCalls += 1;
      observeChildFailure(name);
      lastChildFailure = {
        tool: name,
        call: attemptedToolCalls,
        code: "E_PROGRAM_TOOL_CALL_LIMIT",
        message: `Program exceeded the ${limits.maxToolCalls}-call limit.`,
      };
      throw setFatal({
        code: "E_PROGRAM_TOOL_CALL_LIMIT",
        reason: `Program exceeded the ${limits.maxToolCalls}-call limit.`,
        directCallAllowed: true,
      });
    }
    const callNumber = attemptedToolCalls;
    let parsed: unknown;
    try {
      parsed = JSON.parse(inputJson);
    } catch {
      failedToolCalls += 1;
      observeChildFailure(name);
      lastChildFailure = childFailureSummary(
        name,
        callNumber,
        "E_PROGRAM_BAD_TOOL_INPUT: tool arguments must be JSON-serializable.",
      );
      return { ok: false, content: "E_PROGRAM_BAD_TOOL_INPUT: tool arguments must be JSON-serializable." };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      failedToolCalls += 1;
      observeChildFailure(name);
      lastChildFailure = childFailureSummary(
        name,
        callNumber,
        "E_PROGRAM_BAD_TOOL_INPUT: tool arguments must be a JSON object.",
      );
      return { ok: false, content: "E_PROGRAM_BAD_TOOL_INPUT: tool arguments must be a JSON object." };
    }

    const release = await semaphore.acquire();
    try {
      if (disposed || programAbort.signal.aborted) {
        throw Object.assign(new Error("Program execution was cancelled."), { code: "E_PROGRAM_ABORTED" });
      }
      const currentFatal = fatal as ProgramFatal | null;
      if (currentFatal) {
        throw Object.assign(new Error(currentFatal.reason), { code: currentFatal.code });
      }
      parentCtx.emitProgress?.({
        phase: "program_tool",
        message: `Running ${name} (${callNumber}/${limits.maxToolCalls})`,
        data: { programmatic: true, tool: name, completedCalls: completedToolCalls },
      });
      const outcome = await opts.invokeTool(name, parsed as Record<string, unknown>, {
        ...parentCtx,
        signal: programAbort.signal,
      });
      if (disposed) {
        throw Object.assign(new Error("Program execution finished."), { code: "E_PROGRAM_ABORTED" });
      }
      if (outcome.status === "denied") {
        failedToolCalls += 1;
        observeChildFailure(name);
        lastChildFailure = {
          tool: name,
          call: callNumber,
          code: outcome.code,
          message: outcome.reason.slice(0, 280),
        };
        throw setFatal({
          code: outcome.code,
          reason: outcome.reason,
          ...(outcome.directCallAllowed === undefined
            ? {}
            : { directCallAllowed: outcome.directCallAllowed }),
        });
      }
      if (outcome.status === "aborted") {
        failedToolCalls += 1;
        observeChildFailure(name);
        lastChildFailure = {
          tool: name,
          call: callNumber,
          code: outcome.code,
          message: outcome.reason.slice(0, 280),
        };
        throw setFatal({ code: outcome.code, reason: outcome.reason, directCallAllowed: true });
      }
      completedToolCalls += 1;
      if (outcome.result.isError) {
        failedToolCalls += 1;
        observeChildFailure(name);
        lastChildFailure = childFailureSummary(name, callNumber, outcome.result.content);
      } else {
        succeededChildCalls += 1;
      }
      parentCtx.emitProgress?.({
        phase: "program_tool_complete",
        message: `${name} ${outcome.result.isError ? "returned an error" : "completed"}`,
        data: { programmatic: true, tool: name, ok: !outcome.result.isError },
      });
      const childResult: ProgramChildResult = {
        ok: !outcome.result.isError,
        content: outcome.result.content,
        ...(outcome.result.displayName ? { displayName: outcome.result.displayName } : {}),
        ...programArtifactIdentities(outcome.result.observations, parentCtx.workingDir),
      };
      const contentBytes = Buffer.byteLength(outcome.result.content, "utf8");
      if (contentBytes > limits.maxToolResultBytes) {
        if (!outcome.result.isError) failedToolCalls += 1;
        lastChildFailure = {
          tool: name,
          call: callNumber,
          code: "E_PROGRAM_TOOL_RESULT_LIMIT",
          message: `${name} returned more than ${limits.maxToolResultBytes} bytes.`,
        };
        throw setFatal({
          code: "E_PROGRAM_TOOL_RESULT_LIMIT",
          reason: `${name} returned more than ${limits.maxToolResultBytes} bytes. Use a narrower request or direct tool call.`,
          directCallAllowed: true,
        });
      }
      const artifactBytes = childResult.artifacts
        ? Buffer.byteLength(JSON.stringify(childResult.artifacts), "utf8")
        : 0;
      aggregateToolResultBytes += contentBytes + artifactBytes;
      if (aggregateToolResultBytes > limits.maxAggregateToolResultBytes) {
        if (!outcome.result.isError) failedToolCalls += 1;
        lastChildFailure = {
          tool: name,
          call: callNumber,
          code: "E_PROGRAM_AGGREGATE_RESULT_LIMIT",
          message: `Program tool results exceeded the ${limits.maxAggregateToolResultBytes}-byte aggregate limit.`,
        };
        throw setFatal({
          code: "E_PROGRAM_AGGREGATE_RESULT_LIMIT",
          reason: `Program tool results exceeded the ${limits.maxAggregateToolResultBytes}-byte aggregate limit.`,
          directCallAllowed: true,
        });
      }
      mergeObservations(observations, outcome.result.observations);
      return childResult;
    } finally {
      release();
    }
  }
}

function programmaticToolNames(listToolNames: () => string[]): string[] {
  try {
    return [...new Set(listToolNames())]
      .filter((name) => typeof name === "string" && name.length > 0 && name !== RUN_PROGRAM_TOOL_NAME)
      .sort();
  } catch {
    return [];
  }
}

function programmaticToolDescription(
  limits: RunProgramLimits,
): string {
  return `Bounded QuickJS for in-memory logic unavailable from a Host tool, or to combine/branch/batch/reduce Host-tool results (${limits.maxToolCalls} calls/${limits.maxConcurrentToolCalls} concurrent/${formatLimitDuration(limits.maxWallMs)}/${formatLimitBytes(limits.maxToolResultBytes)} each/${formatLimitBytes(limits.maxAggregateToolResultBytes)} total). Call one Host operation directly. Use bash for local files, shell/CLI, Python, Node, native dependencies/scripts. Eligible calls: tools.<exact_snake_case_name>(direct args); check {ok,content}. tool_load reveals schemas, not permission; child policy/concurrency apply. No Node/I/O. Emit a compact result.`;
}

function formatLimitDuration(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

function formatLimitBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)}MB`;
  if (bytes % 1024 === 0) return `${bytes / 1024}KB`;
  return `${bytes}B`;
}

function normalizeLimits(overrides: Partial<RunProgramLimits> | undefined): RunProgramLimits {
  const out = { ...DEFAULT_RUN_PROGRAM_LIMITS, ...(overrides ?? {}) };
  for (const [key, value] of Object.entries(out)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Invalid run_program limit ${key}`);
    }
    (out as unknown as Record<string, number>)[key] = Math.trunc(value);
  }
  out.maxConcurrentToolCalls = Math.min(out.maxConcurrentToolCalls, out.maxToolCalls);
  return out;
}

function createLinkedAbortController(parent: AbortSignal | undefined): AbortController & { cleanup(): void } {
  const controller = new AbortController() as AbortController & { cleanup(): void };
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  controller.cleanup = () => parent?.removeEventListener("abort", onAbort);
  return controller;
}

function compactWorkspacePath(filePath: string, workingDir: string | undefined): string {
  if (workingDir) {
    const candidate = relative(workingDir, filePath);
    if (candidate && candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate)) {
      return candidate.split(sep).join("/");
    }
  }
  return basename(filePath);
}

function compactChangedFiles(
  observations: ToolObservations,
  workingDir: string | undefined,
): ProgramExecutionReceipt["changed_files"] {
  const byPath = new Map<string, NonNullable<ToolObservations["fileChanges"]>[number]>();
  for (const change of observations.fileChanges ?? []) {
    byPath.set(change.destinationPath ?? change.sourcePath, change);
  }
  const all = [...byPath.values()];
  const items = all.slice(-8).map((change) => {
    const finalPath = change.destinationPath ?? change.sourcePath;
    const bytes = change.afterExists ? change.afterBytes : change.beforeBytes;
    const hash = change.afterExists ? change.afterHash : change.beforeHash;
    return {
      path: compactWorkspacePath(finalPath, workingDir),
      operation: change.operation,
      ...(bytes === undefined ? {} : { bytes }),
      ...(hash ? { hash } : {}),
    };
  });
  return {
    total: all.length,
    items,
    ...(all.length > items.length ? { truncated: true } : {}),
  };
}

function programArtifactIdentities(
  observations: ToolObservations | undefined,
  workingDir: string | undefined,
): Pick<ProgramChildResult, "artifacts"> {
  const byPath = new Map<string, NonNullable<ToolObservations["fileChanges"]>[number]>();
  for (const change of observations?.fileChanges ?? []) {
    byPath.set(change.destinationPath ?? change.sourcePath, change);
  }
  if (!byPath.size) return {};
  return {
    artifacts: [...byPath.values()].map((change) => {
      const finalPath = change.destinationPath ?? change.sourcePath;
      return {
        path: compactWorkspacePath(finalPath, workingDir),
        operation: change.operation,
        exists: change.afterExists,
        ...(change.afterExists && change.afterBytes !== undefined
          ? { bytes: change.afterBytes }
          : {}),
        ...(change.afterExists && change.afterHash ? { hash: change.afterHash } : {}),
      };
    }),
  };
}

function childFailureSummary(tool: string, call: number, content: string): ProgramChildFailure {
  let code: string | undefined;
  let message: string | undefined;
  if (content.length <= 4_096) {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const candidateCode = parsed.reason ?? parsed.errorCode ?? parsed.code;
      const candidateMessage = parsed.message ?? parsed.detail;
      if (typeof candidateCode === "string" && /^[A-Z][A-Z0-9_]{2,80}$/.test(candidateCode)) {
        code = candidateCode;
      }
      if (typeof candidateMessage === "string") message = candidateMessage;
    } catch {
      // Ordinary tool errors are often plain text.
    }
  }
  const flattened = (message ?? content).replace(/[\r\n]+/g, " ").trim();
  if (!code) code = flattened.match(/\bE_[A-Z0-9_]{2,80}\b/)?.[0];
  return {
    tool,
    call,
    ...(code ? { code } : {}),
    message: (flattened || "Child tool returned an error.").slice(0, 280),
  };
}

function completedProgramContent(
  completedToolCalls: number,
  receipt: ProgramExecutionReceipt,
  output: string | undefined,
): string {
  const heading = `Program completed after ${completedToolCalls} tool call${completedToolCalls === 1 ? "" : "s"}`
    + (output === undefined ? " with no emitted output." : ".");
  const receiptLine = `Execution receipt: ${JSON.stringify(receipt)}`;
  return output === undefined
    ? `${heading}\n${receiptLine}`
    : `${heading}\n${receiptLine}\n\n${output}`;
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

function incompleteResult(
  reason: string,
  message: string,
  attemptedToolCalls: number,
  completedToolCalls = attemptedToolCalls,
  directCallAllowed?: boolean,
  execution?: ProgramExecutionReceipt,
): ToolResult {
  return {
    content: JSON.stringify({
      status: "incomplete",
      reason,
      message,
      attempted_calls: Math.max(0, attemptedToolCalls),
      completed_calls: Math.max(0, completedToolCalls),
      ...(directCallAllowed === undefined ? {} : { direct_call_allowed: directCallAllowed }),
      ...(execution ? { execution } : {}),
    }),
    isError: true,
  };
}

function mergeObservations(target: ToolObservations, source: ToolObservations | undefined): void {
  if (!source) return;
  if (source.fileReads?.length) {
    target.fileReads = [...(target.fileReads ?? []), ...source.fileReads];
  }
  if (source.fileChanges?.length) {
    target.fileChanges = [...(target.fileChanges ?? []), ...source.fileChanges];
  }
}
