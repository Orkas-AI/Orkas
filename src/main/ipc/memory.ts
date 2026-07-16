/**
 * IPC handlers for the cross-session memory UI. Renderer reaches these via
 * `window.orkas.invoke('memory.*', …)` (see preload's generic invoke).
 *
 *   memory.list        → { entries, usage:{current,limit}, path }     (one scope)
 *   memory.add         → MemoryOpResult                               (scanned + deduped + truncated by features/memory.ts)
 *   memory.replace     → MemoryOpResult
 *   memory.remove      → MemoryOpResult
 *   memory.exportInfo  → { dir, files:{ user, shared, agents:[{agentId,…}] } }
 *   memory.reveal      → { ok }                                       (showItemInFolder, path resolved server-side from scope)
 *   memory.importParse → { items:[{ text, target, kind, threat }] }   (advisory classifier; user confirms before merge)
 *
 * Scope payload: `{ target: 'user' | 'shared' | 'agent', agentId? }`. Legacy
 * `target:'memory'` still maps to the shared store. The renderer never supplies
 * a filesystem path (reveal resolves from scope; user scoping comes from
 * `ctx.userId`). This is a VIEW over `features/memory.ts` — it never
 * re-implements limits/separator/scanner/dedup. See PC/CLAUDE.md §3.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { shell } from 'electron';
import * as memory from '../features/memory';
import * as projects from '../features/projects';
import type { MemoryScope } from '../features/memory';
import { userMemoryFile, userProfileFile, userMemoryDir, agentMemoryFile, projectMemoryFile } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('ipc:memory');

/** Build a MemoryScope from the renderer payload. 'shared' (new) and 'memory'
 *  (legacy) both map to the shared store; 'agent' needs an agentId and
 *  'project' a projectId. */
function normScope(payload: any): MemoryScope {
  const tier = payload?.target;
  if (tier === 'user') return 'user';
  if (tier === 'agent') {
    const agentId = String(payload?.agentId || '').trim();
    if (!agentId) throw new Error('agentId is required for an agent-scoped memory op');
    return { agent: agentId };
  }
  if (tier === 'project') {
    const projectId = String(payload?.projectId || '').trim();
    if (!projectId) throw new Error('projectId is required for a project-scoped memory op');
    return { project: projectId };
  }
  return 'memory'; // 'shared' | 'memory' | default
}

function fileForScope(userId: string, scope: MemoryScope): string {
  if (scope === 'user') return userProfileFile(userId);
  if (scope === 'memory') return userMemoryFile(userId);
  if ('project' in scope) return projectMemoryFile(userId, scope.project);
  return agentMemoryFile(userId, scope.agent);
}

/** Resolve and authorize a renderer-supplied scope before any memory read or
 * write. Path construction performs the segment validation; the ownership
 * check prevents a valid-looking but stale/foreign project id from creating an
 * orphan `projects/<pid>/MEMORY.md` directory. */
async function resolveScope(userId: string, payload: any): Promise<MemoryScope> {
  const scope = normScope(payload);
  fileForScope(userId, scope);
  if (typeof scope === 'object' && 'project' in scope
      && !(await projects.projectExists(userId, scope.project))) {
    throw new Error('project_not_found');
  }
  return scope;
}

function exportFileInfo(userId: string, scope: MemoryScope) {
  const filePath = fileForScope(userId, scope);
  const { entries } = memory.listEntries(userId, scope);
  const copyText = entries.join('\n\n');
  let size = Buffer.byteLength(entries.join(memory.ENTRY_SEPARATOR), 'utf8');
  try {
    size = fs.statSync(filePath).size;
  } catch {
    /* file not written yet — fall back to the in-memory byte length */
  }
  return { path: filePath, count: entries.length, size, raw: copyText };
}

/** Agent ids that already have a memory dir on disk (drives the UI's per-agent tabs). */
function listAgentScopes(userId: string): string[] {
  try {
    return fs.readdirSync(path.join(userMemoryDir(userId), 'agents'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export const invokeHandlers = {
  'memory.list': async (payload: any, ctx: any) => {
    const scope = await resolveScope(ctx.userId, payload);
    const res = memory.listEntries(ctx.userId, scope);
    return { ...res, path: fileForScope(ctx.userId, scope) };
  },

  'memory.add': async (payload: any, ctx: any) => {
    return memory.addEntry(ctx.userId, await resolveScope(ctx.userId, payload), String(payload?.content || ''));
  },

  'memory.replace': async (payload: any, ctx: any) => {
    return memory.replaceEntry(
      ctx.userId,
      await resolveScope(ctx.userId, payload),
      String(payload?.oldText || ''),
      String(payload?.content || ''),
    );
  },

  'memory.remove': async (payload: any, ctx: any) => {
    return memory.removeEntry(ctx.userId, await resolveScope(ctx.userId, payload), String(payload?.oldText || ''));
  },

  'memory.exportInfo': async (_payload: any, ctx: any) => ({
    dir: userMemoryDir(ctx.userId),
    files: {
      user: exportFileInfo(ctx.userId, 'user'),
      shared: exportFileInfo(ctx.userId, 'memory'),
      agents: listAgentScopes(ctx.userId).map((agentId) => ({
        agentId,
        ...exportFileInfo(ctx.userId, { agent: agentId }),
      })),
    },
  }),

  'memory.reveal': async (payload: any, ctx: any) => {
    // Path is resolved here from the scope — the renderer never supplies a
    // path, so there's no arbitrary-reveal surface.
    const filePath = fileForScope(ctx.userId, await resolveScope(ctx.userId, payload));
    try {
      fs.statSync(filePath);
    } catch {
      // Nothing written yet — reveal the containing dir instead of a dead path.
      const err = await shell.openPath(userMemoryDir(ctx.userId));
      if (err) { log.warn(`reveal openPath dir: ${err}`); return { ok: false, error: err }; }
      return { ok: true };
    }
    shell.showItemInFolder(filePath);
    return { ok: true };
  },

  'memory.importParse': async (payload: any) => ({
    items: memory.parseImportText(String(payload?.text || '')),
  }),
};
