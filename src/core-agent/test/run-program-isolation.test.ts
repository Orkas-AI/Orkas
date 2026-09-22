import { describe, expect, it } from "vitest";

import {
  createRunProgramTool,
  DEFAULT_RUN_PROGRAM_LIMITS,
  type ProgrammaticToolInvokeOutcome,
} from "../src/tools/run-program.js";
import type { ToolContext } from "../src/tools/base.js";
import { MAX_PROGRAM_WORKERS } from "../src/tools/run-program-worker-pool.js";
import { executeProgramVm } from "../src/tools/run-program-vm.js";

const context = (signal?: AbortSignal): ToolContext => ({
  workingDir: "/tmp/orkas-run-program-isolation",
  state: {},
  ...(signal ? { signal } : {}),
});

const completed = (): ProgrammaticToolInvokeOutcome => ({
  status: "completed",
  result: { content: "ready" },
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("run_program host responsiveness", () => {
  it.each([false, true])("classifies bootstrap interruption without executing child tools (cancelled=%s)", async (cancelled) => {
    const cancellation = new SharedArrayBuffer(4);
    if (cancelled) Atomics.store(new Int32Array(cancellation), 0, 1);
    let calls = 0;
    const result = await executeProgramVm({
      executionId: 1, code: "await tools.write({});", toolNames: ["write"],
      limits: { ...DEFAULT_RUN_PROGRAM_LIMITS }, deadline: 0, cancellation,
    }, async () => { calls++; return { ok: true, content: "written" }; });
    expect(result).toMatchObject({ status: "failed", code: cancelled ? "E_PROGRAM_ABORTED" : "E_PROGRAM_TIMEOUT" });
    expect(calls).toBe(0);
    const recovered = await executeProgramVm({
      executionId: 2, code: "text('ready');", toolNames: [],
      limits: { ...DEFAULT_RUN_PROGRAM_LIMITS }, deadline: Date.now() + 5_000,
      cancellation: new SharedArrayBuffer(4),
    }, async () => { throw new Error("No child tool expected"); });
    expect(recovered).toEqual({ status: "completed", output: "ready" });
  });

  it("includes waiting for VM capacity in the original deadline without dispatching expired work", async () => {
    const ready = Array.from({ length: MAX_PROGRAM_WORKERS }, gate);
    const controllers = ready.map(() => new AbortController());
    const holder = createRunProgramTool({
      listToolNames: () => ["hold"],
      invokeTool: async (_name, input, ctx) => new Promise((resolve) => {
        ctx.signal?.addEventListener("abort", () => resolve({ status: "aborted", code: "E_PROGRAM_ABORTED", reason: "cancelled" }), { once: true });
        ready[Number(input.id)].resolve();
      }),
      limits: { maxWallMs: 10_000 },
    });
    const active = ready.map((_, id) => holder.execute({ code: `await tools.hold({id: ${id}});` }, context(controllers[id].signal)));
    let expiredCalls = 0;
    const queued = createRunProgramTool({
      listToolNames: () => ["write"],
      invokeTool: async () => { expiredCalls++; return completed(); },
      limits: { maxWallMs: 40 },
    });
    try {
      await Promise.all(ready.map((item, id) => Promise.race([
        item.promise,
        active[id].then(() => { throw new Error("Holder ended before acquiring capacity."); }),
      ])));
      const expired = await queued.execute({ code: "await tools.write();" }, context());
      expect(JSON.parse(expired.content)).toMatchObject({ reason: "E_PROGRAM_TIMEOUT", attempted_calls: 0 });
      expect(expiredCalls).toBe(0);
      expect(controllers.every(controller => !controller.signal.aborted)).toBe(true);
    } finally {
      controllers.forEach(controller => controller.abort());
      await Promise.allSettled(active);
    }
    const later = await holder.execute({ code: "text('capacity recovered');" }, context());
    expect(later.isError).not.toBe(true);
    expect(later.content).toContain("capacity recovered");
    expect(expiredCalls).toBe(0);
  });

  it("keeps host timers running during CPU work after the VM has initialized", async () => {
    const heartbeats: number[] = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    let computation: { startedAt: number; endedAt: number } | undefined;
    const runProgram = createRunProgramTool({
      listToolNames: () => ["ready", "finished"],
      invokeTool: async (name, input) => {
        if (name === "ready") timer = setInterval(() => heartbeats.push(Date.now()), 20);
        else if (name === "finished") {
          computation = { startedAt: Number(input.startedAt), endedAt: Number(input.endedAt) };
        }
        return completed();
      },
      limits: { maxSyncSliceMs: 3_000, maxWallMs: 10_000 },
    });

    try {
      const result = await runProgram.execute({
        code: `await tools.ready();
const startedAt = Date.now();
while (Date.now() - startedAt < 500) {}
const endedAt = Date.now();
await tools.finished({ startedAt, endedAt });
text("calculation completed");`,
      }, context());

      expect(result.isError).not.toBe(true);
      expect(result.content).toContain("calculation completed");
      expect(computation).toBeDefined();
      // VM initialization and IPC before/after calculation cannot satisfy this
      // oracle: a host timer must run inside the actual synchronous CPU window.
      expect(heartbeats.some((at) => (
        at >= computation!.startedAt && at < computation!.endedAt
      ))).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });

  it("cancels CPU work promptly without cancelling another program or breaking later execution", async () => {
    const controller = new AbortController();
    const busyReady = gate();
    const startComputation = gate();
    const releasePeer = gate();
    let cancellation: ReturnType<typeof setTimeout> | undefined;
    let cancellationRequestedAt = Number.POSITIVE_INFINITY;
    let busyCompletedAt = Number.POSITIVE_INFINITY;
    const runProgram = createRunProgramTool({
      listToolNames: () => ["busy_ready", "peer_ready"],
      invokeTool: async (name) => {
        if (name === "busy_ready") {
          busyReady.resolve();
          await startComputation.promise;
        } else if (name === "peer_ready") {
          await releasePeer.promise;
        }
        return completed();
      },
      limits: { maxSyncSliceMs: 3_000, maxWallMs: 10_000 },
    });
    const busy = runProgram.execute({
      code: "await tools.busy_ready(); while (true) {}",
    }, context(controller.signal)).then((result) => {
      busyCompletedAt = Date.now();
      return result;
    });
    const peer = runProgram.execute({
      code: "await tools.peer_ready(); text('independent program completed');",
    }, context());

    try {
      // CPU initialization cannot satisfy the cancellation check. The other
      // submitted program must survive whether it is already active or still
      // waiting for execution capacity on a machine with one available worker.
      await Promise.race([
        busyReady.promise,
        busy.then(() => { throw new Error("Busy program ended before its ready handshake."); }),
      ]);
      cancellation = setTimeout(() => {
        cancellationRequestedAt = Date.now();
        controller.abort();
        releasePeer.resolve();
      }, 20);
      startComputation.resolve();
      const [cancelled, independent] = await Promise.all([busy, peer]);

      expect(cancelled.isError).toBe(true);
      expect(JSON.parse(cancelled.content).reason).toBe("E_PROGRAM_ABORTED");
      expect(Number.isFinite(cancellationRequestedAt)).toBe(true);
      expect(busyCompletedAt).toBeGreaterThanOrEqual(cancellationRequestedAt);
      // A full CPU slice takes three seconds; this loose bound distinguishes
      // responsive cancellation without requiring a sub-frame timer deadline.
      expect(busyCompletedAt - cancellationRequestedAt).toBeLessThan(1_000);
      expect(independent.isError).not.toBe(true);
      expect(independent.content).toContain("independent program completed");

      const subsequent = await runProgram.execute({
        code: "json([1, 2, 3].map((value) => value * value));",
      }, context());
      expect(subsequent.isError).not.toBe(true);
      expect(subsequent.content).toContain("[1,4,9]");
    } finally {
      clearTimeout(cancellation);
      controller.abort();
      startComputation.resolve();
      releasePeer.resolve();
      await Promise.allSettled([busy, peer]);
    }
  });

  it("does not starve host timers across CPU segments and immediately resolved child calls", async () => {
    const heartbeats: number[] = [];
    const seenSegments: number[] = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    let computation: { startedAt: number; endedAt: number } | undefined;
    const runProgram = createRunProgramTool({
      listToolNames: () => ["ready", "instant", "finished"],
      invokeTool: async (name, input) => {
        if (name === "ready") timer = setInterval(() => heartbeats.push(Date.now()), 20);
        else if (name === "instant") seenSegments.push(Number(input.segment));
        else if (name === "finished") {
          computation = { startedAt: Number(input.startedAt), endedAt: Number(input.endedAt) };
        }
        return completed();
      },
      limits: { maxSyncSliceMs: 3_000, maxWallMs: 10_000 },
    });

    try {
      const result = await runProgram.execute({
        code: `await tools.ready();
const startedAt = Date.now();
for (let segment = 0; segment < 6; segment++) {
  const end = Date.now() + 100;
  while (Date.now() < end) {}
  await tools.instant({ segment });
}
const endedAt = Date.now();
await tools.finished({ startedAt, endedAt });
text("all segments completed");`,
      }, context());

      expect(result.isError).not.toBe(true);
      expect(result.content).toContain("all segments completed");
      expect(seenSegments).toEqual([0, 1, 2, 3, 4, 5]);
      expect(computation).toBeDefined();
      // Awaiting a resolved promise only yields to microtasks. That must not
      // monopolize the host event loop over the whole multi-call program.
      expect(heartbeats.some((at) => (
        at >= computation!.startedAt && at < computation!.endedAt
      ))).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });
});
