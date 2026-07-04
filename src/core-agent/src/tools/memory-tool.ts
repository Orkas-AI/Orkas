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

const TOOL_DESCRIPTION = `Manage your persistent cross-session memory. This memory survives across conversations.

Three scopes (default "agent"):
- "agent" (DEFAULT): YOUR OWN durable agent memory — preferences for how this agent should work, task-domain conventions, reusable lessons, and facts/decisions specific to what you do. Other agents do NOT see these, and you do NOT see theirs. Use this for most saves in a specific-agent conversation.
- "shared": durable facts that EVERY agent should know — project/environment facts, cross-cutting decisions, repo layout, shared conventions. Use sparingly because it lands in every agent's context.
- "user": the user's global profile/preferences — identity, role, expertise, broad preferences, communication style, or tech stack that should follow the user across every agent.

TARGET ROUTING:
- If the user says "remember this", "note this", or corrects how YOU should work while talking to a specific agent, use target "agent" unless they clearly say it should apply globally.
- Use target "user" only for stable user-wide preferences/profile facts every agent should know: identity, broad preferences, communication style, expertise, or tech stack.
- Use target "shared" only for stable non-user facts every agent should know: project/environment facts, shared decisions, shared conventions, or repo/workspace facts.
- Never put agent-specific lessons, output preferences, workflow corrections, or task-domain conventions into target "user" or "shared".

LANGUAGE:
- Write new or replaced entries in the user's current UI/response language.
- If the remembered fact was stated in another language, translate/summarize it into the current UI/response language before saving.
- Preserve proper nouns, commands, file paths, code identifiers, URLs, and quoted user wording when exact text matters.

WHEN TO SAVE:
- User explicitly says "remember this" or "note that"
- User corrections or preferences (highest priority)
- Durable decisions or milestones that will still matter in future conversations (NOT the current task's working decisions)
- User's role, expertise, or global communication preferences (→ target "user")
- Stable project conventions or environment facts (→ target "shared")
- This agent's reusable working preferences, recurring task facts, output corrections, or domain lessons (→ target "agent")

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
