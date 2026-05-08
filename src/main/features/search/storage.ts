/**
 * Index file IO: load + atomic save.
 *
 * Schema (JSON, one file per kind):
 *   {
 *     "version":  2,
 *     "kind":     "context" | "chat",
 *     "files":    { "<fileKey>": { "mtime": number, "size": number } },
 *     "docs":     { "<docId>":   { kind, fileKey, ...kindFields, len } },
 *     "postings": { "<token>":   [[docId, tf], ...] }
 *   }
 *
 * The shape is intentionally hand-rollable JSON — no FTS engine, no native
 * dep. Reconciliation by mtime+size makes this self-healing if an edit
 * happens out-of-band (sync, manual touch). `skill_chat` / `agent_chat`
 * kinds existed in earlier builds; their .idx.json files are now stale and
 * unlinked at startup by `reconcileAll` in features/search/index.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
const fsp = fs.promises;

// v2 adds `doc._tokens` (unique token list) so drops are O(tokens-in-doc)
// instead of O(tokens-in-idx).
// v3 drops body tokens from the `context` kind — contexts are indexed by
// relPath (directory + filename) only; content lookup goes through the
// vector KB. Bumping the version forces old body-tokenized indexes to
// rebuild on next reconcile.
// v4 fixes the chat indexer's silent skip on group-chat jsonl — `_msgText`
// only read the legacy `content` field, missing the current `text` field
// (and `from`/`ts` for role/time). Indexes built by v3 against post-bus
// jsonl have empty docs (every message skipped); bumping forces a rebuild
// so existing users get their chat history searchable again on next launch
// (the alternative — leaving v3 — would only fix newly-modified jsonl files
// because reconcile keys off mtime+size, not schema correctness).
export const SCHEMA_VERSION = 4;

export type IndexKind = 'context' | 'chat';

export interface FileMeta { mtime: number; size: number }

export interface Doc {
  kind: IndexKind;
  fileKey: string;
  len: number;
  [extra: string]: unknown;
}

export type Postings = Record<string, Array<[string, number]>>;

export interface Index {
  version: number;
  kind: IndexKind;
  files: Record<string, FileMeta>;
  docs: Record<string, Doc>;
  postings: Postings;
}

export function emptyIndex(kind: IndexKind): Index {
  return {
    version: SCHEMA_VERSION,
    kind,
    files: Object.create(null),
    docs: Object.create(null),
    postings: Object.create(null),
  };
}

export async function loadIndex(idxPath: string, kind: IndexKind): Promise<Index> {
  try {
    const raw = await fsp.readFile(idxPath, 'utf8');
    const idx = JSON.parse(raw);
    if (idx && idx.version === SCHEMA_VERSION && idx.kind === kind) {
      idx.files    = idx.files    || Object.create(null);
      idx.docs     = idx.docs     || Object.create(null);
      idx.postings = idx.postings || Object.create(null);
      return idx as Index;
    }
  } catch { /* missing / corrupt / wrong schema — caller rebuilds */ }
  return emptyIndex(kind);
}

export async function saveIndex(idxPath: string, idx: Index): Promise<void> {
  await fsp.mkdir(path.dirname(idxPath), { recursive: true });
  const tmp = idxPath + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(idx), 'utf8');
  await fsp.rename(tmp, idxPath);
}
