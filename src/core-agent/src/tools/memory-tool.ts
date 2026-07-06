/**
 * Cross-session memory tool for the agent.
 *
 * Exposes a single `cross_session_memory` tool that lets the LLM
 * read/write user-wide profile/preferences, shared facts, and the calling
 * agent's own notes across conversations.
 *
 * The tool delegates all IO to a `MemoryToolHandler` injected at
 * construction time — core-agent never touches business-layer files
 * directly.
 */

import type { AgentTool, ToolContext, ToolResult } from "./base.js";

/** Which store a memory op targets. `agent` is bound by the host to the CALLING
 *  agent (the LLM cannot reach another agent's store); `shared`/`user` are
 *  global. */
export type MemoryTier = 'agent' | 'shared' | 'user';

/** Handler interface implemented by the features layer. */
export interface MemoryToolHandler {
  add(tier: MemoryTier, content: string): {
    ok: boolean; error?: string; entries: string[];
    usage: { current: number; limit: number };
  };
  replace(tier: MemoryTier, oldText: string, content: string): {
    ok: boolean; error?: string; entries: string[];
    usage: { current: number; limit: number };
  };
  remove(tier: MemoryTier, oldText: string): {
    ok: boolean; error?: string; entries: string[];
    usage: { current: number; limit: number };
  };
  list(tier: MemoryTier): {
    ok: boolean; entries: string[];
    usage: { current: number; limit: number };
  };
}

const TOOL_DESCRIPTION = `Remember and manage durable cross-session memory.

Three scopes (default "agent"):
- "agent" (DEFAULT): YOUR OWN durable agent memory: lessons, preferences, recurring facts, corrections.
- "shared": durable facts that EVERY agent should know. Use sparingly.
- "user": the user's global profile/preferences.

Use when the user asks to remember something, gives a durable correction/preference, or states a future-relevant fact. Do not save trivia, dumps/logs, rediscoverable facts, one-off state, plans, progress, or temporary debug notes.

Routing: agent-specific lessons -> agent; user identity/style/preferences -> user; repo/project conventions -> shared.

LANGUAGE: Write in the current UI/response language. Preserve proper nouns, commands, file paths, URLs, and exact quoted wording.

Actions: add, replace (by old_text substring), remove (by old_text substring), list.`;

export function createCrossSessionMemoryTool(handler: MemoryToolHandler): AgentTool {
  return {
    name: 'cross_session_memory',
    description: TOOL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove', 'list'],
          description: 'The action to perform.',
        },
        target: {
          type: 'string',
          enum: ['agent', 'shared', 'user'],
          description: 'Which memory store to operate on. Defaults to "agent" (your own notes).',
        },
        content: {
          type: 'string',
          description: 'The entry content (required for "add" and "replace").',
        },
        old_text: {
          type: 'string',
          description: 'Substring to match the existing entry (required for "replace" and "remove").',
        },
      },
      required: ['action'],
    },

    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const action = input.action as string;
      const target = (input.target as MemoryTier) || 'agent';
      const content = (input.content as string) || '';
      const oldText = (input.old_text as string) || '';

      if (target !== 'agent' && target !== 'shared' && target !== 'user') {
        return { content: JSON.stringify({ ok: false, error: 'target must be "agent", "shared", or "user"' }), isError: true };
      }

      let result: ReturnType<MemoryToolHandler['add']>;

      switch (action) {
        case 'add':
          if (!content) return { content: JSON.stringify({ ok: false, error: '"content" is required for add' }), isError: true };
          result = handler.add(target, content);
          break;
        case 'replace':
          if (!oldText) return { content: JSON.stringify({ ok: false, error: '"old_text" is required for replace' }), isError: true };
          if (!content) return { content: JSON.stringify({ ok: false, error: '"content" is required for replace' }), isError: true };
          result = handler.replace(target, oldText, content);
          break;
        case 'remove':
          if (!oldText) return { content: JSON.stringify({ ok: false, error: '"old_text" is required for remove' }), isError: true };
          result = handler.remove(target, oldText);
          break;
        case 'list':
          result = handler.list(target);
          break;
        default:
          return { content: JSON.stringify({ ok: false, error: `unknown action: ${action}` }), isError: true };
      }

      return { content: JSON.stringify(result), isError: !result.ok };
    },
  };
}
