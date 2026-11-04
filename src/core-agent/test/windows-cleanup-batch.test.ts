import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { killProcessTree } from "../src/sandbox/executor.js";

const helpers: ReturnType<typeof fixture>[] = [];
function fixture(pid = 1234) {
  return Object.assign(new EventEmitter(), {
    pid, exitCode: null as number | null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true), unref: vi.fn(),
  });
}
function setup() {
  const spawnFn = vi.fn(() => { const helper = fixture(); helpers.push(helper); return helper; });
  const add = (pid: number) => {
    const child = fixture(pid), done = vi.fn(), terminated = vi.fn();
    killProcessTree(child as any, "SIGTERM", { platform: "win32", spawnFn: spawnFn as any,
      onComplete: done, onRootTerminated: terminated });
    return { child, done, terminated };
  };
  return { spawnFn, add };
}
afterEach(() => {
  for (const helper of helpers.splice(0)) helper.emit("close", 0);
  vi.useRealTimers(); vi.restoreAllMocks();
});

it("delivers the cleanup receipt to a standalone caller after helper pipes close", () => {
  const helper = `process.stdout.write('accepting\\n');
    process.stdin.once('data', () => {
      process.stdout.write('ready:0\\n');
      process.stdin.once('data', () => {
        process.stdin.destroy();
        process.stdout.end('done:0:1\\n');
        setTimeout(() => process.exit(0), 200);
      });
    });`;
  const module = pathToFileURL(path.resolve("src/core-agent/src/sandbox/windows-cleanup-batch.ts")).href;
  const parent = `import { spawn } from 'node:child_process';
    import { queueWindowsTreeCleanup } from ${JSON.stringify(module)};
    await new Promise((resolve, reject) => queueWindowsTreeCleanup({pid: 1234}, 5000,
      () => spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], {stdio:['pipe','pipe','ignore']}),
      (failed, terminated) => failed || !terminated ? reject(new Error('missing cleanup receipt')) : resolve()));
    process.stdout.write('cleanup-complete\\n');`;
  const result = spawnSync(process.env.ORKAS_TEST_NODE || process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', parent], {
      encoding: 'utf8', timeout: 15_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  // Node 26 reports tsx's deprecated loader API. Retain that exact diagnostic
  // visibly; every other stderr byte still fails this standalone receipt check.
  const loaderNotice = '(node:PID) [DEP0205] DeprecationWarning: `module.register()` is deprecated. Use `module.registerHooks()` instead.\n'
    + '(Use `node --trace-deprecation ...` to show where the warning was created)\n';
  expect(['', loaderNotice]).toContain(result.stderr.replace(/\(node:\d+\)/g, '(node:PID)'));
  if (result.stderr) console.warn(result.stderr.trimEnd());
  expect(result.stdout).toBe('cleanup-complete\n');
});

it("shares startup across simultaneous cancellations and keeps root authorization separate", () => {
  const { spawnFn, add } = setup();
  const live = add(1234), exited = add(5678);
  expect(spawnFn).toHaveBeenCalledTimes(1);
  const helper = helpers.at(-1)!;
  const input = vi.spyOn(helper.stdin, "write");
  exited.child.exitCode = 7;
  helper.stdout.emit("data", Buffer.from("accepting\nready:0\nready:1\n"));
  expect(input.mock.calls.map(call => call[0])).toContain("go:0\n");
  expect(input.mock.calls.map(call => call[0])).toContain("cancel:1\n");
  helper.stdout.emit("data", Buffer.from("done:0:1\ndone:1:0\n"));
  expect(live.done).not.toHaveBeenCalled();
  helper.emit("close", 0);
  expect(live.terminated).toHaveBeenCalledTimes(1);
  expect(exited.terminated).not.toHaveBeenCalled();
  expect(live.done).toHaveBeenCalledTimes(1);
  expect(exited.done).toHaveBeenCalledTimes(1);
  expect(exited.child.kill).not.toHaveBeenCalled();
});

it("never renews an earlier deadline when another cancellation joins, and recovers after helper failure", async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { spawnFn, add } = setup();
  const first = add(1234);
  await vi.advanceTimersByTimeAsync(1000);
  const second = add(5678);
  await vi.advanceTimersByTimeAsync(4000);
  expect(first.done).toHaveBeenCalledTimes(1);
  expect(first.child.kill).toHaveBeenCalledTimes(1);
  expect(second.done).not.toHaveBeenCalled();
  const helper = helpers.at(-1)!;
  helper.stdout.emit("data", Buffer.from("accepting\nready:0\nready:1\n"));
  expect(helper.stdin.read().toString()).toContain("cancel:0\n");
  helper.emit("error", new Error("private helper failure"));
  expect(second.done).toHaveBeenCalledTimes(1);
  expect(second.child.kill).toHaveBeenCalledTimes(1);
  expect(first.terminated).not.toHaveBeenCalled();
  expect(second.terminated).not.toHaveBeenCalled();
  const recovered = add(9012);
  expect(spawnFn).toHaveBeenCalledTimes(2);
  const next = helpers.at(-1)!;
  next.stdout.emit("data", Buffer.from("accepting\nready:0\ndone:0:1\n"));
  next.emit("close", 0);
  expect(recovered.terminated).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(warning.mock.calls)).not.toContain("private helper failure");
});

it("does not admit a late cancellation to a sweep already in progress", () => {
  const { spawnFn, add } = setup();
  add(1234);
  const earlier = helpers.at(-1)!;
  earlier.stdout.emit("data", Buffer.from("accepting\nready:0\n"));
  const later = add(5678);
  expect(spawnFn).toHaveBeenCalledTimes(2);
  earlier.stdout.emit("data", Buffer.from("done:0:1\n"));
  earlier.emit("close", 0);
  helpers.at(-1)!.stdout.emit("data", Buffer.from("accepting\nready:0\ndone:0:1\n"));
  helpers.at(-1)!.emit("close", 0);
  expect(later.terminated).toHaveBeenCalledTimes(1);
});

it("reports one failed tree without misattributing or discarding a sibling's complete receipt", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { add } = setup();
  const failed = add(1234), succeeded = add(5678);
  const helper = helpers.at(-1)!;
  helper.stdout.emit("data", Buffer.from("accepting\nready:0\nready:1\nfailed:0\ndone:1:1\n"));
  helper.emit("close", 0);
  expect(failed.child.kill).toHaveBeenCalledTimes(1);
  expect(failed.terminated).not.toHaveBeenCalled();
  expect(succeeded.child.kill).not.toHaveBeenCalled();
  expect(succeeded.terminated).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledTimes(1);
});

it.each(["missing", "truncated", "oversized", "duplicate"])("rejects incomplete or invalid helper evidence: %s", outcome => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { add } = setup();
  const item = add(1234);
  const helper = helpers.at(-1)!;
  helper.stdout.emit("data", Buffer.from("accepting\nready:0\n"));
  if (outcome === "truncated") helper.stdout.emit("data", Buffer.from("done:0:1"));
  if (outcome === "oversized") helper.stdout.emit("data", Buffer.alloc(8193, 120));
  if (outcome === "duplicate") helper.stdout.emit("data", Buffer.from("done:0:1\ndone:0:1\n"));
  helper.emit("close", 0);
  expect(item.terminated).not.toHaveBeenCalled();
  expect(item.done).toHaveBeenCalledTimes(1);
  expect(item.child.kill).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledTimes(1);
});

it("bounds batch admission and reaps a silent helper when every independent deadline expires", async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { spawnFn, add } = setup();
  const items = Array.from({ length: 65 }, (_, index) => add(1000 + index));
  expect(spawnFn).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(4999);
  expect(items.every(item => item.done.mock.calls.length === 0)).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(items.every(item => item.done.mock.calls.length === 1 && item.child.kill.mock.calls.length === 1)).toBe(true);
  expect(helpers.every(helper => helper.kill.mock.calls.length === 1)).toBe(true);
  expect(warning).toHaveBeenCalledTimes(65);
});

it("still reaps a helper that reports failure but never closes", async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { add } = setup();
  const item = add(1234);
  const helper = helpers.at(-1)!;
  helper.stdout.emit("data", Buffer.from("accepting\nfailed:0\n"));
  await vi.advanceTimersByTimeAsync(5000);
  expect(item.done).toHaveBeenCalledTimes(1);
  expect(helper.kill).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledTimes(1);
});

it("rejects success arriving after the deadline even before the due timer is dispatched", () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { add } = setup();
  const item = add(1234);
  const helper = helpers.at(-1)!;
  helper.stdout.emit("data", Buffer.from("accepting\nready:0\n"));
  vi.setSystemTime(Date.now() + 5001);
  helper.stdout.emit("data", Buffer.from("done:0:1\n"));
  helper.emit("close", 0);
  expect(item.terminated).not.toHaveBeenCalled();
  expect(item.done).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledTimes(1);
});

it("seals wedged startup at its first expired request instead of renewing helper lifetime", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { add, spawnFn } = setup();
  add(1234);
  const first = helpers.at(-1)!;
  await vi.advanceTimersByTimeAsync(1000);
  const joined = add(5678);
  await vi.advanceTimersByTimeAsync(4000);
  const later = add(9012);
  const second = helpers.at(-1)!;
  expect(spawnFn).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(joined.done).toHaveBeenCalledTimes(1);
  expect(first.kill).toHaveBeenCalledTimes(1);
  expect(later.done).not.toHaveBeenCalled();
  second.stdout.emit("data", Buffer.from("accepting\nready:0\ndone:0:1\n"));
  second.emit("close", 0);
  expect(later.terminated).toHaveBeenCalledTimes(1);
});
