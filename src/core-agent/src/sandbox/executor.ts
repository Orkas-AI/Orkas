/**
 * Sandbox executor for safely running shell commands.
 *
 * Provides resource limits, directory restrictions, command filtering,
 * and timeout enforcement. Inspired by OpenClaw's sandbox execution layer.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { createLogger } from "../shared/logger.js";
import {
  ProcessOutputCapture,
  type StreamedToolOutput,
} from "./output-capture.js";

const log = createLogger("sandbox");

/** Configuration for the sandbox executor. */
export interface SandboxConfig {
  /** Working directory for commands. */
  workingDir: string;
  /** Maximum execution time in milliseconds (default: 60 min). */
  timeoutMs?: number;
  /** Maximum output buffer size in bytes (default: 1MB). */
  maxOutputBytes?: number;
  /** Session-scoped directory for streaming output beyond maxOutputBytes. */
  outputSpoolDir?: string;
  /** Hard per-stream safety limit when outputSpoolDir is available (default: 64MB). */
  maxSpoolBytes?: number;
  /** Allowed directories the sandbox can access (default: [workingDir]). */
  allowedDirs?: string[];
  /** Commands that are explicitly blocked. */
  blockedCommands?: string[];
  /** Whether to allow network access (default: true). */
  allowNetwork?: boolean;
  /** Environment variables to pass through. */
  env?: Record<string, string>;
  /** Abort signal used by the runner to stop a wedged tool without aborting the whole turn. */
  signal?: AbortSignal;
  /** Shell to use (default: /bin/sh on POSIX, PowerShell on Windows). */
  shell?: string;
}

/** Result of a sandboxed command execution. */
export interface SandboxResult {
  /** Standard output. */
  stdout: string;
  /** Standard error. */
  stderr: string;
  /** Exit code (null if killed). */
  exitCode: number | null;
  /** Whether the command was killed due to timeout. */
  timedOut: boolean;
  /** Whether the command was killed due to output limit. */
  outputLimitExceeded: boolean;
  /** Captured byte counts before UTF-8 normalization. */
  stdoutBytes: number;
  stderrBytes: number;
  /** Host-only temp files for streams larger than the in-memory threshold. */
  stdoutStreamedOutput?: StreamedToolOutput;
  stderrStreamedOutput?: StreamedToolOutput;
  /** Execution duration in milliseconds. */
  durationMs: number;
}

type ShellKind = "posix" | "cmd" | "powershell";
type KillableChild = Pick<ChildProcess, "kill" | "pid">;
type ProcessKiller = typeof process.kill;
type SpawnFn = typeof spawn;

export const DEFAULT_SANDBOX_TIMEOUT_MS = 60 * 60_000;
const KILL_GRACE_MS = 5_000;
const KILL_SETTLE_GRACE_MS = KILL_GRACE_MS + 1_000;

export interface ShellInvocation {
  command: string;
  args: string[];
  kind: ShellKind;
}

type SpawnInvocation = {
  command: string;
  args: string[];
};

function windowsSystem32Tool(name: string): string {
  const root = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  return path.win32.join(root, "System32", name);
}

export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals = "SIGTERM",
  opts: {
    platform?: NodeJS.Platform;
    processKill?: ProcessKiller;
    spawnFn?: SpawnFn;
  } = {},
): void {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32" && child.pid) {
    try {
      const killer = (opts.spawnFn ?? spawn)(windowsSystem32Tool("taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const fallback = () => {
        try { child.kill(signal); } catch { /* Process may already be dead. */ }
      };
      killer.once("error", fallback);
      killer.once("exit", (code) => {
        if (code !== 0) fallback();
      });
      if (typeof killer.unref === "function") killer.unref();
      return;
    } catch {
      // Fall back to killing the direct child below.
    }
  }

  try {
    if (platform !== "win32" && child.pid) {
      (opts.processKill ?? process.kill)(-child.pid, signal);
      return;
    }
  } catch {
    // Fall back to killing the shell process below.
  }
  try {
    child.kill(signal);
  } catch {
    // Process may already be dead.
  }
}

type OutputEncodingEnv = {
  LANG?: string;
  LC_ALL?: string;
  ORKAS_UI_LANG?: string;
  [key: string]: string | undefined;
};

/** Default blocked commands — destructive or dangerous operations. */
const DEFAULT_BLOCKED_COMMANDS = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=",
  ":(){ :|:& };:",
  "chmod -R 777 /",
  "> /dev/sda",
  "shutdown",
  "reboot",
  "halt",
  "init 0",
  "init 6",
];

function shellBaseName(shell: string): string {
  return (shell.split(/[\\/]/).pop() || shell).toLowerCase();
}

function inferShellKind(shell: string, platform: NodeJS.Platform = process.platform): ShellKind {
  const base = shellBaseName(shell).replace(/\.exe$/i, "");
  if (platform !== "win32") return "posix";
  if (base === "cmd" || base === "comspec") return "cmd";
  if (base === "powershell" || base === "pwsh") return "powershell";
  return "posix";
}

export function defaultShellForPlatform(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    return process.env.ORKAS_WINDOWS_SHELL || "powershell.exe";
  }
  return "/bin/sh";
}

export function buildShellInvocation(
  shell: string,
  command: string,
  platform: NodeJS.Platform = process.platform,
): ShellInvocation {
  if (platform === "win32" && /^\s*cmd(?:\.exe)?\s+(?:\/d\s+)?(?:\/s\s+)?\/c\b/i.test(command)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", command],
      kind: "cmd",
    };
  }

  const kind = inferShellKind(shell, platform);
  if (platform === "win32" && kind === "powershell") {
    return {
      command: shell,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      kind,
    };
  }
  if (platform === "win32" && kind === "cmd") {
    return {
      command: shell,
      args: ["/d", "/s", "/c", command],
      kind,
    };
  }
  return {
    command: shell,
    args: [platform === "win32" ? "-lc" : "-c", command],
    kind,
  };
}

function countMatches(input: string, re: RegExp): number {
  const matches = input.match(re);
  return matches ? matches.length : 0;
}

function decodeWithEncoding(bytes: Buffer, encoding: string): string | null {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return null;
  }
}

function canonicalSandboxPath(input: string): string {
  const abs = path.resolve(input);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    return abs;
  }
}

function uniqueSandboxDirs(input: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of input ?? []) {
    if (!dir) continue;
    const abs = canonicalSandboxPath(dir);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

function escapeSandboxString(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function macWriteSandboxAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec");
}

function macWriteSandboxProfile(allowedDirs: readonly string[]): string {
  const forms = [
    '(literal "/dev/null")',
    ...allowedDirs.map((dir) => `(subpath "${escapeSandboxString(dir)}")`),
  ];
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${forms.join(" ")})`,
  ].join("\n");
}

function maybeWrapWithMacWriteSandbox(
  invocation: ShellInvocation,
  allowedDirs: readonly string[] | undefined,
): SpawnInvocation {
  const dirs = uniqueSandboxDirs(allowedDirs);
  if (!dirs.length || !macWriteSandboxAvailable()) {
    return { command: invocation.command, args: invocation.args };
  }
  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-p", macWriteSandboxProfile(dirs), invocation.command, ...invocation.args],
  };
}

function decodedTextScore(text: string): number {
  if (!text) return 0;
  let score = countMatches(text, /\uFFFD/g) * 100;
  score += countMatches(text, /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) * 20;
  // Common mojibake produced when UTF-8 text is decoded with a legacy ANSI
  // code page. Keep this as a light penalty so valid English/ASCII remains
  // neutral while obviously broken mixed output loses ties.
  score += countMatches(text, /(?:Ã.|Â.|å.|æ.|ç.|ä.)/g) * 2;
  return score;
}

function windowsFallbackEncodings(env: OutputEncodingEnv = process.env): string[] {
  const lang = String(env.ORKAS_UI_LANG || env.LC_ALL || env.LANG || "").toLowerCase();
  const preferred = lang.startsWith("ja")
    ? ["shift_jis"]
    : lang.startsWith("ko")
      ? ["euc-kr"]
      : lang.includes("tw") || lang.includes("hk") || lang.includes("hant")
        ? ["big5", "gb18030"]
        : ["gb18030", "big5"];
  const out: string[] = [];
  for (const encoding of [...preferred, "shift_jis", "euc-kr", "windows-1252"]) {
    if (!out.includes(encoding)) out.push(encoding);
  }
  return out;
}

export function decodeProcessOutput(
  bytes: Buffer,
  platform: NodeJS.Platform = process.platform,
  env: OutputEncodingEnv = process.env,
): string {
  if (bytes.length === 0) return "";
  const utf8 = decodeWithEncoding(bytes, "utf-8") ?? bytes.toString("utf8");
  if (platform !== "win32") return utf8;

  const utf8Score = decodedTextScore(utf8);
  if (utf8Score === 0) return utf8;

  let best = utf8;
  let bestScore = utf8Score;
  for (const encoding of windowsFallbackEncodings(env)) {
    const decoded = decodeWithEncoding(bytes, encoding);
    if (decoded == null) continue;
    const score = decodedTextScore(decoded);
    if (score < bestScore) {
      best = decoded;
      bestScore = score;
    }
  }
  return best;
}

function buildWindowsCanonicalPathEntries(env: NodeJS.ProcessEnv): string[] {
  const root = getEnvValue(env, ["SystemRoot", "WINDIR"]) || "C:\\Windows";
  const programFiles = getEnvValue(env, ["ProgramFiles"]) || "C:\\Program Files";
  const programFilesX86 = getEnvValue(env, ["ProgramFiles(x86)"]) || "C:\\Program Files (x86)";
  const appData = getEnvValue(env, ["APPDATA"]);
  const localAppData = getEnvValue(env, ["LOCALAPPDATA"]);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (entry: string | undefined) => {
    if (!entry) return;
    const normalized = path.win32.normalize(entry);
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(normalized);
  };

  add(path.win32.join(root, "System32"));
  add(root);
  add(path.win32.join(root, "System32", "WindowsPowerShell", "v1.0"));
  add(path.win32.join(programFiles, "nodejs"));
  add(path.win32.join(programFilesX86, "nodejs"));
  add(path.win32.join(programFiles, "Git", "cmd"));
  add(path.win32.join(programFiles, "Git", "bin"));
  add(path.win32.join(programFilesX86, "Git", "cmd"));
  add(path.win32.join(programFilesX86, "Git", "bin"));
  if (appData) add(path.win32.join(appData, "npm"));
  if (localAppData) {
    add(path.win32.join(localAppData, "npm"));
    add(path.win32.join(localAppData, "Programs", "nodejs"));
    add(path.win32.join(localAppData, "Programs", "Git", "cmd"));
    add(path.win32.join(localAppData, "Programs", "Git", "bin"));
    add(path.win32.join(localAppData, "Programs", "OpenAI", "Codex", "bin"));
    addPythonInstallDirs(path.win32.join(localAppData, "Programs", "Python"), add);
  }
  addPythonInstallDirs(programFiles, add);

  return out;
}

function buildPosixCanonicalPathEntries(env: NodeJS.ProcessEnv): string[] {
  const home = getEnvValue(env, ["HOME"]);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (entry: string | undefined) => {
    if (!entry) return;
    const normalized = path.posix.normalize(entry);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  for (const entry of CANONICAL_PATH_ENTRIES) add(entry);
  add("/opt/homebrew/share/google-cloud-sdk/bin");
  add("/usr/local/share/google-cloud-sdk/bin");
  add("/opt/google-cloud-sdk/bin");
  if (home) add(path.posix.join(home, "google-cloud-sdk", "bin"));
  return out;
}

function addPythonInstallDirs(root: string | undefined, add: (entry: string | undefined) => void): void {
  if (!root) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^Python\d+/i.test(entry)) continue;
    const dir = path.win32.join(root, entry);
    add(dir);
    add(path.win32.join(dir, "Scripts"));
  }
}

function getEnvValue(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string") return value;
  }
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const [key, value] of Object.entries(env)) {
    if (wanted.has(key.toLowerCase()) && typeof value === "string") return value;
  }
  return undefined;
}

function windowsHostEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
  ]) {
    const value = getEnvValue(env, [key]);
    if (value) out[key] = value;
  }
  return out;
}

export function buildSandboxEnv(
  injected: Record<string, string> | undefined,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const hostPath = getEnvValue(process.env, ["PATH", "Path"]);
  const env: Record<string, string> = {
    ...(platform === "win32" ? windowsHostEnv(process.env) : {}),
    HOME: process.env.HOME ?? process.env.USERPROFILE ?? (platform === "win32" ? "C:\\" : "/tmp"),
    PATH: augmentPath(hostPath, platform, process.env),
    TERM: "dumb",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ...(platform === "win32" ? {
      PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
      PYTHONUTF8: process.env.PYTHONUTF8 ?? "1",
    } : {}),
    ...(injected ?? {}),
  };

  if (env.ORKAS_PATH_PREPEND) {
    const delimiter = platform === "win32" ? ";" : ":";
    env.PATH = `${env.ORKAS_PATH_PREPEND}${delimiter}${env.PATH}`;
  }

  return env;
}

/**
 * SandboxExecutor wraps command execution with safety controls.
 *
 * Features:
 * - Timeout enforcement with SIGTERM → SIGKILL escalation
 * - Output size limits to prevent memory exhaustion
 * - Command blocklist for dangerous operations
 * - Working directory restriction
 * - Environment variable filtering
 */
export class SandboxExecutor {
  private readonly config: Required<
    Pick<SandboxConfig, "workingDir" | "timeoutMs" | "maxOutputBytes" | "shell">
  > & SandboxConfig;

  constructor(config: SandboxConfig) {
    this.config = {
      timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024, // 1MB
      shell: defaultShellForPlatform(),
      ...config,
      workingDir: path.resolve(config.workingDir),
      allowedDirs: uniqueSandboxDirs(config.allowedDirs),
      blockedCommands: [
        ...DEFAULT_BLOCKED_COMMANDS,
        ...(config.blockedCommands ?? []),
      ],
    };
  }

  /**
   * Execute a command inside the sandbox.
   *
   * The command runs as a child process with:
   * - Timeout enforcement (SIGTERM after timeout, SIGKILL after 5s grace)
   * - Output buffer size limit
   * - Blocked command check
   * - Working directory restriction
   */
  async execute(command: string): Promise<SandboxResult> {
    const startTime = Date.now();

    // Check for blocked commands
    const violation = this.checkBlockedCommand(command);
    if (violation) {
      log.warn(`Blocked command: ${violation}`);
      return {
        stdout: "",
        stderr: `Command blocked by sandbox policy: ${violation}`,
        exitCode: 1,
        timedOut: false,
        outputLimitExceeded: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // Validate working directory
    const cwd = this.config.workingDir;

    return new Promise<SandboxResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let outputLimitExceeded = false;
      let killed = false;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      let forceSettleTimer: NodeJS.Timeout | null = null;
      let abortListener: (() => void) | null = null;

      const env = buildSandboxEnv(this.config.env);
      const outputSpoolDir = typeof this.config.outputSpoolDir === "string"
        ? this.config.outputSpoolDir
        : undefined;
      const stdoutCapture = outputSpoolDir
        ? new ProcessOutputCapture({
          spoolDir: outputSpoolDir,
          prefix: "bash-stdout",
          memoryBytes: this.config.maxOutputBytes,
          maxSpoolBytes: this.config.maxSpoolBytes,
        })
        : null;
      const stderrCapture = outputSpoolDir
        ? new ProcessOutputCapture({
          spoolDir: outputSpoolDir,
          prefix: "bash-stderr",
          memoryBytes: this.config.maxOutputBytes,
          maxSpoolBytes: this.config.maxSpoolBytes,
        })
        : null;

      // Restrict network if configured
      if (this.config.allowNetwork === false) {
        // On macOS/Linux, we can't easily block network without sandboxing tools
        // but we can set a flag for documentation
        env.SANDBOX_NO_NETWORK = "1";
      }

      const invocation = maybeWrapWithMacWriteSandbox(
        buildShellInvocation(this.config.shell, command),
        this.config.allowedDirs,
      );
      const child = spawn(invocation.command, invocation.args, {
        cwd,
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const abortSignal = this.config.signal;
      if (abortSignal) {
        abortListener = () => killChild();
        if (abortSignal.aborted) abortListener();
        else abortSignal.addEventListener("abort", abortListener, { once: true });
      }

      // Close stdin immediately — no interactive input
      child.stdin.end();

      // Collect stdout with size limit
      child.stdout.on("data", (data: Buffer) => {
        if (outputLimitExceeded) return;
        if (stdoutCapture) {
          if (!stdoutCapture.append(data)) {
            outputLimitExceeded = true;
            stdoutTruncated = true;
            killChild();
          }
          return;
        }
        stdoutBytes += data.length;
        if (stdoutBytes > this.config.maxOutputBytes) {
          outputLimitExceeded = true;
          stdoutTruncated = true;
          const allowed = Math.max(0, data.length - (stdoutBytes - this.config.maxOutputBytes));
          if (allowed > 0) stdoutChunks.push(data.subarray(0, allowed));
          killChild();
          return;
        }
        stdoutChunks.push(data);
      });

      // Collect stderr with size limit
      child.stderr.on("data", (data: Buffer) => {
        if (outputLimitExceeded) return;
        if (stderrCapture) {
          if (!stderrCapture.append(data)) {
            outputLimitExceeded = true;
            stderrTruncated = true;
            killChild();
          }
          return;
        }
        stderrBytes += data.length;
        if (stderrBytes > this.config.maxOutputBytes) {
          outputLimitExceeded = true;
          stderrTruncated = true;
          const allowed = Math.max(0, data.length - (stderrBytes - this.config.maxOutputBytes));
          if (allowed > 0) stderrChunks.push(data.subarray(0, allowed));
          killChild();
          return;
        }
        stderrChunks.push(data);
      });

      // Timeout handler
      const timeoutId = setTimeout(() => {
        timedOut = true;
        killChild();
      }, this.config.timeoutMs);

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (forceSettleTimer) clearTimeout(forceSettleTimer);
        if (abortSignal && abortListener) abortSignal.removeEventListener("abort", abortListener);
        let stdout: string;
        let stderr: string;
        let stdoutStreamedOutput: StreamedToolOutput | undefined;
        let stderrStreamedOutput: StreamedToolOutput | undefined;
        if (stdoutCapture && stderrCapture) {
          const decode = (bytes: Buffer) => decodeProcessOutput(bytes, process.platform, env);
          const capturedStdout = stdoutCapture.finish({
            decode,
            normalizeSpoolToUtf8: process.platform === "win32",
          });
          const capturedStderr = stderrCapture.finish({
            decode,
            normalizeSpoolToUtf8: process.platform === "win32",
          });
          stdout = capturedStdout.text;
          stderr = capturedStderr.text;
          stdoutBytes = capturedStdout.bytes;
          stderrBytes = capturedStderr.bytes;
          stdoutStreamedOutput = capturedStdout.streamedOutput;
          stderrStreamedOutput = capturedStderr.streamedOutput;
        } else {
          stdout = decodeProcessOutput(Buffer.concat(stdoutChunks), process.platform, env);
          stderr = decodeProcessOutput(Buffer.concat(stderrChunks), process.platform, env);
          if (stdoutTruncated) stdout += "\n... [output truncated by sandbox]";
          if (stderrTruncated) stderr += "\n... [stderr truncated by sandbox]";
        }
        resolve({
          stdout,
          stderr,
          exitCode: code,
          timedOut,
          outputLimitExceeded,
          stdoutBytes,
          stderrBytes,
          ...(stdoutStreamedOutput ? { stdoutStreamedOutput } : {}),
          ...(stderrStreamedOutput ? { stderrStreamedOutput } : {}),
          durationMs: Date.now() - startTime,
        });
      };

      function killChild() {
        if (killed) return;
        killed = true;
        killProcessTree(child, "SIGTERM");
        // Escalate to SIGKILL after 5 seconds
        const killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), KILL_GRACE_MS);
        if (typeof killTimer.unref === "function") killTimer.unref();
        forceSettleTimer = setTimeout(() => finish(null), KILL_SETTLE_GRACE_MS);
        if (typeof forceSettleTimer.unref === "function") forceSettleTimer.unref();
      }

      child.on("close", (code) => {
        finish(code);
      });

      child.on("error", (err) => {
        if (settled) return;
        if (stderrCapture) stderrCapture.append(Buffer.from(err.message));
        else {
          stderrChunks.push(Buffer.from(err.message));
          stderrBytes += Buffer.byteLength(err.message);
        }
        finish(1);
      });
    });
  }

  /**
   * Launch a command detached, with stdout+stderr appended to `logPath`.
   * Same env construction (PATH augmentation + ORKAS_PATH_PREPEND) and
   * blocked-command policy as `execute`, but no timeout and no output
   * buffering — the process intentionally outlives the agent turn (long
   * builds, renders, downloads). The caller reports `pid` + `logPath` to
   * the model, which polls the log and may `kill <pid>` to stop it.
   */
  executeBackground(command: string, logPath: string): { pid: number | null; error?: string } {
    const violation = this.checkBlockedCommand(command);
    if (violation) {
      return { pid: null, error: `Command blocked by sandbox policy: ${violation}` };
    }
    const env = buildSandboxEnv(this.config.env);
    let logFd: number;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      logFd = fs.openSync(logPath, "a");
    } catch (err) {
      return { pid: null, error: `cannot open log file: ${(err as Error).message}` };
    }
    try {
      const invocation = maybeWrapWithMacWriteSandbox(
        buildShellInvocation(this.config.shell, command),
        this.config.allowedDirs,
      );
      const child = spawn(invocation.command, invocation.args, {
        cwd: this.config.workingDir,
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      });
      child.unref();
      const pid = child.pid ?? null;
      log.info(`background command started pid=${pid} log=${logPath}`);
      return { pid };
    } catch (err) {
      return { pid: null, error: (err as Error).message };
    } finally {
      // The child holds its own duplicated descriptors after spawn.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require("node:fs") as typeof import("node:fs")).closeSync(logFd);
      } catch { /* already closed */ }
    }
  }

  /** Check if a command matches the blocklist. */
  private checkBlockedCommand(command: string): string | null {
    const normalized = command.trim().toLowerCase();
    for (const blocked of this.config.blockedCommands ?? []) {
      if (normalized.includes(blocked.toLowerCase())) {
        return blocked;
      }
    }
    return null;
  }
}

/**
 * Prepend canonical shell PATH entries that aren't already present. Applied
 * to every sandboxed command so Electron-launched processes (which inherit
 * Finder's minimal PATH) can still find brew / fnm / pyenv-installed tools.
 * Order matters: `/opt/homebrew/...` goes first so Apple-Silicon brew wins
 * when both x86_64 and arm64 brews are installed.
 */
const CANONICAL_PATH_ENTRIES = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

export function augmentPath(
  input: string | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const delimiter = platform === "win32" ? ";" : ":";
  const canonical = platform === "win32"
    ? buildWindowsCanonicalPathEntries(env)
    : buildPosixCanonicalPathEntries(env);
  const existing = (input ?? "").split(delimiter).filter(Boolean);
  const existingSet = new Set(existing);
  const missing = canonical.filter((p) => !existingSet.has(p));
  const merged = [...missing, ...existing];
  return merged.length ? merged.join(delimiter) : canonical.join(delimiter);
}
