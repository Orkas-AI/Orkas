/**
 * Conversation workspace file listing for the info side panel.
 *
 * The chat history only records files that passed through chip-producing
 * tools (`write_file`, `edit_file`, PDF/image generators). Real runs often
 * create batches through `bash` or CLI agents, so the panel needs a cheap
 * disk snapshot of the conversation workspace as the source of truth.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { macosTccSensitivePath } from '../util/macos-tcc';

export interface ConversationWorkspaceFile {
  path: string;
  relPath: string;
  name: string;
  bytes: number;
  mtime: number;
}

export interface ConversationWorkspaceFileList {
  root: string;
  items: ConversationWorkspaceFile[];
  count: number;
  truncated: boolean;
  rootExists: boolean;
  scanSkipped?: boolean;
  skipReason?: string;
}

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_DEPTH = 12;

function toPosixRel(rel: string): string {
  return rel.split(path.sep).filter(Boolean).join('/');
}

export function listWorkspaceFiles(
  root: string,
  opts: { maxFiles?: number; maxDepth?: number } = {},
): ConversationWorkspaceFileList {
  const rootAbs = path.resolve(root || '');
  const maxFiles = Math.max(1, Math.floor(opts.maxFiles ?? DEFAULT_MAX_FILES));
  const maxDepth = Math.max(0, Math.floor(opts.maxDepth ?? DEFAULT_MAX_DEPTH));
  const items: ConversationWorkspaceFile[] = [];
  let truncated = false;

  const protectedRoot = macosTccSensitivePath(rootAbs, { recursive: true });
  if (protectedRoot) {
    return {
      root: rootAbs,
      items,
      count: 0,
      truncated: false,
      rootExists: true,
      scanSkipped: true,
      skipReason: protectedRoot.reason,
    };
  }

  let rootStat: fs.Stats;
  try { rootStat = fs.statSync(rootAbs); }
  catch {
    return { root: rootAbs, items, count: 0, truncated: false, rootExists: false };
  }
  if (!rootStat.isDirectory()) {
    return { root: rootAbs, items, count: 0, truncated: false, rootExists: false };
  }

  const walk = (dir: string, depth: number): void => {
    if (items.length >= maxFiles) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) {
      truncated = true;
      return;
    }

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        walk(abs, depth + 1);
        if (items.length >= maxFiles) {
          truncated = true;
          return;
        }
      } else if (e.isFile()) {
        let st: fs.Stats;
        try { st = fs.statSync(abs); }
        catch { continue; }
        items.push({
          path: abs,
          relPath: toPosixRel(path.relative(rootAbs, abs)),
          name: e.name,
          bytes: st.size,
          mtime: Math.floor(st.mtimeMs),
        });
        if (items.length >= maxFiles) {
          truncated = true;
          return;
        }
      }
    }
  };

  walk(rootAbs, 0);
  return { root: rootAbs, items, count: items.length, truncated, rootExists: true };
}
