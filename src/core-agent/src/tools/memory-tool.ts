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

/** What a write had to discard to stay inside the store's caps. Present only
 *  when the write actually lost something; the host reports it because a
 *  caller that is never told silently loses memory it believes it saved. */
export interface MemoryEvictionReport {
  dropped_entries?: number;
  truncated_entries?: number;
}

/** Handler interface implemented by the features layer. */
export interface MemoryToolHandler {
  add(tier: MemoryTier, content: string): {
    ok: boolean; error?: string; entries: string[];
    usage: { current: number; limit: number };
    evicted?: MemoryEvictionReport;
  };
  replace(tier: MemoryTier, oldText: string, content: string): {
    ok: boolean; error?: string; entries: string[];
    usage: { current: number; limit: number };
    evicted?: MemoryEvictionReport;
  };
  remove(tier: MemoryTier, oldText: string): {
    ok: boolean; error?: string; entries: string[];
    usage: { current: number; limit: number };
    evicted?: MemoryEvictionReport;
  };
  list(tier: MemoryTier): {
    ok: boolean; entries: string[];
    usage: { current: number; limit: number };
  };
}

const TOOL_DESCRIPTION =
  'Read or update durable cross-session memory.';

const TOOL_DESCRIPTION_WITH_PROJECT =
  'Read or update durable agent, project, shared, or user memory; use project_tasks for task progress.';

/** Appended for sub-agents: they may read project memory but not write it. */
const PROJECT_READONLY_NOTE =
  ' Project memory is read-only for this actor; only Commander may add, replace, or remove it.';

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
  const targetDescription = opts.includeProjectTier
    ? 'Defaults to agent: this agent\'s reusable lessons; project: project-specific facts and decisions; user: stable user-wide profile/preferences; shared: rare cross-project facts for every agent.'
      + (projectReadOnly ? ' Project is read-only.' : '')
    : 'Memory store. Defaults to agent: this agent\'s reusable lessons; user: stable user-wide profile/preferences; shared: rare cross-project facts for every agent.';
  return {
    name: 'cross_session_memory',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove', 'list'],
          description: 'Memory operation. Non-empty entries are already injected; use list only to inspect them or obtain exact text for replace/remove.',
        },
        target: {
          type: 'string',
          enum: tiers,
          description: targetDescription,
        },
        content: {
          type: 'string',
          description: 'Entry text; required for add and replace.',
        },
        old_text: {
          type: 'string',
          description: 'Existing entry for replace/remove. Prefer the complete text; a substring must match exactly one entry.',
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
