import { defineTool, type AgentTool, type ToolContext, type ToolResult } from "./base.js";
import type { WorkspaceDiffRequest } from "../agent/workspace-state.js";

export const WORKSPACE_DIFF_PROVIDER_STATE_KEY = "workspaceDiffProvider";

export type WorkspaceDiffProvider = (
  request: WorkspaceDiffRequest,
  ctx: ToolContext,
) => ToolResult | Promise<ToolResult>;

/** Read-only view over the deterministic Session workspace ledger. The
 * provider is injected by AgentRunner through ToolContext.state so this tool
 * remains part of the normal builtin surface without binding global state. */
export const workspaceDiffTool: AgentTool = defineTool({
  name: "workspace_diff",
  description:
    "Show the bounded net file changes observed from agent tools. Defaults to the current user turn and unified text diff; use summary or paths to narrow output. This is read-only and does not require Git.",
  inputSchema: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["turn", "session"],
        description: "Current user turn (default) or all retained session observations.",
      },
      format: {
        type: "string",
        enum: ["summary", "unified"],
        description: "summary for file status only; unified (default) for bounded text diffs.",
      },
      paths: {
        type: "array",
        maxItems: 32,
        items: { type: "string" },
        description: "Optional absolute or working-directory-relative paths to include.",
      },
      max_chars: {
        type: "number",
        description: "Bounded output size, 1000-120000 characters. Default 50000.",
      },
    },
  },
  executionMode: "parallel",
  async execute(input, ctx) {
    const provider = ctx.state[WORKSPACE_DIFF_PROVIDER_STATE_KEY];
    if (typeof provider !== "function") {
      return {
        content: "E_WORKSPACE_DIFF_UNAVAILABLE: this runner did not provide a workspace change ledger",
        isError: true,
      };
    }
    return (provider as WorkspaceDiffProvider)(input as WorkspaceDiffRequest, ctx);
  },
});
