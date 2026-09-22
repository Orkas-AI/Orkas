import { parentPort } from "node:worker_threads";
import {
  MAX_PROGRAM_AGGREGATE_INPUT_BYTES,
  MAX_PROGRAM_TOOL_INPUT_BYTES,
  type ProgramChildResult,
  type ProgramHostMessage,
  type ProgramVmRequest,
  type ProgramVmResult,
  type ProgramWorkerMessage,
} from "./run-program-protocol.js";
import { executeProgramVm } from "./run-program-vm.js";

if (!parentPort) throw new Error("Program runtime requires a worker port.");
const port = parentPort;
type PendingCall = {
  resolve: (result: ProgramChildResult) => void;
  reject: (error: Error) => void;
};
let active: {
  request: ProgramVmRequest;
  nextCallId: number;
  inputBytes: number;
  pending: Map<number, PendingCall>;
  failure?: Extract<ProgramVmResult, { status: "failed" }>;
} | null = null;

function send(message: ProgramWorkerMessage): void { port.postMessage(message); }

port.on("message", (message: ProgramHostMessage) => {
  if (message.type !== "execute") {
    const owner = active;
    if (!owner || owner.request.executionId !== message.executionId) return;
    const call = owner.pending.get(message.callId);
    if (!call) return;
    owner.pending.delete(message.callId);
    if (message.type === "result") call.resolve(message.result);
    else call.reject(new Error(message.message));
    return;
  }
  // The host leases a worker exclusively until complete; an overlap is fatal.
  if (active) throw new Error("Program worker received overlapping executions.");
  const owner = { request: message.request, nextCallId: 0, inputBytes: 0, pending: new Map<number, PendingCall>() };
  active = owner;
  void run(owner);
});

async function run(owner: NonNullable<typeof active>): Promise<void> {
  const request = owner.request;
  const invoke = (name: string, inputJson: string): Promise<ProgramChildResult> => {
    if (active !== owner || Atomics.load(new Int32Array(request.cancellation), 0)) {
      return Promise.reject(new Error("E_PROGRAM_ABORTED: Program execution was cancelled."));
    }
    if (owner.failure) return Promise.reject(new Error(owner.failure.message));
    const inputBytes = Buffer.byteLength(inputJson, "utf8") + Buffer.byteLength(name, "utf8");
    owner.inputBytes += inputBytes;
    if (inputBytes > MAX_PROGRAM_TOOL_INPUT_BYTES || owner.inputBytes > MAX_PROGRAM_AGGREGATE_INPUT_BYTES) {
      owner.failure = {
        status: "failed", code: "E_PROGRAM_TOOL_INPUT_LIMIT",
        message: "Program tool arguments exceed the bounded message limit. Use smaller batches.",
      };
      return Promise.reject(new Error(owner.failure.message));
    }
    const callId = ++owner.nextCallId;
    // Forward the first over-limit call so the host retains its existing
    // attempted-call receipt and fatal limit; never enqueue an unbounded tail.
    if (callId > request.limits.maxToolCalls + 1) {
      owner.failure = {
        status: "failed", code: "E_PROGRAM_TOOL_CALL_LIMIT",
        message: `Program exceeded the ${request.limits.maxToolCalls}-call limit.`,
      };
      return Promise.reject(new Error(owner.failure.message));
    }
    return new Promise((resolve, reject) => {
      owner.pending.set(callId, { resolve, reject });
      send({ type: "call", executionId: request.executionId, callId, name, inputJson });
    });
  };
  try {
    const result = await executeProgramVm(request, invoke);
    // executeProgramVm has disposed all guest handles before a worker is reusable.
    send({ type: "complete", executionId: request.executionId, result: owner.failure ?? result });
  } catch {
    // A failed disposal or host-engine invariant must retire the entire worker.
    send({ type: "bootstrap_error" });
  } finally {
    owner.pending.clear();
    active = null;
  }
}

send({ type: "ready" });
