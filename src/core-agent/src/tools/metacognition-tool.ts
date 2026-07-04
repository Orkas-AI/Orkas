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
          `CONTENT LIMITS (hard cap; oversize writes are REJECTED — not truncated):`,
          `- competence: ${compLimit} characters`,
          `- strategies: ${stratLimit} characters`,
          '',
          `The file is a living summary, not a log. When approaching the limit,`,
          `CONDENSE before adding: merge related bullets, drop stale items, keep`,
          `the most actionable insights. A "read" before "write" returns the`,
          `current usage so you know the remaining budget.`,
        ].join('\n')
      : '';

  return `Manage your metacognitive self-assessment and learning strategies. These persist across conversations.

Two targets:
- "competence": Your self-assessment — what you're good at, known weaknesses, learning priorities.
- "strategies": Your learning strategies library — which approaches work best for which tasks.

WHEN TO UPDATE COMPETENCE:
- After succeeding at a previously weak area → note the improvement
- After user corrections → note the weakness
- After discovering a new capability or limitation
- Periodically review and update priorities

WHEN TO UPDATE STRATEGIES:
- After discovering that a learning approach works well or poorly
- After trying a new approach to skill creation
- To record which strategy types suit which task categories

Actions: "read" (view current content), "write" (replace entire content).
Content is free-form markdown. Structure with ## headings for different sections.
Language: when the host prompt specifies a user/UI language, write human-readable metacognition content in that language while preserving code, file paths, commands, and exact quoted wording.${limitBlock}`;
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
