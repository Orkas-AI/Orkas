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
};

/** A tool that can be called by the agent during an LLM interaction. */
export interface AgentTool {
  /** Tool name (must be unique within an agent run). */
  readonly name: string;
  /** Human-readable description shown to the LLM. */
  readonly description: string;
  /** JSON Schema for the tool's input parameters. */
  readonly inputSchema: Record<string, unknown>;

  /** Execute the tool with the given input. */
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Convert an AgentTool to the provider ToolDefinition format. */
export function toToolDefinition(tool: AgentTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/** Helper to define a tool inline. */
export function defineTool(opts: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}): AgentTool {
  return {
    name: opts.name,
    description: opts.description,
    inputSchema: opts.inputSchema,
    execute: opts.execute,
  };
}
