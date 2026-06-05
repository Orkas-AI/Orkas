/**
 * IPC handlers for the cross-session memory UI. Renderer reaches these via
 * `window.orkas.invoke('memory.*', …)` (see preload's generic invoke).
 *
 *   memory.list        → { entries, usage:{current,limit}, path }     (one target)
 *   memory.add         → MemoryOpResult                               (scanned + deduped + truncated by features/memory.ts)
 *   memory.replace     → MemoryOpResult
 *   memory.remove      → MemoryOpResult
 *   memory.exportInfo  → { dir, files:{ user:{…}, memory:{…} } }      (path + count + size + raw copy text)
 *   memory.reveal      → { ok }                                       (showItemInFolder, path resolved server-side from target)
 *   memory.importParse → { items:[{ text, target, kind, threat }] }   (advisory classifier; user confirms before merge)
 *
 * This is a VIEW over `features/memory.ts` — it never re-implements the char
 * limits, separator, scanner, or dedup/truncate logic, and it never accepts a
 * filesystem path from the renderer (reveal is by `target`; user scoping comes
 * from `ctx.userId`). See PC/CLAUDE.md §3.
 */
import * as fs from 'node:fs';
import { shell } from 'electron';
import * as memory from '../features/memory';
import { userMemoryFile, userProfileFile, userMemoryDir } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('ipc:memory');

type Target = 'memory' | 'user';

function normTarget(t: unknown): Target {
  return t === 'memory' ? 'memory' : 'user';
}

function fileForTarget(userId: string, target: Target): string {
  return target === 'memory' ? userMemoryFile(userId) : userProfileFile(userId);
}

function exportFileInfo(userId: string, target: Target) {
  const filePath = fileForTarget(userId, target);
  const { entries } = memory.listEntries(userId, target);
  const copyText = entries.join('\n\n');
  let size = Buffer.byteLength(entries.join(memory.ENTRY_SEPARATOR), 'utf8');
  try {
    size = fs.statSync(filePath).size;
  } catch {
    /* file not written yet — fall back to the in-memory byte length */
  }
  return { path: filePath, count: entries.length, size, raw: copyText };
}

export const invokeHandlers = {
  'memory.list': async (payload: any, ctx: any) => {
    const target = normTarget(payload?.target);
    const res = memory.listEntries(ctx.userId, target);
    return { ...res, path: fileForTarget(ctx.userId, target) };
  },

  'memory.add': async (payload: any, ctx: any) => {
    const target = normTarget(payload?.target);
    return memory.addEntry(ctx.userId, target, String(payload?.content || ''));
  },

  'memory.replace': async (payload: any, ctx: any) => {
    const target = normTarget(payload?.target);
    return memory.replaceEntry(
      ctx.userId,
      target,
      String(payload?.oldText || ''),
      String(payload?.content || ''),
    );
  },

  'memory.remove': async (payload: any, ctx: any) => {
    const target = normTarget(payload?.target);
    return memory.removeEntry(ctx.userId, target, String(payload?.oldText || ''));
  },

  'memory.exportInfo': async (_payload: any, ctx: any) => ({
    dir: userMemoryDir(ctx.userId),
    files: {
      user: exportFileInfo(ctx.userId, 'user'),
      memory: exportFileInfo(ctx.userId, 'memory'),
    },
  }),

  'memory.reveal': async (payload: any, ctx: any) => {
    // Path is resolved here from the target — the renderer never supplies a
    // path, so there's no arbitrary-reveal surface.
    const target = normTarget(payload?.target);
    const filePath = fileForTarget(ctx.userId, target);
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
