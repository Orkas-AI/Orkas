/**
 * Project instructions tool — writes the project's standing goal + rules
 * (the "Project instructions" block in the system prompt, backed by ORKAS.md).
 *
 * Split out from todo_tasks so each project-state layer is ONE focused tool
 * (see plan project-work-state.md):
 *   - project_instructions (here)    = the project's goal + rules
 *   - cross_session_memory (project) = durable facts/decisions/learnings
 *   - todo_tasks                  = concrete work items + their STATUS
 *
 * The host injects this tool for authorized project actors. All IO is
 * delegated to a host-provided handler — core-agent never touches
 * business-layer files directly.
 */

import type { AgentTool, ToolContext, ToolResult } from "./base.js";

export interface ProjectInstructionsToolHandler {
  /** Replace the project's instructions with `instructions` (full content). */
  set(instructions: string): Promise<{ ok: boolean; error?: string }>;
}

const TOOL_DESCRIPTION =
  'Replace the project\'s standing goal and rules with the complete supplied text. Preserve applicable existing content; use todo_tasks for work status and project memory for durable facts or decisions.';

export function createProjectInstructionsTool(handler: ProjectInstructionsToolHandler): AgentTool {
  return {
    name: 'project_instructions',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        instructions: {
          type: 'string',
          description: 'Complete replacement goal/rules text, including any existing content that still applies.',
        },
      },
      required: ['instructions'],
    },

    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const instructions = typeof input.instructions === 'string' ? input.instructions : '';
      if (!instructions.trim()) {
        return { content: JSON.stringify({ ok: false, error: '"instructions" is required' }), isError: true };
      }
      try {
        const r = await handler.set(instructions);
        return { content: JSON.stringify(r), isError: !r.ok };
      } catch (err) {
        return { content: JSON.stringify({ ok: false, error: (err as Error)?.message || String(err) }), isError: true };
      }
    },
  };
}
