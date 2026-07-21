import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  SandboxExecutor,
  augmentPath,
  buildSandboxEnv,
  buildShellInvocation,
  decodeProcessOutput,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  defaultShellForPlatform,
  killProcessTree,
} from "../src/sandbox/executor.js";

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;
const IS_WINDOWS = process.platform === "win32";
const NATIVE_SHELL_STARTUP_BUDGET_MS = IS_WINDOWS ? 15_000 : 5_000;
const NATIVE_SHELL_TEST_TIMEOUT_MS = IS_WINDOWS ? 25_000 : 10_000;

function shellQuote(value: string): string {
  return IS_WINDOWS
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, "'\\''")}'`;
}

function nodeEvalCommand(script: string): string {
  const invocation = `${shellQuote(TEST_NODE)} -e ${shellQuote(script)}`;
  return IS_WINDOWS ? `& ${invocation}` : invocation;
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}

async function removeTree(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

describe("SandboxExecutor", () => {
  it("defaults command execution to the long bash timeout", () => {
    expect(DEFAULT_SANDBOX_TIMEOUT_MS).toBe(60 * 60_000);
  });

  it("executes a simple command", async () => {
    const sandbox = new SandboxExecutor({ workingDir: os.tmpdir() });
    const result = await sandbox.execute("echo hello");
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr", async () => {
    const sandbox = new SandboxExecutor({ workingDir: os.tmpdir() });
    const result = await sandbox.execute(nodeEvalCommand("process.stderr.write('error')"));
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
    const result = await sandbox.execute(nodeEvalCommand("setTimeout(() => {}, 10_000)"));
    expect(result.timedOut).toBe(true);
  }, 10000);

  it("times out commands whose background child keeps stdout open", async () => {
    const script = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
      "console.log('parent done');",
    ].join("");
    const sandbox = new SandboxExecutor({
      workingDir: os.tmpdir(),
      timeoutMs: 500,
    });
    const started = Date.now();
    const result = await sandbox.execute(nodeEvalCommand(script));
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
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
    const result = await sandbox.execute(nodeEvalCommand("process.stdout.write('x'.repeat(1_000))"));
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.stdout).toContain("[output truncated by sandbox]");
  });

  it("streams output beyond the memory limit to a complete spool file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-spool-test-"));
    const output = "x".repeat(1_000);
    try {
      const sandbox = new SandboxExecutor({
        workingDir: tmpDir,
        maxOutputBytes: 100,
        outputSpoolDir: path.join(tmpDir, "results"),
        maxSpoolBytes: 5_000,
      });
      const script = `process.stdout.write('x'.repeat(${output.length}))`;
      const result = await sandbox.execute(nodeEvalCommand(script));

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.outputLimitExceeded).toBe(false);
      expect(result.stdoutBytes).toBe(Buffer.byteLength(output));
      expect(result.stdout).toContain("full output streamed to Result Store");
      expect(result.stdoutStreamedOutput).toMatchObject({
        size: Buffer.byteLength(output),
      });
      expect(result.stdoutStreamedOutput?.sourceTruncated).toBeUndefined();
      await expect(fs.readFile(result.stdoutStreamedOutput!.path, "utf8")).resolves.toBe(output);
    } finally {
      await removeTree(tmpDir);
    }
  });

  it("marks the stored prefix incomplete only at the hard spool limit", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-spool-cap-test-"));
    try {
      const sandbox = new SandboxExecutor({
        workingDir: tmpDir,
        maxOutputBytes: 100,
        outputSpoolDir: path.join(tmpDir, "results"),
        maxSpoolBytes: 500,
      });
      const script = "process.stdout.write('x'.repeat(1_000))";
      const result = await sandbox.execute(nodeEvalCommand(script));

      expect(result.stderr).toBe("");
      expect(result.outputLimitExceeded).toBe(true);
      expect(result.stdoutBytes).toBe(500);
      expect(result.stdout).toContain("stored prefix is incomplete");
      expect(result.stdoutStreamedOutput).toMatchObject({
        size: 500,
        sourceTruncated: true,
      });
      await expect(fs.stat(result.stdoutStreamedOutput!.path)).resolves.toMatchObject({ size: 500 });
    } finally {
      await removeTree(tmpDir);
    }
  });

  it("uses correct working directory", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-test-"));
    await fs.writeFile(path.join(tmpDir, "marker.txt"), "found");

    const sandbox = new SandboxExecutor({ workingDir: tmpDir });
    const result = await sandbox.execute(nodeEvalCommand("process.stdout.write(require('node:fs').readFileSync('marker.txt', 'utf8'))"));
    expect(result.stdout.trim()).toBe("found");

    await removeTree(tmpDir);
  });

  it("uses allowedDirs as a macOS write sandbox when sandbox-exec is available", async () => {
    if (process.platform !== "darwin") return;
    try { await fs.access("/usr/bin/sandbox-exec"); }
    catch { return; }

    const allowedDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-allowed-"));
    const deniedDir = await fs.mkdtemp(path.join(process.cwd(), ".sandbox-denied-"));
    try {
      const allowedFile = path.join(allowedDir, "ok.txt");
      const deniedFile = path.join(deniedDir, "blocked.txt");
      const script = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(allowedFile)}, 'ok');`,
        `fs.writeFileSync(${JSON.stringify(deniedFile)}, 'blocked');`,
      ].join("");
      const sandbox = new SandboxExecutor({
        workingDir: allowedDir,
        allowedDirs: [allowedDir],
      });
      const result = await sandbox.execute(nodeEvalCommand(script));
      expect(result.exitCode).not.toBe(0);
      await expect(fs.readFile(allowedFile, "utf8")).resolves.toBe("ok");
      await expect(fs.access(deniedFile)).rejects.toThrow();
    } finally {
      await removeTree(allowedDir);
      await removeTree(deniedDir);
    }
  });

  it("passes custom environment variables", async () => {
    const sandbox = new SandboxExecutor({
      workingDir: os.tmpdir(),
      env: { MY_VAR: "test_value" },
    });
    const result = await sandbox.execute(nodeEvalCommand("process.stdout.write(process.env.MY_VAR || '')"));
    expect(result.stdout.trim()).toBe("test_value");
  });

  it("reports duration", async () => {
    const sandbox = new SandboxExecutor({ workingDir: os.tmpdir() });
    const result = await sandbox.execute("echo fast");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(NATIVE_SHELL_STARTUP_BUDGET_MS);
  }, NATIVE_SHELL_TEST_TIMEOUT_MS);
});

describe("killProcessTree", () => {
  it("uses taskkill to terminate Windows child process trees", () => {
    const callbacks = new Map<string, (...args: any[]) => void>();
    const killer = {
      once: vi.fn((event: string, cb: (...args: any[]) => void) => {
        callbacks.set(event, cb);
        return killer;
      }),
      unref: vi.fn(),
    };
    const spawnFn = vi.fn(() => killer);
    const child = { pid: 1234, kill: vi.fn() };

    killProcessTree(child as any, "SIGTERM", {
      platform: "win32",
      spawnFn: spawnFn as any,
    });

    expect(String(spawnFn.mock.calls[0][0]).toLowerCase()).toMatch(/taskkill\.exe$/);
    expect(spawnFn).toHaveBeenCalledWith(expect.any(String), ["/pid", "1234", "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(killer.unref).toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();

    callbacks.get("exit")?.(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("kills POSIX process groups when a pid is available", () => {
    const child = { pid: 4321, kill: vi.fn() };
    const processKill = vi.fn();

    killProcessTree(child as any, "SIGKILL", {
      platform: "linux",
      processKill: processKill as any,
    });

    expect(processKill).toHaveBeenCalledWith(-4321, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("augmentPath", () => {
  it("prepends /opt/homebrew/bin when it's missing (Apple Silicon case)", () => {
    const out = augmentPath("/usr/bin:/bin", "darwin", {});
    expect(out.split(":")).toContain("/opt/homebrew/bin");
    expect(out.indexOf("/opt/homebrew/bin")).toBeLessThan(out.indexOf("/usr/bin"));
  });

  it("does not duplicate entries that are already present", () => {
    const input = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    const out = augmentPath(input, "darwin", {});
    const homebrewCount = out.split(":").filter((p) => p === "/opt/homebrew/bin").length;
    expect(homebrewCount).toBe(1);
  });

  it("preserves user-supplied entries verbatim", () => {
    const input = "/Users/me/bin:/usr/bin";
    const out = augmentPath(input, "darwin", {});
    expect(out.split(":")).toContain("/Users/me/bin");
    expect(out.split(":")).toContain("/usr/bin");
  });

  it("falls back to canonical list when input is empty/undefined", () => {
    const out = augmentPath(undefined, "darwin", {});
    expect(out.split(":")).toContain("/opt/homebrew/bin");
    expect(out.split(":")).toContain("/usr/local/bin");
    expect(out.split(":")).toContain("/usr/bin");
  });

  it("adds common Google Cloud SDK install locations on POSIX", () => {
    const out = augmentPath("/usr/bin:/bin", "darwin", { HOME: "/Users/me" });
    const parts = out.split(":");
    expect(parts).toContain("/opt/homebrew/share/google-cloud-sdk/bin");
    expect(parts).toContain("/usr/local/share/google-cloud-sdk/bin");
    expect(parts).toContain("/Users/me/google-cloud-sdk/bin");
  });

  it("keeps user-supplied entries BEFORE canonical ones when the user put them first", () => {
    // /Users/me/tools/bin is user-custom; it must remain ahead of the
    // canonical /usr/bin entry that already existed in the input.
    const input = "/Users/me/tools/bin:/usr/bin";
    const out = augmentPath(input).split(":");
    expect(out.indexOf("/Users/me/tools/bin")).toBeLessThan(out.indexOf("/usr/bin"));
  });

  it("uses Windows PATH delimiters without splitting drive letters", () => {
    const input = "D:\\Tools\\bin;C:\\Windows\\System32";
    const out = augmentPath(input, "win32", { SystemRoot: "C:\\Windows" });
    const parts = out.split(";");
    expect(parts).toContain("D:\\Tools\\bin");
    expect(parts).toContain("C:\\Windows\\System32");
    expect(parts).not.toContain("D");
    expect(parts).not.toContain("\\Tools\\bin");
  });

  it("adds common Windows tool and shim locations", () => {
    const out = augmentPath("C:\\Windows\\System32", "win32", {
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    });
    const parts = out.split(";");
    expect(parts).toContain("C:\\Program Files\\nodejs");
    expect(parts).toContain("C:\\Program Files (x86)\\nodejs");
    expect(parts).toContain("C:\\Users\\me\\AppData\\Roaming\\npm");
    expect(parts).toContain("C:\\Users\\me\\AppData\\Local\\npm");
    expect(parts).toContain("C:\\Users\\me\\AppData\\Local\\Programs\\nodejs");
    expect(parts).toContain("C:\\Program Files\\Git\\cmd");
    expect(parts).toContain("C:\\Program Files\\Git\\bin");
    expect(parts).toContain("C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd");
    expect(parts).toContain("C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin");
  });

  it("defaults Windows Python subprocesses to UTF-8 stdio", () => {
    const env = buildSandboxEnv(undefined, "win32");
    expect(env.PYTHONIOENCODING).toBe("utf-8");
    expect(env.PYTHONUTF8).toBe("1");

    const overridden = buildSandboxEnv({ PYTHONIOENCODING: "gb18030", PYTHONUTF8: "0" }, "win32");
    expect(overridden.PYTHONIOENCODING).toBe("gb18030");
    expect(overridden.PYTHONUTF8).toBe("0");
  });

  describe("Windows shell selection", () => {
    it("defaults Windows to PowerShell instead of a POSIX-incompatible cmd -c path", () => {
      const previous = process.env.ORKAS_WINDOWS_SHELL;
      delete process.env.ORKAS_WINDOWS_SHELL;
      try {
        expect(defaultShellForPlatform("win32")).toBe("powershell.exe");
      } finally {
        if (previous === undefined) delete process.env.ORKAS_WINDOWS_SHELL;
        else process.env.ORKAS_WINDOWS_SHELL = previous;
      }
    });

    it("honors an explicit Windows shell override", () => {
      const previous = process.env.ORKAS_WINDOWS_SHELL;
      process.env.ORKAS_WINDOWS_SHELL = "pwsh.exe";
      try {
        expect(defaultShellForPlatform("win32")).toBe("pwsh.exe");
      } finally {
        if (previous === undefined) delete process.env.ORKAS_WINDOWS_SHELL;
        else process.env.ORKAS_WINDOWS_SHELL = previous;
      }
    });

    it("uses cmd.exe /d /s /c when cmd is explicitly selected", () => {
      const inv = buildShellInvocation("cmd.exe", "echo hi", "win32");
      expect(inv.kind).toBe("cmd");
      expect(inv.args).toEqual(["/d", "/s", "/c", "echo hi"]);
    });

    it("routes explicit cmd /c commands to cmd even when PowerShell is the default shell", () => {
      const command = 'cmd /c dir "%USERPROFILE%\\.orkas\\skills" 2>nul || echo missing';
      const inv = buildShellInvocation("powershell.exe", command, "win32");
      expect(inv.kind).toBe("cmd");
      expect(inv.command).toBe("cmd.exe");
      expect(inv.args).toEqual(["/d", "/s", "/c", command]);
    });

    it("passes PowerShell commands through without bash-syntax rewriting", () => {
      const command = '$ORKAS_NODE "$ORKAS_PC_DIR/bin/run-skill.cjs" calculator eval';
      const inv = buildShellInvocation("powershell.exe", command, "win32");
      expect(inv.kind).toBe("powershell");
      expect(inv.args).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ]);
    });

    it("keeps explicit Git Bash-style shells POSIX-shaped on Windows", () => {
      const inv = buildShellInvocation("bash.exe", "echo $ORKAS_UID", "win32");
      expect(inv.kind).toBe("posix");
      expect(inv.args).toEqual(["-lc", "echo $ORKAS_UID"]);
    });
  });

  describe("executeBackground", () => {
    it("returns a pid immediately and writes output to the log file", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-bg-"));
      try {
        const logPath = path.join(dir, "run.log");
        const sandbox = new SandboxExecutor({ workingDir: dir });
        const { pid, error } = sandbox.executeBackground(
          nodeEvalCommand("process.stdout.write('done\\n')"),
          logPath,
        );
        expect(error).toBeUndefined();
        expect(typeof pid).toBe("number");
        // PowerShell cold-start plus native scanner latency can exceed two
        // seconds on loaded Windows hosts. Background launch is deliberately
        // asynchronous, so allow a bounded platform-specific startup window.
        let body = "";
        const deadline = Date.now() + NATIVE_SHELL_STARTUP_BUDGET_MS;
        while (Date.now() < deadline && !body.includes("done")) {
          await new Promise((r) => setTimeout(r, 50));
          try { body = await fs.readFile(logPath, "utf8"); } catch { /* not yet */ }
        }
        expect(body).toContain("done");
        await waitForProcessExit(pid!);
      } finally {
        await removeTree(dir);
      }
    }, NATIVE_SHELL_TEST_TIMEOUT_MS);

    it("refuses blocked commands without spawning", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-bg-"));
      try {
        const sandbox = new SandboxExecutor({ workingDir: dir });
        const { pid, error } = sandbox.executeBackground("rm -rf /", path.join(dir, "x.log"));
        expect(pid).toBeNull();
        expect(error).toMatch(/blocked/i);
      } finally {
        await removeTree(dir);
      }
    });
  });
});

describe("decodeProcessOutput", () => {
  it("falls back to GB18030 for Chinese Windows console output", () => {
    const gbkVersion = Buffer.from([0xb0, 0xe6, 0xb1, 0xbe]);
    expect(decodeProcessOutput(gbkVersion, "win32", { ORKAS_UI_LANG: "zh" })).toBe("版本");
  });

  it("keeps valid UTF-8 output unchanged on Windows", () => {
    const utf8 = Buffer.from("版本", "utf8");
    expect(decodeProcessOutput(utf8, "win32", { ORKAS_UI_LANG: "zh" })).toBe("版本");
  });
});
