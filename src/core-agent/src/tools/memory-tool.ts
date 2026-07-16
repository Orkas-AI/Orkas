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
 *  agent (the LLM cannot reach another agent's store); `project` is bound to
 *  the conversation's project and only offered inside project sessions;
 *  `shared`/`user` are global. */
export type MemoryTier = 'agent' | 'project' | 'shared' | 'user';

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

/** Base description (non-project sessions): three memory scopes. */
const TOOL_DESCRIPTION = `Remember and manage durable cross-session memory.

Three scopes (default "agent"):
- "agent" (DEFAULT): YOUR OWN durable agent memory: lessons, preferences, recurring task conventions, corrections.
- "shared": durable facts that EVERY agent should know. Use sparingly.
- "user": the user's global profile/preferences.

Use when the user asks to remember something, gives a durable correction/preference, or states a future-relevant fact, decision, outcome, milestone, or convention. Do not save trivia, dumps/logs, rediscoverable facts, the current task's working decisions, one-off state, plans, progress, or temporary debug notes.

Current non-empty memory entries are already present in your system context. Do not call list merely to load or refresh context. Use list only when the user explicitly asks to inspect stored memory or when an exact current entry is needed for replace/remove.

Routing: agent-specific lessons -> agent; user identity/style/preferences -> user; repo/project conventions -> shared.

LANGUAGE: Write in the current UI/response language. Preserve proper nouns, commands, file paths, URLs, and exact quoted wording.

Actions: add, replace (by old_text substring), remove (by old_text substring), list.`;

/** Project-session description: four tiers, routed by where a fact belongs
 *  ("would it still hold in another project?") rather than where it was said. */
const TOOL_DESCRIPTION_WITH_PROJECT = `Manage durable cross-session memory.

Targets:
- agent (default): this agent's private lessons, workflow preferences, recurring task conventions, and corrections.
- project: durable facts, decisions, outcomes, milestones, and conventions that belong to THIS project only.
- shared: stable facts that hold across projects and matter to every agent. Use sparingly.
- user: stable user-wide profile/preferences every agent should know.

Use when the user asks to remember something, gives a durable correction/preference, or states a future-relevant fact. Do not save trivia, raw dumps/logs, rediscoverable facts, the current task's working decisions, one-off task state, plans, progress, or temporary debug notes. Live progress and todo status belong in project_tasks.

Current non-empty entries for these targets are already present in your system context. Do not call list merely to load or refresh context. Use list only when the user explicitly asks to inspect stored memory or when an exact current entry is needed for replace/remove.

Routing — ask "would this still hold in another project?":
- No / project-specific -> project.
- Yes, an objective fact any agent may need -> shared.
- Yes, the user's own identity/style/preferences -> user.
- Yes, but only this agent benefits (its own working lessons) -> agent.
Write in the user's current language while preserving code, paths, commands, URLs, and exact quoted wording when needed.

Actions: add, replace (by old_text substring), remove (by old_text substring), list.`;

/** Appended for sub-agents: they may read project memory but not write it. */
const PROJECT_READONLY_NOTE = `

NOTE — project memory is READ-ONLY for you: it is already present in your system context when non-empty. Do not list it merely to reload context. You may use "list" when an exact current entry is required, but only the commander (the project's main conversation) can add/replace/remove project entries. When you learn a project-specific fact or decision worth keeping, surface it in your result so the commander can record it — do not try to write the "project" target yourself.`;

export interface CrossSessionMemoryToolOptions {
  /** Offer the `project` tier (project sessions only). The host binds it to
   *  the conversation's project; outside a project the tier is absent from
   *  the schema so the model cannot select it. */
  includeProjectTier?: boolean;
  /** When the `project` tier is offered but the caller may only READ it (list),
   *  not write. Sub-agents get this; only the commander writes project memory.
   *  Ignored unless `includeProjectTier`. */
  projectTierReadOnly?: boolean;
}

export function createCrossSessionMemoryTool(handler: MemoryToolHandler, opts: CrossSessionMemoryToolOptions = {}): AgentTool {
  const tiers: MemoryTier[] = opts.includeProjectTier
    ? ['agent', 'project', 'shared', 'user']
    : ['agent', 'shared', 'user'];
  const projectReadOnly = !!opts.includeProjectTier && !!opts.projectTierReadOnly;
  const description = opts.includeProjectTier
    ? TOOL_DESCRIPTION_WITH_PROJECT + (projectReadOnly ? PROJECT_READONLY_NOTE : '')
    : TOOL_DESCRIPTION;
  return {
    name: 'cross_session_memory',
    description,
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
          enum: tiers,
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

      if (!tiers.includes(target)) {
        return { content: JSON.stringify({ ok: false, error: `target must be one of: ${tiers.map(t => `"${t}"`).join(', ')}` }), isError: true };
      }

      if (projectReadOnly && target === 'project' && action !== 'list') {
        return { content: JSON.stringify({ ok: false, error: 'project memory is read-only for you; only the commander can add/replace/remove project entries' }), isError: true };
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
