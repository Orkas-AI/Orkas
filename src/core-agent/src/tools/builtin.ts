import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { defineTool, type AgentTool, type ToolContext } from "./base.js";
import { SandboxExecutor } from "../sandbox/executor.js";
import {
  discardStreamedToolOutput,
  type StreamedToolOutput,
} from "../sandbox/output-capture.js";
import { applyPatchTool } from "./apply-patch.js";
import { getProcessSessionTools } from "./process-session.js";
import { workspaceDiffTool } from "./workspace-diff.js";
import { webFetchTool } from "./web-fetch.js";
import { webSearchTool } from "./web-search.js";

/** Read a file from the filesystem. */
export const readFileTool: AgentTool = defineTool({
  name: "read_file",
  description:
    "Read a text file or bounded line range. lineStart/lineEnd are 1-based inclusive; maxLines remains supported for reads from the first or selected line.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path to read." },
      maxLines: { type: "number", description: "Maximum number of lines to return (optional)." },
      lineStart: { type: "number", description: "Optional 1-based first line, inclusive." },
      lineEnd: { type: "number", description: "Optional 1-based last line, inclusive." },
    },
    required: ["path"],
  },
  async execute(input, ctx) {
    const filePath = path.resolve(ctx.workingDir ?? ".", input.path as string);
    try {
      const fullContent = await fs.readFile(filePath, "utf-8");
      const hash = textFileHash(fullContent);
      let content = fullContent;
      const lineStartValue = Number(input.lineStart);
      const lineEndValue = Number(input.lineEnd);
      const hasLineStart = Number.isFinite(lineStartValue);
      const hasLineEnd = Number.isFinite(lineEndValue);
      const maxLines = input.maxLines as number | undefined;
      let observedLineRange: [number, number] | undefined;
      if (hasLineStart || hasLineEnd || (maxLines && maxLines > 0)) {
        const lines = fullContent.split("\n");
        const start = Math.min(
          Math.max(1, lines.length),
          hasLineStart ? Math.max(1, Math.trunc(lineStartValue)) : 1,
        );
        const boundedByMax = maxLines && maxLines > 0
          ? start + Math.max(1, Math.trunc(maxLines)) - 1
          : Number.POSITIVE_INFINITY;
        const end = Math.min(
          lines.length,
          hasLineEnd ? Math.max(start, Math.trunc(lineEndValue)) : boundedByMax,
        );
        content = lines.slice(start - 1, end).join("\n");
        observedLineRange = [start, end];
        if (end < lines.length) {
          content += `\n... (${lines.length - end} more lines)`;
        }
      }
      return {
        content,
        observations: {
          fileReads: [{
            path: filePath,
            hash,
            ...(observedLineRange ? { lineRange: observedLineRange } : {}),
          }],
        },
      };
    } catch (err) {
      return { content: `Error reading file: ${(err as Error).message}`, isError: true };
    }
  },
});

const READ_FILES_MAX_ITEMS = 20;
const READ_FILES_MAX_OUTPUT_CHARS = 160_000;

/** Read several related text files in one bounded, parallel tool call. */
export const readFilesTool: AgentTool = defineTool({
  name: "read_files",
  description:
    "Read several related text files or line ranges in one bounded call. Each item accepts path plus optional 1-based lineStart/lineEnd or maxLines.",
  inputSchema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        minItems: 1,
        maxItems: READ_FILES_MAX_ITEMS,
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Absolute or working-directory-relative file path." },
            maxLines: { type: "number", description: "Optional maximum lines for this file." },
            lineStart: { type: "number", description: "Optional 1-based first line, inclusive." },
            lineEnd: { type: "number", description: "Optional 1-based last line, inclusive." },
          },
          required: ["path"],
        },
      },
    },
    required: ["files"],
  },
  executionMode: "parallel",
  async execute(input, ctx) {
    if (!Array.isArray(input.files) || input.files.length === 0) {
      return { content: "E_BAD_INPUT: `files` must be a non-empty array", isError: true };
    }
    if (input.files.length > READ_FILES_MAX_ITEMS) {
      return {
        content: `E_BAD_INPUT: read_files accepts at most ${READ_FILES_MAX_ITEMS} files per call`,
        isError: true,
      };
    }
    const requests = input.files.map((entry) => (
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? entry as Record<string, unknown>
        : {}
    ));
    if (requests.some((entry) => typeof entry.path !== "string" || !entry.path)) {
      return { content: "E_BAD_INPUT: every read_files item requires a non-empty `path`", isError: true };
    }

    const results = await Promise.all(requests.map((request) => readFileTool.execute(request, ctx)));
    let remaining = READ_FILES_MAX_OUTPUT_CHARS;
    let truncated = false;
    const blocks = results.map((result, index) => {
      const requestedPath = String(requests[index].path);
      const prefix = `<read-result index="${index}" path="${requestedPath}" ok="${result.isError ? "false" : "true"}">\n`;
      const suffix = "\n</read-result>";
      const available = Math.max(0, remaining - prefix.length - suffix.length);
      let body = result.content;
      if (body.length > available) {
        body = `${body.slice(0, Math.max(0, available - 80))}\n...[batch output limit reached]`;
        truncated = true;
      }
      const block = `${prefix}${body}${suffix}`;
      remaining = Math.max(0, remaining - block.length);
      return block;
    });
    const errors = results.filter((result) => result.isError).length;
    return {
      content:
        `<read-files count="${results.length}" errors="${errors}" truncated="${truncated}">\n`
        + `${blocks.join("\n")}\n</read-files>`,
      ...(errors === results.length ? { isError: true } : {}),
      observations: {
        fileReads: results.flatMap((result) => result.observations?.fileReads ?? []),
      },
    };
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
      let beforeContent: string | undefined;
      try { beforeContent = await fs.readFile(filePath, "utf8"); } catch { /* new file */ }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const afterContent = input.content as string;
      await fs.writeFile(filePath, afterContent, "utf-8");
      return {
        content: `File written: ${filePath}`,
        observations: {
          fileChanges: [{
            operation: beforeContent === undefined ? "create" : "update",
            sourcePath: filePath,
            beforeExists: beforeContent !== undefined,
            afterExists: true,
            ...(beforeContent !== undefined
              ? {
                  beforeContent,
                  beforeHash: textFileHash(beforeContent),
                  beforeBytes: Buffer.byteLength(beforeContent),
                }
              : {}),
            afterContent,
            afterHash: textFileHash(afterContent),
            afterBytes: Buffer.byteLength(afterContent),
            coverage: "exact",
          }],
        },
      };
    } catch (err) {
      return { content: `Error writing file: ${(err as Error).message}`, isError: true };
    }
  },
});

function textFileHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

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
        description: "Run detached and return immediately with pid + log path. Use for long builds, renders, downloads, or servers. Poll by reading the log; stop with `kill <pid>`. It keeps running after the conversation ends.",
      },
    },
    required: ["command"],
  },
  async execute(input, ctx) {
    const command = input.command as string;
    const timeoutMs = normalizeBashTimeoutMs(input.timeoutMs);
    const sandboxAllowedDirs = Array.isArray(ctx.state.sandboxAllowedDirs)
      ? ctx.state.sandboxAllowedDirs.filter((v): v is string => typeof v === "string" && v.length > 0)
      : undefined;

    const sandbox = new SandboxExecutor({
      workingDir: ctx.workingDir ?? ".",
      timeoutMs,
      env: ctx.state.sandboxEnv as Record<string, string> | undefined,
      allowedDirs: sandboxAllowedDirs,
      signal: ctx.signal,
      ...(typeof ctx.state.toolResultSpoolDir === "string"
        ? { outputSpoolDir: ctx.state.toolResultSpoolDir }
        : {}),
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

    const status = result.startFailed
      ? "start_failed" as const
      : result.timedOut
        ? "timed_out" as const
        : result.outputLimitExceeded
          ? "output_limit" as const
          : result.exitCode === 0
            ? "succeeded" as const
            : "failed" as const;
    const streamedOutput = await aggregateCommandStreams(result);
    return {
      content: renderCommandResult(result, status),
      ...(streamedOutput ? { streamedOutput } : {}),
      observations: {
        execution: {
          status,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          outputLimitExceeded: result.outputLimitExceeded,
          stdout: {
            bytes: result.stdoutBytes,
            truncated: !!result.stdoutStreamedOutput,
          },
          stderr: {
            bytes: result.stderrBytes,
            truncated: !!result.stderrStreamedOutput,
          },
        },
      },
      ...(status !== "succeeded" ? { isError: true } : {}),
    };
  },
});

type CommandCapture = Awaited<ReturnType<SandboxExecutor["execute"]>>;

function renderCommandResult(
  result: CommandCapture,
  status: "succeeded" | "failed" | "timed_out" | "output_limit" | "start_failed",
): string {
  const header =
    `<command-result status="${status}" exit_code="${result.exitCode ?? "null"}" `
    + `duration_ms="${result.durationMs}" timed_out="${result.timedOut}" `
    + `output_limit_exceeded="${result.outputLimitExceeded}" `
    + `stdout_bytes="${result.stdoutBytes}" stderr_bytes="${result.stderrBytes}">`;
  const sections = [header];
  if (result.stdout) sections.push(`<stdout>\n${result.stdout}\n</stdout>`);
  if (result.stderr) sections.push(`<stderr>\n${result.stderr}\n</stderr>`);
  if (!result.stdout && !result.stderr) sections.push("[no command output]");
  sections.push("</command-result>");
  return sections.join("\n");
}

async function aggregateCommandStreams(result: CommandCapture): Promise<StreamedToolOutput | undefined> {
  const stdoutStream = result.stdoutStreamedOutput;
  const stderrStream = result.stderrStreamedOutput;
  if (!stdoutStream && !stderrStream) return undefined;
  const source = stdoutStream ?? stderrStream!;
  const target = path.join(
    path.dirname(source.path),
    `command-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}.log`,
  );
  const output = createWriteStream(target, { flags: "wx" });
  const write = async (chunk: string | Buffer) => {
    if (!output.write(chunk)) await once(output, "drain");
  };
  const copy = async (streamed: StreamedToolOutput | undefined, fallback: string) => {
    if (!streamed) {
      await write(fallback);
      return;
    }
    for await (const chunk of createReadStream(streamed.path)) {
      await write(chunk as Buffer);
    }
  };
  try {
    await write("--- stdout ---\n");
    await copy(stdoutStream, result.stdout);
    await write("\n--- stderr ---\n");
    await copy(stderrStream, result.stderr);
    output.end();
    await once(output, "finish");
    const stat = await fs.stat(target);
    discardStreamedToolOutput(stdoutStream);
    discardStreamedToolOutput(stderrStream);
    return {
      path: target,
      size: stat.size,
      sourceTruncated: !!stdoutStream?.sourceTruncated || !!stderrStream?.sourceTruncated,
    };
  } catch {
    output.destroy();
    try { await fs.rm(target, { force: true }); } catch { /* best effort */ }
    if (stdoutStream) {
      discardStreamedToolOutput(stderrStream);
      return stdoutStream;
    }
    return stderrStream;
  }
}

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
  return [
    readFileTool,
    readFilesTool,
    writeFileTool,
    applyPatchTool,
    bashTool,
    ...getProcessSessionTools(),
    workspaceDiffTool,
    listFilesTool,
    webFetchTool,
    webSearchTool,
  ];
}
