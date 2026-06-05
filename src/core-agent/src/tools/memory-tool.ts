/**
 * Cross-session memory tool for the agent.
 *
 * Exposes a single `cross_session_memory` tool that lets the LLM
 * read/write a per-user MEMORY.md (agent notes) and USER.md (user profile)
 * across conversations.
 *
 * The tool delegates all IO to a `MemoryToolHandler` injected at
 * construction time — core-agent never touches business-layer files
 * directly.
 */

import type { AgentTool, ToolContext, ToolResult } from "./base.js";

/** Handler interface implemented by the features layer. */
export interface MemoryToolHandler {
  add(target: 'memory' | 'user', content: string): {
    ok: boolean; error?: string; entries: string[];
    usage: { current: number; limit: number };
  };
  replace(target: 'memory' | 'user', oldText: string, content: string): {
    ok: boolean; error?: string; entries: string[];
    usage: { current: number; limit: number };
  };
  remove(target: 'memory' | 'user', oldText: string): {
    ok: boolean; error?: string; entries: string[];
    usage: { current: number; limit: number };
  };
  list(target: 'memory' | 'user'): {
    ok: boolean; entries: string[];
    usage: { current: number; limit: number };
  };
}

const TOOL_DESCRIPTION = `Manage your persistent cross-session memory. This memory survives across conversations.

Two targets:
- "memory": Your personal notes (facts, decisions, milestones, project conventions).
- "user": User profile (role, preferences, communication style, tech stack).

WHEN TO SAVE:
- User explicitly says "remember this" or "note that"
- User corrections or preferences (highest priority)
- Durable decisions or milestones that will still matter in future conversations (NOT the current task's working decisions)
- User's role, expertise, or communication preferences (→ target "user")
- Stable project conventions or environment facts

WHEN TO SKIP:
- Trivial or obvious information
- Easily re-discoverable facts
- Raw data dumps, code blocks, or logs
- Session-specific ephemera or the current task's state: temporary debug info, one-off questions, and your plan / progress / status this session — what you are doing, have done, or still need to do (e.g. "X is updated, but Y still needs checking"). Memory is for durable facts about the user and project, not work-in-progress.

Actions: "add" (append new entry), "replace" (update existing by substring match), "remove" (delete by substring match), "list" (view current entries).`;

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
          enum: ['memory', 'user'],
          description: 'Which memory store to operate on.',
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
      required: ['action', 'target'],
    },

    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const action = input.action as string;
      const target = input.target as 'memory' | 'user';
      const content = (input.content as string) || '';
      const oldText = (input.old_text as string) || '';

      if (target !== 'memory' && target !== 'user') {
        return { content: JSON.stringify({ ok: false, error: 'target must be "memory" or "user"' }), isError: true };
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
