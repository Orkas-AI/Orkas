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
import { createHash } from "node:crypto";

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

export interface MemoryHandlerResult {
  ok: boolean; error?: string; entries: string[];
  changed?: boolean;
  usage: { current: number; limit: number };
  evicted?: MemoryEvictionReport;
}

/** Hosts may consolidate asynchronously before committing a memory write. */
export interface MemoryToolHandler {
  add(tier: MemoryTier, content: string, signal?: AbortSignal): MemoryHandlerResult | Promise<MemoryHandlerResult>;
  replace(tier: MemoryTier, oldText: string, content: string, signal?: AbortSignal): MemoryHandlerResult | Promise<MemoryHandlerResult>;
  remove(tier: MemoryTier, oldText: string): MemoryHandlerResult;
  list(tier: MemoryTier): MemoryHandlerResult;
}

const TOOL_DESCRIPTION =
  'Manage durable agent, shared, or user memory. Call this tool before replying whenever the conversation establishes, corrects, or invalidates stable, reusable information that should affect future conversations—even without an explicit save request. Decide from meaning, never trigger words. Do not store current-task progress, temporary plans, one-off status, or TODO/dependency state.';

const TOOL_DESCRIPTION_WITH_PROJECT =
  'Manage durable agent, project, shared, or user memory. Call this tool before replying whenever the conversation establishes, corrects, or invalidates stable, reusable information that should affect future conversations—even without an explicit save request. Decide from meaning, never trigger words. Use todo_tasks for task progress; do not store temporary plans, one-off status, or TODO/dependency state.';

/** Appended for sub-agents: they may read project memory but not write it. */
const PROJECT_READONLY_NOTE =
  ' Project memory is read-only in this session; Commander can change it.';

export interface CrossSessionMemoryToolOptions {
  /** Offer the `project` tier (project sessions only). The host binds it to
   *  the conversation's project; outside a project the tier is absent from
   *  the schema so the model cannot select it. */
  includeProjectTier?: boolean;
  /** When the `project` tier is offered but the caller may only READ it (list),
   *  not write. Sub-agents get this; only the commander writes project memory.
   *  Ignored unless `includeProjectTier`. */
  projectTierReadOnly?: boolean;
  /** Only Commander may mutate account-global user/shared memory. */
  globalTiersReadOnly?: boolean;
}

type MemoryAction = 'add' | 'replace' | 'remove' | 'list';

const MEMORY_ACTION_FIELDS: Readonly<Record<MemoryAction, ReadonlySet<string>>> = {
  add: new Set(['action', 'target', 'content']),
  replace: new Set(['action', 'target', 'content', 'old_text']),
  remove: new Set(['action', 'target', 'old_text']),
  list: new Set(['action', 'target']),
};

export function createCrossSessionMemoryTool(handler: MemoryToolHandler, opts: CrossSessionMemoryToolOptions = {}): AgentTool {
  const tiers: MemoryTier[] = opts.includeProjectTier
    ? ['agent', 'project', 'shared', 'user']
    : ['agent', 'shared', 'user'];
  const projectReadOnly = !!opts.includeProjectTier && !!opts.projectTierReadOnly;
  const description = opts.globalTiersReadOnly
    ? 'Manage durable memory by its intended scope, not write access. Save stable facts, corrections or invalidations for future conversations before replying, even without a save request; exclude task progress and temporary state. User/shared writes belong to Commander: hand back those changes without substituting or duplicating them in another store. Decide from meaning, never trigger words.'
      + (projectReadOnly ? PROJECT_READONLY_NOTE : '')
    : opts.includeProjectTier
    ? TOOL_DESCRIPTION_WITH_PROJECT + (projectReadOnly ? PROJECT_READONLY_NOTE : '')
    : TOOL_DESCRIPTION;
  const targetDescription = opts.globalTiersReadOnly
    ? 'Defaults to agent: Agent-only reusable lessons; user: user-wide preferences; shared: cross-project facts. User/shared allow list only.'
      + (opts.includeProjectTier ? ` Project: current-project facts${projectReadOnly ? ', read-only' : ''}.` : '')
    : opts.includeProjectTier
    ? 'Defaults to agent: this agent\'s reusable lessons; project: project-specific facts and decisions; user: stable user-wide profile/preferences; shared: rare cross-project facts for every agent.'
      + (projectReadOnly ? ' Project is read-only.' : '')
    : 'Memory store. Defaults to agent: this agent\'s reusable lessons; user: stable user-wide profile/preferences; shared: rare cross-project facts for every agent.';
  return {
    name: 'cross_session_memory',
    description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove', 'list'],
          description: 'add: content; replace: old_text/content; remove: old_text; list: no content fields. target is optional. Omit unrelated fields. Non-empty entries are already injected; use list only for exact text.',
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
      const target = input.target === undefined ? 'agent' : input.target as MemoryTier;
      const content = typeof input.content === 'string' ? input.content : '';
      const oldText = typeof input.old_text === 'string' ? input.old_text : '';

      const allowedFields = MEMORY_ACTION_FIELDS[action as MemoryAction];
      if (allowedFields) {
        const unrelated = Object.keys(input).filter((key) => !['action', 'target', 'content', 'old_text'].includes(key));
        if (unrelated.length) {
          return {
            content: JSON.stringify({ ok: false, error: `fields not allowed for ${action}: ${unrelated.sort().join(', ')}` }),
            isError: true,
          };
        }
      }

      if (action === 'add' && input.old_text != null && (typeof input.old_text !== 'string' || input.old_text.trim())) {
        return { content: JSON.stringify({ ok: false, error: 'add cannot match old_text; use replace to change an existing entry' }), isError: true };
      }

      if (!tiers.includes(target)) {
        return { content: JSON.stringify({ ok: false, error: `target must be one of: ${tiers.map(t => `"${t}"`).join(', ')}` }), isError: true };
      }

      if (projectReadOnly && target === 'project' && action !== 'list') {
        return { content: JSON.stringify({ ok: false, error: 'project memory is read-only for you; only the commander can add/replace/remove project entries' }), isError: true };
      }

      if (opts.globalTiersReadOnly && (target === 'user' || target === 'shared') && action !== 'list') {
        return { content: JSON.stringify({ ok: false, error: 'user/shared memory is read-only for you; only Commander may write it' }), isError: true };
      }

      let result: MemoryHandlerResult;

      switch (action) {
        case 'add':
          if (!content.trim()) return { content: JSON.stringify({ ok: false, error: '"content" is required for add' }), isError: true };
          result = await handler.add(target, content, _ctx.signal);
          break;
        case 'replace':
          if (!oldText.trim()) return { content: JSON.stringify({ ok: false, error: '"old_text" is required for replace' }), isError: true };
          if (!content.trim()) return { content: JSON.stringify({ ok: false, error: '"content" is required for replace' }), isError: true };
          result = await handler.replace(target, oldText, content, _ctx.signal);
          break;
        case 'remove':
          if (!oldText.trim()) return { content: JSON.stringify({ ok: false, error: '"old_text" is required for remove' }), isError: true };
          result = handler.remove(target, oldText);
          break;
        case 'list':
          result = handler.list(target);
          break;
        default:
          return { content: JSON.stringify({ ok: false, error: `unknown action: ${action}` }), isError: true };
      }

      return {
        content: JSON.stringify(result), isError: !result.ok,
        ...(result.ok && (action === 'add' || action === 'replace') && typeof result.changed === 'boolean'
          ? { observations: { stateMutation: {
              scope: target,
              version: createHash('sha256').update(JSON.stringify(result.entries)).digest('hex'),
              changed: result.changed,
            } } } : {}),
      };
    },
  };
}
