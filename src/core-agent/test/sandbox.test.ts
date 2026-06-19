import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  SandboxExecutor,
  augmentPath,
  buildShellInvocation,
  decodeProcessOutput,
  defaultShellForPlatform,
} from "../src/sandbox/executor.js";

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

  it("uses Windows PATH delimiters without splitting drive letters", () => {
    const input = "D:\\Tools\\bin;C:\\Windows\\System32";
    const out = augmentPath(input, "win32", { SystemRoot: "C:\\Windows" });
    const parts = out.split(";");
    expect(parts).toContain("D:\\Tools\\bin");
    expect(parts).toContain("C:\\Windows\\System32");
    expect(parts).not.toContain("D");
    expect(parts).not.toContain("\\Tools\\bin");
  });

  it("adds common Windows Node.js and npm shim locations", () => {
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
  });

  describe("Windows shell selection", () => {
    it("defaults Windows to PowerShell instead of a POSIX-incompatible cmd -c path", () => {
      expect(defaultShellForPlatform("win32")).toBe("powershell.exe");
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
        const { pid, error } = sandbox.executeBackground("printf done; echo", logPath);
        expect(error).toBeUndefined();
        expect(typeof pid).toBe("number");
        // The detached child writes asynchronously — poll the log briefly.
        let body = "";
        for (let i = 0; i < 40 && !body.includes("done"); i++) {
          await new Promise((r) => setTimeout(r, 50));
          try { body = await fs.readFile(logPath, "utf8"); } catch { /* not yet */ }
        }
        expect(body).toContain("done");
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }, 10000);

    it("refuses blocked commands without spawning", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-bg-"));
      try {
        const sandbox = new SandboxExecutor({ workingDir: dir });
        const { pid, error } = sandbox.executeBackground("rm -rf /", path.join(dir, "x.log"));
        expect(pid).toBeNull();
        expect(error).toMatch(/blocked/i);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
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
