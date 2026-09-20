import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killProcessTree, SandboxExecutor } from "../src/sandbox/executor.js";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

function childFixture() {
  return Object.assign(new EventEmitter(), {
    pid: 1234, exitCode: null as number | null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true), unref: vi.fn(),
  });
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(spawn).mockReset(); });

describe("Windows shell cleanup", () => {
  it("accepts natural exit before the helper acquires a handle without a false fallback warning", () => {
    const child = childFixture();
    const killer = childFixture();
    vi.mocked(spawn).mockReturnValue(killer as any);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onComplete = vi.fn();
    killProcessTree(child as any, "SIGKILL", { platform: "win32", onComplete });
    child.exitCode = 0;
    killer.emit("exit", 1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
  });

  it.each([false, true])("authorizes only the pinned original child (exited while helper starts: %s)", (exited) => {
    const child = childFixture();
    const killer = childFixture();
    vi.mocked(spawn).mockReturnValue(killer as any);
    const input = vi.spyOn(killer.stdin, "end");
    killProcessTree(child as any, "SIGKILL", { platform: "win32" });
    if (exited) child.exitCode = 0;
    killer.stdout.emit("data", Buffer.from("rea"));
    expect(input).not.toHaveBeenCalled();
    killer.stdout.emit("data", Buffer.from("dy\r\n"));
    expect(input).toHaveBeenCalledExactlyOnceWith(exited ? "cancel\n" : "go\n");
    killer.stdout.emit("data", Buffer.from("ready\n"));
    expect(input).toHaveBeenCalledTimes(1);
  });

  it("does not target a recycled PID after the owned shell has exited", () => {
    const child = childFixture();
    child.exitCode = 1;
    killProcessTree(child as any, "SIGKILL", { platform: "win32" });
    expect(spawn).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("bounds a failed tree command and reports its direct-child-only fallback once", () => {
    const child = childFixture();
    const killer = childFixture();
    vi.mocked(spawn).mockReturnValue(killer as any);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onComplete = vi.fn();
    killProcessTree(child as any, "SIGTERM", { platform: "win32", onComplete });
    expect(onComplete).not.toHaveBeenCalled();
    killer.emit("error", new Error("private path must not be logged"));
    killer.emit("exit", 1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("[sandbox]", "Shell process tree termination failed", {
      platform: "win32", fallback: "direct_child_only",
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private path");
    expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array),
      expect.objectContaining({ timeout: 5_000, windowsHide: true }));
  });

  it.runIf(process.platform === "win32")("waits for tree cleanup after shell close before returning the timeout result", async () => {
    vi.useFakeTimers();
    const child = childFixture();
    const killer = childFixture();
    vi.mocked(spawn).mockReturnValueOnce(child as any).mockReturnValueOnce(killer as any);
    const done = vi.fn();
    const execution = new SandboxExecutor({ workingDir: process.cwd(), timeoutMs: 100 })
      .execute("fixture").then((result) => { done(); return result; });
    await vi.advanceTimersByTimeAsync(100);
    child.exitCode = 1;
    child.emit("close", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).not.toHaveBeenCalled();
    killer.emit("exit", 0);
    await expect(execution).resolves.toMatchObject({ timedOut: true, exitCode: 1 });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.runIf(process.platform === "win32")("reports unconfirmed cleanup without hanging or treating helper success as pipe closure", async () => {
    vi.useFakeTimers();
    const child = childFixture();
    const killer = childFixture();
    vi.mocked(spawn).mockReturnValueOnce(child as any).mockReturnValueOnce(killer as any);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const execution = new SandboxExecutor({ workingDir: process.cwd(), timeoutMs: 100 }).execute("fixture");
    await vi.advanceTimersByTimeAsync(100);
    child.exitCode = 1; // A surviving descendant still owns an inherited output pipe.
    killer.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(execution).resolves.toMatchObject({ timedOut: true });
    expect(warning).toHaveBeenCalledWith("[sandbox]", "Shell process cleanup was not confirmed", {
      platform: "win32", phase: "cleanup_deadline",
    });
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
