/**
 * Project instructions tool — writes the project's standing goal + rules
 * (the "Project instructions" block in the system prompt, backed by ORKAS.md).
 *
 * Split out from project_tasks so each project-state layer is ONE focused tool
 * (see plan project-work-state.md):
 *   - project_instructions (here)    = the project's goal + rules
 *   - cross_session_memory (project) = durable facts/decisions/learnings
 *   - project_tasks                  = concrete work items + their STATUS
 *
 * The host injects this tool for the COMMANDER only; sub-agents read the
 * instructions from their system prompt but cannot edit them. All IO is
 * delegated to a host-provided handler — core-agent never touches
 * business-layer files directly.
 */

import type { AgentTool, ToolContext, ToolResult } from "./base.js";

export interface ProjectInstructionsToolHandler {
  /** Replace the project's instructions with `instructions` (full content). */
  set(instructions: string): Promise<{ ok: boolean; error?: string }>;
}

const TOOL_DESCRIPTION = `Replace this project's standing instructions (goal + rules). FULL replace, not append: send all text, preserving what still applies. Use for durable, project-specific direction: goals, scope, rules, preferences, constraints. Global preferences (communication style, identity, tech stack) go to cross_session_memory target "user"; learned project facts and decisions use target "project". Concrete tasks and status go to project_tasks. Make deliberate, reviewable edits.`;

export function createProjectInstructionsTool(handler: ProjectInstructionsToolHandler): AgentTool {
  return {
    name: 'project_instructions',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        instructions: {
          type: 'string',
          description: 'The full new instructions content (goal + rules). Replaces the current instructions.',
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
