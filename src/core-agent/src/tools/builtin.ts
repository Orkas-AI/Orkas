import fs from "node:fs/promises";
import path from "node:path";
import { defineTool, type AgentTool, type ToolContext } from "./base.js";
import { SandboxExecutor } from "../sandbox/executor.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";

/** Read a file from the filesystem. */
export const readFileTool: AgentTool = defineTool({
  name: "read_file",
  description: "Read the contents of a file at the given path. Returns the file content as text.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path to read." },
      maxLines: { type: "number", description: "Maximum number of lines to return (optional)." },
    },
    required: ["path"],
  },
  async execute(input, ctx) {
    const filePath = path.resolve(ctx.workingDir ?? ".", input.path as string);
    try {
      let content = await fs.readFile(filePath, "utf-8");
      const maxLines = input.maxLines as number | undefined;
      if (maxLines && maxLines > 0) {
        const lines = content.split("\n");
        content = lines.slice(0, maxLines).join("\n");
        if (lines.length > maxLines) {
          content += `\n... (${lines.length - maxLines} more lines)`;
        }
      }
      return { content };
    } catch (err) {
      return { content: `Error reading file: ${(err as Error).message}`, isError: true };
    }
  },
});

/** Write content to a file. */
export const writeFileTool: AgentTool = defineTool({
  name: "write_file",
  description: "Write content to a file at the given path. Creates directories as needed.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write to." },
      content: { type: "string", description: "Content to write." },
    },
    required: ["path", "content"],
  },
  async execute(input, ctx) {
    const filePath = path.resolve(ctx.workingDir ?? ".", input.path as string);
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, input.content as string, "utf-8");
      return { content: `File written: ${filePath}` };
    } catch (err) {
      return { content: `Error writing file: ${(err as Error).message}`, isError: true };
    }
  },
});

/**
 * Execute a shell command via the sandbox executor.
 *
 * Uses SandboxExecutor for timeout enforcement, output limits,
 * and blocked command filtering.
 */
export const DEFAULT_BASH_TIMEOUT_MS = 60 * 60_000;
export const BASH_PROGRESS_INTERVAL_MS = 60_000;
const LEGACY_DEFAULT_BASH_TIMEOUTS_MS = new Set([30_000, 300_000]);

export function normalizeBashTimeoutMs(
  value: unknown,
  opts: { legacyDefault?: boolean } = {},
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_BASH_TIMEOUT_MS;
  }
  const timeoutMs = Math.round(value);
  return opts.legacyDefault && LEGACY_DEFAULT_BASH_TIMEOUTS_MS.has(timeoutMs)
    ? DEFAULT_BASH_TIMEOUT_MS
    : timeoutMs;
}

export const bashTool: AgentTool = defineTool({
  name: "bash",
  description: "Execute a shell command in a sandboxed environment and return its output. Use for system operations, builds, etc. For GUI apps, browsers, servers, watchers, or any command you would normally background with `&`, set run_in_background=true instead of shell-backgrounding it; inherited stdout/stderr can otherwise keep the tool waiting.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      timeoutMs: { type: "number", description: "Timeout in milliseconds (default: 3600000 = 60 min). Pass a larger value for unusually long-running commands like full builds, large installs, network fetches, video processing." },
      run_in_background: {
        type: "boolean",
        description: "Run detached and return immediately with a pid + log file path instead of waiting. Use for commands that may outlast any reasonable timeout (long builds, renders, big downloads). Poll progress by reading the log file; stop the process with `kill <pid>`. The process is NOT stopped automatically when the conversation ends.",
      },
    },
    required: ["command"],
  },
  async execute(input, ctx) {
    const command = input.command as string;
    const timeoutMs = normalizeBashTimeoutMs(input.timeoutMs);

    const sandbox = new SandboxExecutor({
      workingDir: ctx.workingDir ?? ".",
      timeoutMs,
      env: ctx.state.sandboxEnv as Record<string, string> | undefined,
      signal: ctx.signal,
    });

    if (input.run_in_background === true) {
      // Log file lands in the per-turn output dir when the host provides
      // one (Orkas sets ORKAS_OUTPUT_DIR in the sandbox env), else cwd.
      const sandboxEnv = (ctx.state.sandboxEnv ?? {}) as Record<string, string>;
      const baseDir = sandboxEnv.ORKAS_OUTPUT_DIR || ctx.workingDir || ".";
      const logPath = path.resolve(baseDir, `bg-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}.log`);
      const bg = sandbox.executeBackground(command, logPath);
      if (bg.error || bg.pid == null) {
        return { content: `Failed to start background command: ${bg.error ?? "no pid"}`, isError: true };
      }
      return {
        content: `Started in background.\npid: ${bg.pid}\nlog: ${logPath}\n`
          + `Poll with read_file on the log (or \`tail\` it); stop with \`kill ${bg.pid}\`. `
          + `The process keeps running after this conversation ends.`,
      };
    }

    const stopHeartbeat = startBashHeartbeat(ctx, timeoutMs);
    let result;
    try {
      result = await sandbox.execute(command);
    } finally {
      stopHeartbeat();
    }

    if (result.timedOut) {
      return { content: `Command timed out after ${timeoutMs}ms`, isError: true };
    }

    if (result.exitCode !== 0) {
      const output = result.stderr || result.stdout || `Exit code: ${result.exitCode}`;
      return { content: output, isError: true };
    }

    return { content: result.stdout };
  },
});

function startBashHeartbeat(ctx: ToolContext, timeoutMs: number): () => void {
  if (!ctx.emitProgress) return () => undefined;
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    ctx.emitProgress?.({
      phase: "running",
      message: `Command still running (${formatDuration(elapsedMs)} elapsed; timeout ${formatDuration(timeoutMs)})`,
      data: { elapsedMs, timeoutMs, heartbeat: true },
    });
  }, BASH_PROGRESS_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return `${ms}ms`;
  if (ms >= 60_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms >= 1_000) return `${Math.max(1, Math.round(ms / 1_000))}s`;
  return `${Math.round(ms)}ms`;
}

/** List files in a directory. */
export const listFilesTool: AgentTool = defineTool({
  name: "list_files",
  description: "List files and directories at the given path.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path to list (default: working dir)." },
    },
  },
  async execute(input, ctx) {
    const dirPath = path.resolve(ctx.workingDir ?? ".", (input.path as string) ?? ".");
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const lines = entries.map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`);
      return { content: lines.join("\n") };
    } catch (err) {
      return { content: `Error listing files: ${(err as Error).message}`, isError: true };
    }
  },
});

/** All built-in tools. */
export function getBuiltinTools(): AgentTool[] {
  return [readFileTool, writeFileTool, bashTool, listFilesTool, webFetchTool, webSearchTool];
}
