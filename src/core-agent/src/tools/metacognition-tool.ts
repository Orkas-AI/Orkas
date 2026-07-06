/**
 * Metacognition tool for the agent.
 *
 * Exposes a `metacognition` tool that lets the LLM read/write its own
 * self-assessment (COMPETENCE.md) and learning strategies
 * (LEARNING_STRATEGIES.md).
 *
 * Follows the same handler-injection pattern as `memory-tool.ts` —
 * core-agent never touches business-layer files directly.
 */

import type { AgentTool, ToolContext, ToolResult } from "./base.js";

/** Handler interface implemented by the features layer. */
export interface MetacognitionToolHandler {
  read(target: 'competence' | 'strategies'): {
    ok: boolean; content: string;
    usage: { current: number; limit: number };
  };
  write(target: 'competence' | 'strategies', content: string): {
    ok: boolean; error?: string;
    usage: { current: number; limit: number };
  };
}

function buildDescription(limits?: { competence?: number; strategies?: number }): string {
  const compLimit = limits?.competence;
  const stratLimit = limits?.strategies;
  const limitBlock =
    compLimit && stratLimit
      ? [
          '',
          `CONTENT LIMITS (oversize writes are rejected):`,
          `- competence: ${compLimit} characters`,
          `- strategies: ${stratLimit} characters`,
          `REJECTED writes must be shortened; CONDENSE these files into living summaries, not logs.`,
        ].join('\n')
      : '';

  return `Read or replace this agent's persistent metacognition notes.

Targets:
- competence: strengths, weaknesses, limits, and learning priorities.
- strategies: which learning/work approaches help for which task types.

Update after meaningful user corrections, newly discovered capabilities/limits, or useful strategy lessons. Skip routine task progress. Action "write" replaces the whole markdown file; read first if you need current content/usage. Use the user's current language for prose and preserve code, paths, commands, and quoted wording.${limitBlock}`;
}

export function createMetacognitionTool(
  handler: MetacognitionToolHandler,
  limits?: { competence?: number; strategies?: number },
): AgentTool {
  return {
    name: 'metacognition',
    description: buildDescription(limits),
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write'],
          description: 'The action to perform.',
        },
        target: {
          type: 'string',
          enum: ['competence', 'strategies'],
          description: 'Which metacognition store to operate on.',
        },
        content: {
          type: 'string',
          description: 'The new content (required for "write"). Replaces entire file.',
        },
      },
      required: ['action', 'target'],
    },

    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const action = input.action as string;
      const target = input.target as 'competence' | 'strategies';
      const content = (input.content as string) || '';

      if (target !== 'competence' && target !== 'strategies') {
        return {
          content: JSON.stringify({ ok: false, error: 'target must be "competence" or "strategies"' }),
          isError: true,
        };
      }

      switch (action) {
        case 'read': {
          const result = handler.read(target);
          return { content: JSON.stringify(result), isError: false };
        }
        case 'write': {
          if (!content.trim()) {
            return {
              content: JSON.stringify({ ok: false, error: '"content" is required for write' }),
              isError: true,
            };
          }
          const result = handler.write(target, content);
          return { content: JSON.stringify(result), isError: !result.ok };
        }
        default:
          return {
            content: JSON.stringify({ ok: false, error: `unknown action: ${action}` }),
            isError: true,
          };
      }
    },
  };
}
