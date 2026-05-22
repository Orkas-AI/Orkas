/**
 * One-shot data migration: strip the legacy brand prefix from session jsonl
 * filenames.
 *
 * Older builds wrote session_ids as `<brand>-<uid>-<kind>-<tail>`; the
 * current canonical form is `<uid>-<kind>-<tail>` (no brand prefix, so any
 * future fork or rename can't break history again).
 *
 * Migration strategy:
 *   1. Scan `<uid>/cloud/sessions/*.jsonl`
 *   2. Match `^<legacy-prefix>-<uid>-(.+)\.jsonl$` and rename to
 *      `<uid>-$1.jsonl`
 *   3. Already-new-format files are skipped
 *   4. Same-name conflicts (extremely rare — in theory there should not
 *      be two copies of one sid) are log.warn'd and skipped for manual
 *      handling
 *   5. `<uid>/local/.migrations` is stamped with a single line
 *      `decouple-session-id-from-brand-v1` to prevent re-runs
 *
 * Legacy kinds (`organizer` / `sub` / `conv`) aren't on the whitelist, but
 * since the migration only looks at the prefix and not the kind, those
 * sessions also get the prefix stripped. Their jsonl content is still
 * valid (users can open old group-chat history); new code just no
 * longer generates those kinds.
 * One-shot data migration: strip any prefix segments before the kind keyword from session_id —
 * both in jsonl filenames AND in stored references inside `_index.json` / `chat.json` —
 * normalising every shape to `<kind>-<tail>` (CLAUDE.md §5 — uid no longer in session_id).
 *
 * Why touch the index files too: `cloud/chats/_index.json` and per-agent / per-skill
 * `chat.json` persist the conversation's session_id. Renaming jsonl files alone is not enough;
 * the next time the user opens an old conversation, `chats.ts` reads `conv.session_id` from
 * the index, hands it to session-store, and a fresh dashed-name jsonl gets created — the rename
 * undoes itself within minutes. The migration must rewrite these stored references too.
 *
 * Handles every legacy shape we've ever shipped:
 *   - `aiteam-gconv-cv1` (brand prefix from the v0 codename)
 *   - `orkas-gconv-cv1`  (brand prefix from the rename)
 *   - `99999999-gconv-cv1` (8-digit numeric uid prefix)
 *   - `D69594E0-CF31-…-E3A9-gconv-cv1` (UUID uid prefix; OAuth user_id form)
 *   - `aiteam-99999999-gconv-cv1` (double prefix — brand + uid)
 * All collapse to `gconv-cv1`. Files / fields already in `<kind>-…` form are left untouched.
 *
 * Same-name conflicts during file rename are log.warn'd and the source file is preserved.
 * `<uid>/local/.migrations` is stamped with `MIGRATION_TAG` so the rename never reruns.
 *
 * Scan covers `<uid>/cloud/sessions/`, `<uid>/local/sessions/`, `cloud/chats/_index.json`,
 * `cloud/chats/agent/<aid>/chat.json`, and `cloud/chats/skill/<sid>/chat.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  userSessionsDir,
  userLocalSessionsDir,
  userLocalConfigDir,
  userChatsDir,
} from '../paths';
import { createLogger } from '../logger';

const log = createLogger('migrate');

// v2 (bumped from v1) re-runs the migration on machines already stamped, picking up two new
// fixes: (a) chats/_index.json + chat/{agent,skill}/<id>/chat.json session_id fields are
// rewritten so the next conv-open doesn't recreate the dashed jsonl; (b) the file rename
// scan also covers local/sessions/ (was cloud-only in v1).
const MIGRATION_TAG = 'drop-session-id-uid-prefix-v2';

/** Strip any prefix segments BEFORE a known kind keyword. The lookahead anchors on the kind +
 *  the boundary that follows it (`-` for kinds-with-tail, `$` for kinds-without-tail like
 *  `anon` standalone). The lazy `.+?-` matches the smallest prefix that lets the lookahead
 *  succeed. Order in the alternation: longest first so `extract-img` matches whole, not as
 *  `extract` + leftover. */
const FILENAME_PREFIX_RE =
  /^.+?-(?=(?:gmember|gconv|memory-extract|extract-img|reflect|skill|agent|anon|cli|sub|organizer|conv)(?:-|\.jsonl$))/;
const SID_PREFIX_RE =
  /^.+?-(?=(?:gmember|gconv|memory-extract|extract-img|reflect|skill|agent|anon|cli|sub|organizer|conv)(?:-|$))/;

function migrationsFile(uid: string): string {
  // userLocalConfigDir = <uid>/local/config; up one to <uid>/local/
  return path.join(path.dirname(userLocalConfigDir(uid)), '.migrations');
}

function alreadyApplied(uid: string): boolean {
  const f = migrationsFile(uid);
  if (!fs.existsSync(f)) return false;
  try {
    const content = fs.readFileSync(f, 'utf8');
    return content.split('\n').some((line) => line.trim() === MIGRATION_TAG);
  } catch {
    return false;
  }
}

function stamp(uid: string): void {
  const f = migrationsFile(uid);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, MIGRATION_TAG + '\n', 'utf8');
}

interface MigrationStats {
  scanned: number;
  renamed: number;
  alreadyMigrated: number;
  conflicts: number;
  /** Number of session_id fields rewritten across all index / chat.json files. */
  fieldsRewritten: number;
}

function migrateOneDir(dir: string, stats: MigrationStats): void {
  if (!fs.existsSync(dir)) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    log.warn(`readdir failed ${dir}: ${(err as Error).message}`);
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    stats.scanned += 1;
    const newName = name.replace(FILENAME_PREFIX_RE, '');
    if (newName === name) {
      // Already in `<kind>-<tail>.jsonl` form — no prefix to strip.
      stats.alreadyMigrated += 1;
      continue;
    }
    const src = path.join(dir, name);
    const dst = path.join(dir, newName);
    if (fs.existsSync(dst)) {
      log.warn(`migration conflict: ${newName} already exists at ${dir}, preserving ${name} for triage`);
      stats.conflicts += 1;
      continue;
    }
    try {
      fs.renameSync(src, dst);
      stats.renamed += 1;
    } catch (err) {
      log.warn(`rename failed ${src} → ${dst}: ${(err as Error).message}`);
    }
  }
}

/** Strip any uid/brand prefix from a session_id string. Returns the input unchanged when no
 *  prefix is present. */
function _stripSidPrefix(sid: unknown): { sid: string; changed: boolean } | null {
  if (typeof sid !== 'string' || !sid) return null;
  const stripped = sid.replace(SID_PREFIX_RE, '');
  return { sid: stripped, changed: stripped !== sid };
}

/** Rewrite session_id fields inside `cloud/chats/_index.json` (array of conv records). */
function migrateChatsIndex(uid: string, stats: MigrationStats): void {
  const file = path.join(userChatsDir(uid), '_index.json');
  if (!fs.existsSync(file)) return;
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { log.warn(`read _index.json: ${(err as Error).message}`); return; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) { log.warn(`parse _index.json: ${(err as Error).message}`); return; }
  if (!Array.isArray(parsed)) return;
  let touched = 0;
  for (const row of parsed) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const result = _stripSidPrefix(r.session_id);
    if (result?.changed) {
      r.session_id = result.sid;
      touched += 1;
    }
  }
  if (touched === 0) return;
  try {
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
    stats.fieldsRewritten += touched;
  } catch (err) {
    log.warn(`write _index.json: ${(err as Error).message}`);
  }
}

/** Rewrite session_id field inside a `chat.json` (per-agent or per-skill edit chat meta). */
function migrateChatMeta(file: string, stats: MigrationStats): void {
  if (!fs.existsSync(file)) return;
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { log.warn(`read ${file}: ${(err as Error).message}`); return; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (err) { log.warn(`parse ${file}: ${(err as Error).message}`); return; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const obj = parsed as Record<string, unknown>;
  const result = _stripSidPrefix(obj.session_id);
  if (!result?.changed) return;
  obj.session_id = result.sid;
  try {
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
    stats.fieldsRewritten += 1;
  } catch (err) {
    log.warn(`write ${file}: ${(err as Error).message}`);
  }
}

/** Walk `cloud/chats/{agent,skill}/<id>/chat.json` and rewrite the session_id field in each. */
function migrateAgentSkillChatMetas(uid: string, stats: MigrationStats): void {
  const chatsRoot = userChatsDir(uid);
  for (const sub of ['agent', 'skill']) {
    const root = path.join(chatsRoot, sub);
    if (!fs.existsSync(root)) continue;
    let entries: string[];
    try { entries = fs.readdirSync(root); }
    catch (err) { log.warn(`readdir ${root}: ${(err as Error).message}`); continue; }
    for (const id of entries) {
      const meta = path.join(root, id, 'chat.json');
      migrateChatMeta(meta, stats);
    }
  }
}

/**
 * Run the migration for one uid. Idempotent: a previously-stamped uid is a no-op. Safe to
 * call on every boot (invoked by `features/users.activateUser`).
 */
export function migrateLegacySessionIds(uid: string): MigrationStats {
  const stats: MigrationStats = { scanned: 0, renamed: 0, alreadyMigrated: 0, conflicts: 0, fieldsRewritten: 0 };
  if (alreadyApplied(uid)) {
    return stats;
  }

  // Files first — rename jsonls before we touch the indexes that reference them.
  migrateOneDir(userSessionsDir(uid), stats);
  migrateOneDir(userLocalSessionsDir(uid), stats);
  // Then rewrite the stored session_id references so reads don't reanimate the old shape.
  migrateChatsIndex(uid, stats);
  migrateAgentSkillChatMetas(uid, stats);

  stamp(uid);
  if (stats.renamed || stats.conflicts || stats.fieldsRewritten) {
    log.info(
      `session id migration done uid=${uid} renamed=${stats.renamed} ` +
      `fieldsRewritten=${stats.fieldsRewritten} conflicts=${stats.conflicts} ` +
      `alreadyMigrated=${stats.alreadyMigrated}`,
    );
  }
  return stats;
}
