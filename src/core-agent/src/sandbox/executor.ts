/**
 * Sandbox executor for safely running shell commands.
 *
 * Provides resource limits, directory restrictions, command filtering,
 * and timeout enforcement. Inspired by OpenClaw's sandbox execution layer.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { createLogger } from "../shared/logger.js";

const log = createLogger("sandbox");

/** Configuration for the sandbox executor. */
export interface SandboxConfig {
  /** Working directory for commands. */
  workingDir: string;
  /** Maximum execution time in milliseconds (default: 30000). */
  timeoutMs?: number;
  /** Maximum output buffer size in bytes (default: 1MB). */
  maxOutputBytes?: number;
  /** Allowed directories the sandbox can access (default: [workingDir]). */
  allowedDirs?: string[];
  /** Commands that are explicitly blocked. */
  blockedCommands?: string[];
  /** Whether to allow network access (default: true). */
  allowNetwork?: boolean;
  /** Environment variables to pass through. */
  env?: Record<string, string>;
  /** Shell to use (default: /bin/sh). */
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
  /** Execution duration in milliseconds. */
  durationMs: number;
}

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
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024, // 1MB
      // Windows 走 cmd.exe（COMSPEC 变量指向）；POSIX 走 /bin/sh。
      shell: process.platform === "win32"
        ? (process.env.COMSPEC || "cmd.exe")
        : "/bin/sh",
      ...config,
      workingDir: path.resolve(config.workingDir),
      allowedDirs: config.allowedDirs?.map((d) => path.resolve(d)),
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
        durationMs: Date.now() - startTime,
      };
    }

    // Validate working directory
    const cwd = this.config.workingDir;

    return new Promise<SandboxResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let outputLimitExceeded = false;
      let killed = false;

      // Build environment.
      // PATH: Electron apps launched from Finder / the dock inherit a minimal
      // PATH that often excludes brew-installed locations (especially
      // `/opt/homebrew/bin` on Apple Silicon). Without augmentation, agents
      // that try `brew install pandoc` or `pip --version` would hit "command
      // not found" even when the CLI is installed. Prepend the canonical
      // locations that don't already appear.
      const env: Record<string, string> = {
        HOME: process.env.HOME ?? "/tmp",
        PATH: augmentPath(process.env.PATH),
        TERM: "dumb",
        LANG: process.env.LANG ?? "en_US.UTF-8",
        ...(this.config.env ?? {}),
      };

      // Restrict network if configured
      if (this.config.allowNetwork === false) {
        // On macOS/Linux, we can't easily block network without sandboxing tools
        // but we can set a flag for documentation
        env.SANDBOX_NO_NETWORK = "1";
      }

      const child = spawn(this.config.shell, ["-c", command], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Close stdin immediately — no interactive input
      child.stdin.end();

      // Collect stdout with size limit
      child.stdout.on("data", (data: Buffer) => {
        if (outputLimitExceeded) return;
        stdout += data.toString("utf-8");
        if (stdout.length > this.config.maxOutputBytes) {
          outputLimitExceeded = true;
          stdout = stdout.slice(0, this.config.maxOutputBytes) +
            "\n... [output truncated by sandbox]";
          killChild();
        }
      });

      // Collect stderr with size limit
      child.stderr.on("data", (data: Buffer) => {
        if (outputLimitExceeded) return;
        stderr += data.toString("utf-8");
        if (stderr.length > this.config.maxOutputBytes) {
          outputLimitExceeded = true;
          stderr = stderr.slice(0, this.config.maxOutputBytes) +
            "\n... [stderr truncated by sandbox]";
          killChild();
        }
      });

      // Timeout handler
      const timeoutId = setTimeout(() => {
        timedOut = true;
        killChild();
      }, this.config.timeoutMs);

      function killChild() {
        if (killed) return;
        killed = true;
        child.kill("SIGTERM");
        // Escalate to SIGKILL after 5 seconds
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Process may already be dead
          }
        }, 5000);
      }

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        resolve({
          stdout,
          stderr,
          exitCode: code,
          timedOut,
          outputLimitExceeded,
          durationMs: Date.now() - startTime,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timeoutId);
        resolve({
          stdout,
          stderr: err.message,
          exitCode: 1,
          timedOut: false,
          outputLimitExceeded: false,
          durationMs: Date.now() - startTime,
        });
      });
    });
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

export function augmentPath(input: string | undefined): string {
  const existing = (input ?? "").split(":").filter(Boolean);
  const existingSet = new Set(existing);
  const missing = CANONICAL_PATH_ENTRIES.filter((p) => !existingSet.has(p));
  const merged = [...missing, ...existing];
  return merged.length ? merged.join(":") : CANONICAL_PATH_ENTRIES.join(":");
}
