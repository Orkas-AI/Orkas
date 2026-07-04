import type { ToolDefinition } from "../providers/base.js";

/** Context passed to a tool when it executes. */
export type ToolContext = {
  workingDir?: string;
  signal?: AbortSignal;
  /** Emit user-visible progress while a long-running tool is still executing. */
  emitProgress?: (progress: ToolProgress) => void;
  /** Arbitrary context data tools can read/write. */
  state: Record<string, unknown>;
};

export type ToolProgress = {
  /** Short phase id, e.g. "upload", "poll", "download". */
  phase?: string;
  /** Human-readable status text for the process rail. */
  message: string;
  /** Optional structured metadata for renderers / logs.
   * Set `heartbeat: true` for "still running" keepalive updates that should
   * not reset the runner's tool-idle watchdog. */
  data?: Record<string, unknown>;
};

/** Image content that can ride along with a tool result. */
export type ToolResultImage = {
  /** Base64-encoded bytes (no data: prefix). */
  data: string;
  /** e.g. 'image/jpeg', 'image/png'. */
  mediaType: string;
};

/** Result returned from a tool execution. */
export type ToolResult = {
  content: string;
  /** Optional image payload. Delivered to the model as a user message
   *  immediately following the tool_result message (works across providers
   *  even when the provider's tool_result channel doesn't accept images). */
  images?: ToolResultImage[];
  isError?: boolean;
  /** Terminal tool: end the run after committing this result, WITHOUT a
   *  follow-up inference. The model's text streamed in the same round becomes
   *  the final reply; no synthesis call is made. Used for actions that are the
   *  deliberate last act of a turn — e.g. handing the conversation off to
   *  another agent, where a commander "synthesis" turn would be wasted. */
  endTurn?: boolean;
};

/** A tool that can be called by the agent during an LLM interaction. */
export interface AgentTool {
  /** Tool name (must be unique within an agent run). */
  readonly name: string;
  /** Human-readable description shown to the LLM. */
  readonly description: string;
  /** JSON Schema for the tool's input parameters. */
  readonly inputSchema: Record<string, unknown>;

  /** Whether this tool may run concurrently with ADJACENT same-mode tool
   *  calls in one tool-use batch. Defaults to "sequential". Only
   *  side-effect-free, `ctx.state`-non-mutating tools (read / list / grep /
   *  search / web / kb_read …) should opt into "parallel"; write / edit /
   *  delete / bash / pdf / generate / connector-call / skill tools stay
   *  sequential. Engine-internal — never sent to the model. */
  readonly executionMode?: "sequential" | "parallel";

  /** Execute the tool with the given input. */
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Convert an AgentTool to the provider ToolDefinition format. */
export function toToolDefinition(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name,
    description: compactDescription(tool.description, 480),
    inputSchema: compactSchema(tool.inputSchema),
  };
}

const SCHEMA_DESCRIPTION_MAX_CHARS = 220;
const DROPPED_SCHEMA_KEYS = new Set([
  "$comment",
  "$schema",
  "example",
  "examples",
  "markdownDescription",
]);

function compactSchema(value: Record<string, unknown>): Record<string, unknown> {
  const compacted = compactSchemaValue(value);
  return isRecord(compacted) ? compacted : value;
}

function compactSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchemaValue);
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DROPPED_SCHEMA_KEYS.has(key)) continue;
    if (key === "description" && typeof entry === "string") {
      out[key] = compactDescription(entry, SCHEMA_DESCRIPTION_MAX_CHARS);
    } else {
      out[key] = compactSchemaValue(entry);
    }
  }
  return out;
}

function compactDescription(text: string, maxChars: number): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;

  const sentenceCut = findSentenceBoundary(normalized, maxChars);
  const cut = sentenceCut > Math.floor(maxChars * 0.55) ? sentenceCut : maxChars;
  return `${normalized.slice(0, cut).trimEnd()}...`;
}

function findSentenceBoundary(text: string, before: number): number {
  for (let i = Math.min(before, text.length - 1); i >= 0; i--) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?" || ch === ";" || ch === "\u3002" || ch === "\uff01" || ch === "\uff1f") {
      return i + 1;
    }
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Helper to define a tool inline. */
export function defineTool(opts: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  executionMode?: "sequential" | "parallel";
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}): AgentTool {
  return {
    name: opts.name,
    description: opts.description,
    inputSchema: opts.inputSchema,
    ...(opts.executionMode ? { executionMode: opts.executionMode } : {}),
    execute: opts.execute,
  };
}
