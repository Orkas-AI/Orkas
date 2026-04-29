import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { SandboxExecutor, augmentPath } from "../src/sandbox/executor.js";

describe("SandboxExecutor", () => {
  it("executes a simple command", async () => {
    const sandbox = new SandboxExecutor({ workingDir: os.tmpdir() });
    const result = await sandbox.execute("echo hello");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr", async () => {
    const sandbox = new SandboxExecutor({ workingDir: os.tmpdir() });
    const result = await sandbox.execute("echo error >&2");
    expect(result.stderr.trim()).toBe("error");
  });

  it("returns non-zero exit code for failing commands", async () => {
    const sandbox = new SandboxExecutor({ workingDir: os.tmpdir() });
    const result = await sandbox.execute("exit 42");
    expect(result.exitCode).toBe(42);
  });

  it("enforces timeout", async () => {
    const sandbox = new SandboxExecutor({
      workingDir: os.tmpdir(),
      timeoutMs: 500,
    });
    const result = await sandbox.execute("sleep 10");
    expect(result.timedOut).toBe(true);
  }, 10000);

  it("blocks dangerous commands", async () => {
    const sandbox = new SandboxExecutor({ workingDir: os.tmpdir() });
    const result = await sandbox.execute("rm -rf /");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("blocked");
  });

  it("blocks custom commands", async () => {
    const sandbox = new SandboxExecutor({
      workingDir: os.tmpdir(),
      blockedCommands: ["curl"],
    });
    const result = await sandbox.execute("curl http://example.com");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("blocked");
  });

  it("enforces output size limit", async () => {
    const sandbox = new SandboxExecutor({
      workingDir: os.tmpdir(),
      maxOutputBytes: 100,
    });
    // Generate more than 100 bytes of output
    const result = await sandbox.execute("seq 1 1000");
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.stdout).toContain("[output truncated by sandbox]");
  });

  it("uses correct working directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-test-"));
    await fs.writeFile(path.join(tmpDir, "marker.txt"), "found");

    const sandbox = new SandboxExecutor({ workingDir: tmpDir });
    const result = await sandbox.execute("cat marker.txt");
    expect(result.stdout.trim()).toBe("found");

    await fs.rm(tmpDir, { recursive: true });
  });

  it("passes custom environment variables", async () => {
    const sandbox = new SandboxExecutor({
      workingDir: os.tmpdir(),
      env: { MY_VAR: "test_value" },
    });
    const result = await sandbox.execute("echo $MY_VAR");
    expect(result.stdout.trim()).toBe("test_value");
  });

  it("reports duration", async () => {
    const sandbox = new SandboxExecutor({ workingDir: os.tmpdir() });
    const result = await sandbox.execute("echo fast");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000);
  });
});

describe("augmentPath", () => {
  it("prepends /opt/homebrew/bin when it's missing (Apple Silicon case)", () => {
    const out = augmentPath("/usr/bin:/bin");
    expect(out.split(":")).toContain("/opt/homebrew/bin");
    expect(out.indexOf("/opt/homebrew/bin")).toBeLessThan(out.indexOf("/usr/bin"));
  });

  it("does not duplicate entries that are already present", () => {
    const input = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    const out = augmentPath(input);
    const homebrewCount = out.split(":").filter((p) => p === "/opt/homebrew/bin").length;
    expect(homebrewCount).toBe(1);
  });

  it("preserves user-supplied entries verbatim", () => {
    const input = "/Users/me/bin:/usr/bin";
    const out = augmentPath(input);
    expect(out.split(":")).toContain("/Users/me/bin");
    expect(out.split(":")).toContain("/usr/bin");
  });

  it("falls back to canonical list when input is empty/undefined", () => {
    const out = augmentPath(undefined);
    expect(out.split(":")).toContain("/opt/homebrew/bin");
    expect(out.split(":")).toContain("/usr/local/bin");
    expect(out.split(":")).toContain("/usr/bin");
  });

  it("keeps user-supplied entries BEFORE canonical ones when the user put them first", () => {
    // /Users/me/tools/bin is user-custom; it must remain ahead of the
    // canonical /usr/bin entry that already existed in the input.
    const input = "/Users/me/tools/bin:/usr/bin";
    const out = augmentPath(input).split(":");
    expect(out.indexOf("/Users/me/tools/bin")).toBeLessThan(out.indexOf("/usr/bin"));
  });
});
