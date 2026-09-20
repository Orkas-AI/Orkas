import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import {
  MAX_PROGRAM_AGGREGATE_INPUT_BYTES,
  MAX_PROGRAM_TOOL_INPUT_BYTES,
  type ProgramChildResult,
  type ProgramHostMessage,
  type ProgramVmRequest,
  type ProgramVmResult,
  type ProgramWorkerMessage,
} from "./run-program-protocol.js";

const require = createRequire(import.meta.url);
export const MAX_PROGRAM_WORKERS = Math.max(1, Math.min(4, availableParallelism() - 1));
const MAX_QUEUED_PROGRAMS = 64;
const IDLE_WORKER_MS = 30_000;
const BOOTSTRAP = `
const { workerData, parentPort } = require('node:worker_threads');
try {
  require(workerData.tsxApiPath);
  require(require('node:url').fileURLToPath(workerData.moduleUrl));
} catch {
  parentPort.postMessage({ type: 'bootstrap_error' });
}
`;

type Slot = {
  worker: Worker;
  ready: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  retired: boolean;
  termination?: Promise<number>;
};
type Waiter = { resolve: (slot: Slot) => void; reject: (error: Error) => void; cleanup: () => void };
type Execution = Omit<ProgramVmRequest, "executionId" | "cancellation"> & {
  signal: AbortSignal;
  invoke: (name: string, inputJson: string) => Promise<ProgramChildResult>;
};

function workerError(message = "Program runtime could not complete execution."): Error {
  return Object.assign(new Error(message), { code: "E_PROGRAM_RUNTIME" });
}
function abortError(): Error {
  return Object.assign(new Error("Program execution was cancelled."), { code: "E_PROGRAM_ABORTED" });
}

/** A lease owns exactly one program, including its async tool waits. FIFO
 * admission bounds live heaps; it does not preempt another program's tools. */
export class ProgramWorkerPool {
  private readonly workers = new Set<Slot>();
  private readonly idle: Slot[] = [];
  private readonly queue: Waiter[] = [];
  private nextExecutionId = 0;
  private closed = false;

  constructor(
    private readonly capacity = MAX_PROGRAM_WORKERS,
    private readonly queueLimit = MAX_QUEUED_PROGRAMS,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1 || !Number.isInteger(queueLimit) || queueLimit < 0) {
      throw new Error("Invalid program worker capacity.");
    }
  }

  async execute(options: Execution): Promise<ProgramVmResult> {
    const slot = await this.acquire(options.signal);
    let reusable = false;
    let stopped = false;
    let callId = 0;
    let inputBytes = 0;
    const executionId = ++this.nextExecutionId;
    const cancellation = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const cancelView = new Int32Array(cancellation);
    let onMessage: (raw: ProgramWorkerMessage) => void = () => {};
    let onFailure: () => void = () => {};
    let onAbort: () => void = () => {};
    try {
      return await new Promise<ProgramVmResult>((resolve, reject) => {
        const fail = (error: Error) => {
          if (stopped) return;
          stopped = true;
          reject(error);
        };
        const send = (message: ProgramHostMessage) => {
          if (stopped || options.signal.aborted) return;
          try { slot.worker.postMessage(message); }
          catch { fail(workerError()); }
        };
        onAbort = () => {
          Atomics.store(cancelView, 0, 1);
          // postMessage alone cannot interrupt a synchronous guest loop.
          fail(abortError());
        };
        onFailure = () => fail(workerError());
        onMessage = (raw) => {
          if (stopped) return;
          if (!raw || typeof raw !== "object" || raw.type === "bootstrap_error") {
            fail(workerError());
            return;
          }
          if (raw.type === "ready") return;
          if (raw.executionId !== executionId) return;
          if (raw.type === "complete") {
            const result = raw.result;
            if (!result || (result.status !== "completed" && result.status !== "failed")) {
              fail(workerError());
              return;
            }
            stopped = true;
            reusable = true;
            resolve(result);
            return;
          }
          if (raw.type !== "call" || raw.callId !== ++callId
            || callId > options.limits.maxToolCalls + 1
            || typeof raw.name !== "string" || typeof raw.inputJson !== "string") {
            fail(workerError());
            return;
          }
          const bytes = Buffer.byteLength(raw.inputJson, "utf8") + Buffer.byteLength(raw.name, "utf8");
          inputBytes += bytes;
          if (bytes > MAX_PROGRAM_TOOL_INPUT_BYTES || inputBytes > MAX_PROGRAM_AGGREGATE_INPUT_BYTES) {
            fail(workerError());
            return;
          }
          // The closure binds the original host context, permissions, sequence
          // gates and observations. Never clone those capabilities into a VM.
          void Promise.resolve().then(() => options.invoke(raw.name, raw.inputJson)).then(
            result => send({ type: "result", executionId, callId: raw.callId, result }),
            error => send({ type: "error", executionId, callId: raw.callId,
              message: error instanceof Error ? error.message.slice(0, 800) : "Program child call failed." }),
          );
        };
        slot.worker.on("message", onMessage);
        slot.worker.once("error", onFailure);
        slot.worker.once("exit", onFailure);
        options.signal.addEventListener("abort", onAbort, { once: true });
        if (options.signal.aborted) { onAbort(); return; }
        void slot.ready.then(() => {
          send({ type: "execute", request: {
            executionId, cancellation, code: options.code, toolNames: options.toolNames,
            limits: options.limits, deadline: options.deadline,
          } });
        }, onFailure);
      });
    } finally {
      stopped = true;
      slot.worker.removeListener("message", onMessage);
      slot.worker.removeListener("error", onFailure);
      slot.worker.removeListener("exit", onFailure);
      options.signal.removeEventListener("abort", onAbort);
      if (!reusable || options.signal.aborted || slot.retired) await this.retire(slot);
      else this.release(slot);
    }
  }

  /** Owning shutdown boundary; also used by deterministic pool lifetime tests. */
  async dispose(): Promise<void> {
    this.closed = true;
    for (const waiter of this.queue.splice(0)) {
      waiter.cleanup();
      waiter.reject(workerError());
    }
    await Promise.all([...this.workers].map(slot => this.retire(slot)));
  }

  private acquire(signal: AbortSignal): Promise<Slot> {
    if (signal.aborted) return Promise.reject(abortError());
    if (this.closed) return Promise.reject(workerError());
    const slot = this.idle.shift();
    if (slot) {
      clearTimeout(slot.idleTimer);
      slot.worker.ref();
      return Promise.resolve(slot);
    }
    if (this.workers.size < this.capacity) {
      try { return Promise.resolve(this.createSlot()); }
      catch { return Promise.reject(workerError()); }
    }
    if (this.queue.length >= this.queueLimit) {
      return Promise.reject(Object.assign(new Error("Program execution capacity is full. Try again after an active program finishes."), {
        code: "E_PROGRAM_CAPACITY",
      }));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        waiter.cleanup();
        reject(abortError());
      };
      const waiter: Waiter = { resolve, reject, cleanup: () => signal.removeEventListener("abort", onAbort) };
      this.queue.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private createSlot(): Slot {
    const worker = new Worker(BOOTSTRAP, {
      eval: true,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
      // Synchronous CJS transforms run only in this Worker. Disabling esbuild's
      // helper thread makes cache misses use spawnSync, which reaps its compiler
      // before returning. A terminated async loader otherwise leaves zombies.
      env: { ...process.env, ESBUILD_WORKER_THREADS: "0" },
      workerData: {
        tsxApiPath: require.resolve("tsx/cjs"),
        moduleUrl: new URL("./run-program-worker.ts", import.meta.url).href,
      },
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => {});
    const slot: Slot = { worker, ready, retired: false };
    this.workers.add(slot);
    const onReady = (message: ProgramWorkerMessage) => {
      if (message?.type === "ready") {
        worker.removeListener("message", onReady);
        resolveReady();
      } else if (message?.type === "bootstrap_error") {
        rejectReady(workerError());
        void this.retire(slot);
      }
    };
    worker.on("message", onReady);
    worker.on("error", () => { rejectReady(workerError()); void this.retire(slot); });
    worker.once("exit", () => {
      rejectReady(workerError());
      slot.retired = true;
      clearTimeout(slot.idleTimer);
      this.workers.delete(slot);
      const index = this.idle.indexOf(slot);
      if (index >= 0) this.idle.splice(index, 1);
      this.pump();
    });
    return slot;
  }

  private release(slot: Slot): void {
    if (slot.retired || this.closed) { void this.retire(slot); return; }
    const waiter = this.queue.shift();
    if (waiter) {
      waiter.cleanup();
      waiter.resolve(slot);
      return;
    }
    this.idle.push(slot);
    slot.worker.unref();
    slot.idleTimer = setTimeout(() => { void this.retire(slot); }, IDLE_WORKER_MS);
    slot.idleTimer.unref();
  }

  private async retire(slot: Slot): Promise<void> {
    slot.retired = true;
    clearTimeout(slot.idleTimer);
    const index = this.idle.indexOf(slot);
    if (index >= 0) this.idle.splice(index, 1);
    slot.termination ??= slot.worker.terminate();
    await slot.termination;
  }

  private pump(): void {
    while (!this.closed && this.queue.length && this.workers.size < this.capacity) {
      const waiter = this.queue.shift()!;
      waiter.cleanup();
      try { waiter.resolve(this.createSlot()); }
      catch { waiter.reject(workerError()); }
    }
  }
}

export const programWorkerPool = new ProgramWorkerPool();
