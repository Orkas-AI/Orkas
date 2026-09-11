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

function buildDescription(): string {
  return 'Read or replace this agent\'s persistent competence or strategy notes. '
    + 'Use them for durable corrections, capabilities, limits, or reusable approaches rather than current task progress.';
}

export function createMetacognitionTool(
  handler: MetacognitionToolHandler,
  limits?: { competence?: number; strategies?: number },
): AgentTool {
  return {
    name: 'metacognition',
    description: buildDescription(),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['read', 'write'],
          description: 'read: target only; write: target/content. Omit unrelated fields.',
        },
        target: {
          type: 'string',
          enum: ['competence', 'strategies'],
          description: 'competence stores strengths/limits; strategies stores reusable approaches by task type.',
        },
        content: {
          type: 'string',
          description: 'Required for write; complete replacement condensed as a living summary rather than a log.'
            + (limits?.competence && limits?.strategies
              ? ` Maximum ${limits.competence} characters for competence or ${limits.strategies} for strategies.`
              : ''),
        },
      },
      required: ['action', 'target'],
      oneOf: [
        { properties: { action: { const: 'read' } } },
        { properties: { action: { const: 'write' } }, required: ['content'] },
      ],
    },

    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const action = input.action as string;
      const target = input.target as 'competence' | 'strategies';
      const content = (input.content as string) || '';

      if (action === 'read' && Object.hasOwn(input, 'content')) {
        return {
          content: JSON.stringify({ ok: false, error: 'content is not allowed for read' }),
          isError: true,
        };
      }

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
