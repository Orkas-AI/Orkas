import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { promisify } from "node:util";
import { ProgramWorkerPool } from "../src/tools/run-program-worker-pool.js";
import { DEFAULT_RUN_PROGRAM_LIMITS } from "../src/tools/run-program.js";
import type { ProgramChildResult, ProgramVmResult } from "../src/tools/run-program-protocol.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Outcome = { value: ProgramVmResult } | { error: Error & { code?: string } };
type Invoke = (name: string, inputJson: string) => Promise<ProgramChildResult>;
const pools: ProgramWorkerPool[] = [];
const runFile = promisify(execFile);

function pool(capacity: number, queueLimit = 8): ProgramWorkerPool {
  const result = new ProgramWorkerPool(capacity, queueLimit);
  pools.push(result);
  return result;
}

function execute(
  runtime: ProgramWorkerPool,
  code: string,
  invoke: Invoke = async () => ({ ok: true, content: "unused" }),
  signal = new AbortController().signal,
  toolNames = ["gate"],
): Promise<Outcome> {
  return runtime.execute({
    code, invoke, signal, toolNames,
    limits: DEFAULT_RUN_PROGRAM_LIMITS,
    deadline: Date.now() + 30_000,
  }).then(value => ({ value }), error => ({ error }));
}

function heldTask(
  runtime: ProgramWorkerPool,
  id: string,
  starts: string[],
  signal?: AbortSignal,
) {
  const started = deferred<void>();
  const finish = deferred<ProgramChildResult>();
  const result = execute(runtime, "text((await tools.gate({})).content);", async () => {
    starts.push(id);
    started.resolve();
    return finish.promise;
  }, signal);
  return { started: started.promise, finish, result };
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map(runtime => runtime.dispose()));
});

describe("program Worker admission and ownership", () => {
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "reaps cold-transpiler children when cancelling active and still-starting Workers",
    async () => {
      // A dedicated process gives this lifecycle oracle an owned descendant
      // tree. Disabling the cache represents first use after an app update;
      // warm-cache tests otherwise miss unreaped compiler children. POSIX ps
      // supplies lifecycle state without reading command arguments or content.
      const directory = await mkdtemp(join(tmpdir(), "orkas-program-worker-reap-"));
      const fixture = join(directory, "lifecycle.mjs");
      const poolUrl = new URL("../src/tools/run-program-worker-pool.ts", import.meta.url).href;
      const toolUrl = new URL("../src/tools/run-program.ts", import.meta.url).href;
      const source = `
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProgramWorkerPool } from ${JSON.stringify(poolUrl)};
import { DEFAULT_RUN_PROGRAM_LIMITS } from ${JSON.stringify(toolUrl)};

function snapshot(phase) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,comm='], { encoding: 'utf8' })
    .split('\\n').flatMap(line => {
      const match = /^\\s*(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(.*)$/.exec(line);
      return match ? [{ pid: +match[1], ppid: +match[2], state: match[3], name: basename(match[4]) }] : [];
    });
  const ids = new Set([process.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) {
      ids.add(row.pid);
      changed = true;
    }
  }
  const owned = rows.filter(row => row.pid !== process.pid && ids.has(row.pid) && row.name !== 'ps');
  return { phase, descendants: owned.length, zombies: owned.filter(row => row.state.includes('Z')).length };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const runtime = new ProgramWorkerPool(2);
const snapshots = [snapshot('baseline')];
let aborted = 0;
async function cancelPair(waitUntilStarted, abortAfterMs) {
  const owners = Array.from({ length: 2 }, () => {
    const ready = deferred();
    const controller = new AbortController();
    const result = runtime.execute({
      code: 'await tools.ready({});', toolNames: ['ready'],
      signal: controller.signal, limits: DEFAULT_RUN_PROGRAM_LIMITS,
      deadline: Date.now() + 20000,
      invoke: async () => { ready.resolve(); return new Promise(() => {}); },
    }).then(value => ({ value }), error => ({ error }));
    return { ready, controller, result };
  });
  if (waitUntilStarted) await Promise.all(owners.map(owner => owner.ready.promise));
  else await delay(abortAfterMs);
  owners.forEach(owner => owner.controller.abort());
  for (const outcome of await Promise.all(owners.map(owner => owner.result))) {
    if (outcome.error?.code !== 'E_PROGRAM_ABORTED') throw new Error('Cancellation did not settle its owner.');
    aborted++;
  }
  await delay(50);
}
try {
  for (let index = 0; index < 2; index++) {
    await cancelPair(true, 0);
    snapshots.push(snapshot('active-cancel-' + index));
  }
  for (const milliseconds of [0, 10, 30]) {
    await cancelPair(false, milliseconds);
    snapshots.push(snapshot('startup-cancel-' + milliseconds));
  }
  const recovery = await runtime.execute({
    code: 'text(42);', toolNames: [], signal: new AbortController().signal,
    limits: DEFAULT_RUN_PROGRAM_LIMITS, deadline: Date.now() + 20000,
    invoke: async () => { throw new Error('Recovery must not call a tool.'); },
  });
  await runtime.dispose();
  await delay(50);
  snapshots.push(snapshot('disposed'));
  process.stdout.write(JSON.stringify({ aborted, recovery, snapshots }));
} finally {
  await runtime.dispose();
}
`;
      try {
        await writeFile(fixture, source);
        const { stdout, stderr } = await runFile(process.execPath, [
          "--import", createRequire(import.meta.url).resolve("tsx"), fixture,
        ], {
          cwd: directory,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", TSX_DISABLE_CACHE: "1" },
          timeout: 20_000,
          maxBuffer: 256 * 1024,
          windowsHide: true,
        });
        // Electron can emit this exact native diagnostic when our deliberate
        // startup cancellation lands inside node_init. Cancellation outcomes,
        // recovery and process reclamation below must still pass; other stderr
        // remains a failure instead of being discarded as termination noise.
        const diagnosticLines = stderr.split(/\r?\n/).filter(Boolean);
        const expectedStartupCancellation = /^\[\d{4}\/\d{6}\.\d+:ERROR:electron\/shell\/common\/node_util\.cc:\d+\] CompileAndCall failed to evaluate electron script \(electron\/js2c\/node_init\): script execution has been terminated$/;
        expect(diagnosticLines.filter(line => !expectedStartupCancellation.test(line))).toEqual([]);
        expect(diagnosticLines.length).toBeLessThanOrEqual(6);
        if (diagnosticLines.length) {
          console.info(`Expected Electron startup-cancellation diagnostics: ${diagnosticLines.length}`);
        }
        const result = JSON.parse(stdout) as {
          aborted: number;
          recovery: ProgramVmResult;
          snapshots: Array<{ phase: string; descendants: number; zombies: number }>;
        };
        expect(result.aborted).toBe(10);
        expect(result.recovery).toEqual({ status: "completed", output: "42" });
        expect(result.snapshots.map(sample => sample.phase)).toEqual([
          "baseline", "active-cancel-0", "active-cancel-1",
          "startup-cancel-0", "startup-cancel-10", "startup-cancel-30", "disposed",
        ]);
        const baseline = result.snapshots[0];
        for (const sample of result.snapshots.slice(1)) {
          expect(sample.zombies, sample.phase).toBe(baseline.zombies);
          expect(sample.descendants, sample.phase).toBeLessThanOrEqual(baseline.descendants);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("uses at most the admitted slots and serves queued programs in FIFO order while a sibling stays active", async () => {
    const runtime = pool(2);
    const starts: string[] = [];
    const a = heldTask(runtime, "a", starts);
    const b = heldTask(runtime, "b", starts);
    await Promise.all([a.started, b.started]);
    const c = heldTask(runtime, "c", starts);
    const d = heldTask(runtime, "d", starts);
    await nextEventLoopTurn();
    expect(starts).toHaveLength(2);
    expect(new Set(starts)).toEqual(new Set(["a", "b"]));

    b.finish.resolve({ ok: true, content: "b" });
    await c.started;
    expect(starts.slice(2)).toEqual(["c"]);
    c.finish.resolve({ ok: true, content: "c" });
    await d.started;
    expect(starts.slice(2)).toEqual(["c", "d"]);
    d.finish.resolve({ ok: true, content: "d" });
    a.finish.resolve({ ok: true, content: "a" });

    expect(await Promise.all([a.result, b.result, c.result, d.result])).toEqual(
      ["a", "b", "c", "d"].map(output => ({ value: { status: "completed", output } })),
    );
  });

  it("rejects a full queue without starting a child operation and preserves already admitted work", async () => {
    const runtime = pool(1, 1);
    const starts: string[] = [];
    const a = heldTask(runtime, "active", starts);
    await a.started;
    const b = heldTask(runtime, "queued", starts);
    const rejected = heldTask(runtime, "overflow", starts);
    expect(await rejected.result).toMatchObject({ error: { code: "E_PROGRAM_CAPACITY" } });
    expect(starts).toEqual(["active"]);

    a.finish.resolve({ ok: true, content: "active" });
    await b.started;
    b.finish.resolve({ ok: true, content: "queued" });
    expect(await a.result).toEqual({ value: { status: "completed", output: "active" } });
    expect(await b.result).toEqual({ value: { status: "completed", output: "queued" } });
    expect(starts).toEqual(["active", "queued"]);
  });

  it("removes a cancelled waiter without freeing another program's slot or executing the cancelled child", async () => {
    const runtime = pool(1, 2);
    const starts: string[] = [];
    const active = heldTask(runtime, "active", starts);
    await active.started;
    const abort = new AbortController();
    const cancelled = heldTask(runtime, "cancelled", starts, abort.signal);
    const first = heldTask(runtime, "first", starts);
    abort.abort();
    expect(await cancelled.result).toMatchObject({ error: { code: "E_PROGRAM_ABORTED" } });
    // Cancellation makes room in the queue, not in the currently occupied slot.
    const second = heldTask(runtime, "second", starts);
    await nextEventLoopTurn();
    expect(starts).toEqual(["active"]);

    active.finish.resolve({ ok: true, content: "active" });
    await first.started;
    expect(starts).toEqual(["active", "first"]);
    first.finish.resolve({ ok: true, content: "first" });
    await second.started;
    second.finish.resolve({ ok: true, content: "second" });
    expect(await Promise.all([active.result, first.result, second.result])).toEqual(
      ["active", "first", "second"].map(output => ({ value: { status: "completed", output } })),
    );
    expect(starts).toEqual(["active", "first", "second"]);
  });

  it("replaces only the cancelled owner's Worker and ignores its late result after a new owner starts", async () => {
    const runtime = pool(2);
    const starts: string[] = [];
    const abort = new AbortController();
    const old = heldTask(runtime, "old", starts, abort.signal);
    const sibling = heldTask(runtime, "sibling", starts);
    await Promise.all([old.started, sibling.started]);
    const replacement = heldTask(runtime, "replacement", starts);
    abort.abort();
    expect(await old.result).toMatchObject({ error: { code: "E_PROGRAM_ABORTED" } });
    await replacement.started;
    old.finish.resolve({ ok: true, content: "stale-owner-result" });
    await nextEventLoopTurn();
    replacement.finish.resolve({ ok: true, content: "replacement-result" });
    sibling.finish.resolve({ ok: true, content: "sibling-result" });

    expect(await replacement.result).toEqual({ value: { status: "completed", output: "replacement-result" } });
    expect(await sibling.result).toEqual({ value: { status: "completed", output: "sibling-result" } });
    expect(starts.filter(id => id === "old")).toHaveLength(1);
    expect(starts.filter(id => id === "replacement")).toHaveLength(1);
    expect(await execute(runtime, "text('subsequent-result');")).toEqual({
      value: { status: "completed", output: "subsequent-result" },
    });
  });

  it("starts a fresh guest global, prototype and tool surface when reusing the sole Worker", async () => {
    const runtime = pool(1);
    expect(await execute(runtime, `
globalThis.previousOwner = 'private';
Array.prototype.previousOwner = 'private';
text('first-owner');
`)).toEqual({ value: { status: "completed", output: "first-owner" } });

    const result = await execute(runtime, `json({
  global: typeof globalThis.previousOwner,
  prototype: typeof [].previousOwner,
  host: typeof process,
  tools: Object.keys(tools)
});`, undefined, undefined, ["different_tool"]);
    expect(result).toEqual({ value: {
      status: "completed",
      output: JSON.stringify({ global: "undefined", prototype: "undefined", host: "undefined", tools: ["different_tool"] }),
    } });
  });

  it("recovers queued and future work after an unexpected Worker exit without replaying its active child", async () => {
    const runtime = pool(1);
    const starts: string[] = [];
    const interrupted = heldTask(runtime, "interrupted", starts);
    await interrupted.started;
    const queued = heldTask(runtime, "queued", starts);

    // Inject a process-lifecycle fault into the actual active Worker. Private
    // access selects the fault target only; outcomes below are public results
    // and host side effects, not assertions about the pool's implementation.
    const slots = (runtime as unknown as {
      workers: Set<{ worker: { terminate(): Promise<number> } }>;
    }).workers;
    const target = [...slots][0];
    await target.worker.terminate();

    expect(await interrupted.result).toMatchObject({ error: { code: "E_PROGRAM_RUNTIME" } });
    await queued.started;
    interrupted.finish.resolve({ ok: true, content: "late-interrupted-result" });
    await nextEventLoopTurn();
    queued.finish.resolve({ ok: true, content: "queued-result" });
    expect(await queued.result).toEqual({ value: { status: "completed", output: "queued-result" } });
    expect(await execute(runtime, "text('future-result');")).toEqual({
      value: { status: "completed", output: "future-result" },
    });
    expect(starts).toEqual(["interrupted", "queued"]);
  });

  it("settles active and queued owners on disposal and rejects later work without child calls", async () => {
    const runtime = pool(1);
    const starts: string[] = [];
    const active = heldTask(runtime, "active", starts);
    await active.started;
    const queued = heldTask(runtime, "queued", starts);
    await runtime.dispose();
    expect(await active.result).toMatchObject({ error: { code: "E_PROGRAM_RUNTIME" } });
    expect(await queued.result).toMatchObject({ error: { code: "E_PROGRAM_RUNTIME" } });
    const after = heldTask(runtime, "after-dispose", starts);
    expect(await after.result).toMatchObject({ error: { code: "E_PROGRAM_RUNTIME" } });
    active.finish.resolve({ ok: true, content: "late-after-dispose" });
    await runtime.dispose();
    expect(starts).toEqual(["active"]);
  });

  it.each(["synchronous", "asynchronous"])("contains a %s host-call failure and lets the caller recover without replay", async (kind) => {
    const runtime = pool(1);
    let calls = 0;
    const invoke: Invoke = () => {
      calls++;
      if (kind === "synchronous") throw new Error("controlled child failure");
      return Promise.reject(new Error("controlled child failure"));
    };
    expect(await execute(runtime, `
try { await tools.gate({}); }
catch (error) { text(error.message); }
`, invoke)).toEqual({ value: { status: "completed", output: "controlled child failure" } });
    expect(calls).toBe(1);
    expect(await execute(runtime, "text('recovered');")).toEqual({ value: { status: "completed", output: "recovered" } });
  });
});
