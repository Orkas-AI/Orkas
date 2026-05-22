/**
 * "My Apps" — user-kept copies of `create_artifact` interactive web apps.
 *
 * An artifact created in chat lives in `<uid>/cloud/chat_artifacts/<cid>/<id>/`
 * and is purged when the conversation is deleted. The artifact card's `⋯` →
 * "Save" copies the bundle into a new persistent pool here:
 *   `<uid>/cloud/saved_apps/<appId>/{index.html, ...siblings, __orkas-meta.json}`
 * Cloud-synced; conversation-independent; never auto-purged (only the user's
 * explicit delete from the My Apps tab removes one). The files are served
 * read-only by being opened in the system browser via `shell.openPath` on
 * `index.html` (a `file://` view — same mechanism as the artifact card's
 * "open in browser"; the `chat-app://` protocol and `__orkas/bridge.js` are
 * NOT involved here).
 *
 * Guard rails: `safeAppId` rejects separators / traversal names; the source
 * dir is resolved through `chatArtifacts.resolveArtifactDir` (which reuses the
 * artifact pool's safe-cid / safe-artifactId checks); `resolveSavedAppIndex`
 * runs a `path.relative` traversal guard before handing a path to the IPC
 * layer for `shell.openPath`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { userSavedAppsDir, savedAppDir } from '../paths';
import * as chatArtifacts from './chat_artifacts';
import * as chats from './chats';
import * as chatAttachments from './chat_attachments';
import { t } from '../i18n';
import { createLogger } from '../logger';

const log = createLogger('saved_apps');

const META_FILENAME = '__orkas-meta.json';
const MAX_TITLE_LEN = 120;
const DEFAULT_TITLE = 'Interactive app';

// Source files that go into the editing bundle verbatim (everything in an
// artifact's served-extension set that is text). Anything else (png / woff /
// wasm / …) becomes a one-line `[binary asset …]` placeholder — it can't be
// represented in a text `.md` bundle, and changing it means re-supplying it
// via `create_artifact` with `"encoding":"base64"` anyway.
const TEXT_LIKE_EXTS: ReadonlySet<string> = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.xml', '.txt', '.csv',
]);
const SOURCE_BUNDLE_NAME = 'app-source.md';

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

export interface SavedAppMeta {
  title: string;
  sourceCid: string;
  sourceArtifactId: string;
  savedAt: string; // ISO
}

export interface SavedAppListItem {
  id: string;
  title: string;
  savedAt: string;
  sourceCid: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function safeAppId(id: unknown): string {
  if (typeof id !== 'string' || !id) throw new Error('appId required');
  // Generated ids are base64url (alphanumerics + `-` + `_`); never allow
  // separators / dots / NUL.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid appId');
  return id;
}

function sanitiseTitle(t: unknown): string {
  if (typeof t === 'string') {
    const s = t.trim();
    if (s) return s.slice(0, MAX_TITLE_LEN);
  }
  return DEFAULT_TITLE;
}

function writeMeta(dir: string, meta: SavedAppMeta): void {
  fs.writeFileSync(path.join(dir, META_FILENAME), Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
}

// ── Public API ───────────────────────────────────────────────────────────

/** Copy a chat artifact bundle into a new `saved_apps/<appId>/`. */
export function saveFromArtifact(userId: string, cid: string, artifactId: string): Result<{ id: string; title: string }> {
  const resolved = chatArtifacts.resolveArtifactDir(userId, cid, artifactId);
  if (!resolved.ok) return { ok: false, error: (resolved as { error?: string }).error || 'artifact not found' };
  const srcDir = (resolved as { dirPath: string }).dirPath;

  const srcMeta = chatArtifacts.readArtifactMeta(userId, cid, artifactId);
  const title = sanitiseTitle(srcMeta?.title);

  // Mint a free appId (collisions are astronomically unlikely with 9 random
  // bytes; a few retries cost nothing).
  let appId = '';
  let destDir = '';
  for (let i = 0; i < 5; i++) {
    const candidate = crypto.randomBytes(9).toString('base64url'); // 12 url-safe chars
    const d = savedAppDir(userId, candidate);
    if (!fs.existsSync(d)) { appId = candidate; destDir = d; break; }
  }
  if (!appId) return { ok: false, error: 'could not allocate an app id' };

  const tmpDir = `${destDir}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  try {
    // Copy everything except the source `__orkas-meta.json` (we write a fresh
    // one stamped with the source provenance).
    fs.cpSync(srcDir, tmpDir, {
      recursive: true,
      filter: (src) => path.basename(src) !== META_FILENAME,
    });
    if (!fs.existsSync(path.join(tmpDir, 'index.html'))) {
      throw new Error('source artifact is missing index.html');
    }
    const meta: SavedAppMeta = {
      title,
      sourceCid: typeof cid === 'string' ? cid : '',
      sourceArtifactId: typeof artifactId === 'string' ? artifactId : '',
      savedAt: new Date().toISOString(),
    };
    writeMeta(tmpDir, meta);
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.renameSync(tmpDir, destDir);
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    log.warn(`saveFromArtifact failed user=${userId} cid=${cid} artifact=${artifactId}: ${(err as Error).message}`);
    return { ok: false, error: `failed to save app: ${(err as Error).message}` };
  }
  log.info(`saveFromArtifact user=${userId} appId=${appId} <- cid=${cid} artifact=${artifactId}`);
  return { ok: true, id: appId, title };
}

/** List the user's saved apps, sorted A→Z by title (CLAUDE.md §8 inventory rule). */
export function listSavedApps(userId: string): SavedAppListItem[] {
  const root = userSavedAppsDir(userId);
  let names: string[];
  try { names = fs.readdirSync(root); }
  catch { return []; } // pool dir not created yet
  const items: SavedAppListItem[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    let appId: string;
    try { appId = safeAppId(name); } catch { continue; }
    const dir = savedAppDir(userId, appId);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    let meta: Partial<SavedAppMeta> = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILENAME), 'utf8')) || {}; }
    catch (err) { log.warn(`listSavedApps: bad meta for ${appId}: ${(err as Error).message}`); }
    items.push({
      id: appId,
      title: typeof meta.title === 'string' && meta.title.trim() ? meta.title : DEFAULT_TITLE,
      savedAt: typeof meta.savedAt === 'string' ? meta.savedAt : '',
      sourceCid: typeof meta.sourceCid === 'string' ? meta.sourceCid : '',
    });
  }
  items.sort((a, b) =>
    (a.title || a.id).localeCompare(b.title || b.id, undefined, { sensitivity: 'base', numeric: true }));
  return items;
}

/** Resolve a saved app's `index.html` absolute path (for `shell.openPath`).
 *  `code` maps to HTTP the same way the artifact resolvers' does. */
export function resolveSavedAppIndex(
  userId: string,
  appId: string,
): { ok: true; absPath: string } | { ok: false; code: 'bad_input' | 'not_found'; error: string } {
  let safeId: string;
  try { safeId = safeAppId(appId); }
  catch (err) { return { ok: false, code: 'bad_input', error: (err as Error).message }; }
  const root = path.resolve(savedAppDir(userId, safeId));
  const abs = path.resolve(root, 'index.html');
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'bad_input', error: 'path traversal blocked' };
  }
  let st: fs.Stats;
  try { st = fs.statSync(abs); }
  catch { return { ok: false, code: 'not_found', error: 'app not found' }; }
  if (!st.isFile()) return { ok: false, code: 'not_found', error: 'app not found' };
  return { ok: true, absPath: abs };
}

/** Rename a saved app (rewrites `__orkas-meta.json`). */
export function renameSavedApp(userId: string, appId: string, title: unknown): Result<{ title: string }> {
  let safeId: string;
  try { safeId = safeAppId(appId); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'title required' };
  const dir = savedAppDir(userId, safeId);
  let meta: SavedAppMeta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILENAME), 'utf8')); }
  catch (err) { return { ok: false, error: `app not found: ${(err as Error).message}` }; }
  meta.title = sanitiseTitle(title);
  try { writeMeta(dir, meta); }
  catch (err) { return { ok: false, error: `failed to rename: ${(err as Error).message}` }; }
  log.info(`renameSavedApp user=${userId} appId=${safeId} title=${JSON.stringify(meta.title)}`);
  return { ok: true, title: meta.title };
}

/** Delete a saved app (`rm -rf saved_apps/<appId>/`). */
export function deleteSavedApp(userId: string, appId: string): Result {
  let safeId: string;
  try { safeId = safeAppId(appId); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  const dir = savedAppDir(userId, safeId);
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn(`deleteSavedApp(${safeId}): ${(err as Error).message}`);
    return { ok: false, error: `failed to delete: ${(err as Error).message}` };
  }
  log.info(`deleteSavedApp user=${userId} appId=${safeId}`);
  return { ok: true };
}

// ── "Edit in a new conversation" ─────────────────────────────────────────

/** Recursively list a saved app's file paths (relative to its dir), sorted. */
function listAppFilesRel(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(childRel);
      else if (e.isFile()) out.push(childRel);
    }
  };
  walk('');
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/** Build the single-`.md` source bundle handed to the editing conversation as
 *  an attachment. Plain `FILE:` rules (not fenced code blocks) so the app's own
 *  source — which may contain ``` — can't break the bundle. Binary assets are
 *  represented as placeholder lines (a text bundle can't carry their bytes). */
function buildSourceBundle(dir: string, title: string): string {
  const files = listAppFilesRel(dir).filter((rel) => rel !== META_FILENAME);
  const lines: string[] = [
    `# Interactive app source — "${title}"`,
    '',
    'This is the current source of a self-contained interactive web app (originally produced by the `create_artifact` tool). To modify it: read the files below, then call `create_artifact` again with the updated `files` array — it must still include a top-level `index.html`, the app runs offline (inline your CSS/JS or reference sibling files by relative URL), and the result is embedded in a sandboxed iframe.',
    '',
  ];
  for (const rel of files) {
    const abs = path.join(dir, rel);
    lines.push(`========== FILE: ${rel} ==========`);
    if (TEXT_LIKE_EXTS.has(path.extname(rel).toLowerCase())) {
      let content = '<could not read this file>';
      try { content = fs.readFileSync(abs, 'utf8'); } catch { /* keep placeholder */ }
      lines.push(content);
    } else {
      let kb = 1;
      try { kb = Math.max(1, Math.round(fs.statSync(abs).size / 1024)); } catch { /* ignore */ }
      lines.push(`[binary asset: ${rel} — ~${kb} KB; kept from the original app. To change it, re-supply it via create_artifact with "encoding":"base64".]`);
    }
    lines.push('');
  }
  lines.push('========== END ==========');
  lines.push('');
  return lines.join('\n');
}

/**
 * Open a saved app for editing: create a fresh normal conversation, drop the
 * app's source in as a single `app-source.md` attachment, and return the conv
 * so the renderer can navigate to it + pre-fill a draft. On any failure after
 * the conversation is created, the half-built conversation is deleted so no
 * orphan is left behind. "Edit" is a fork-and-modify flow — the conversation's
 * `create_artifact` produces a new artifact; the original saved app is
 * untouched.
 */
export async function openForEditing(
  userId: string,
  appId: string,
): Promise<Result<{ conversation: unknown; title: string; sourceFileName: string }>> {
  let safeId: string;
  try { safeId = safeAppId(appId); }
  catch (err) { return { ok: false, error: (err as Error).message }; }
  const dir = savedAppDir(userId, safeId);
  try { if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory'); }
  catch { return { ok: false, error: 'app not found' }; }
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    return { ok: false, error: 'app is missing index.html' };
  }

  let title = DEFAULT_TITLE;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, META_FILENAME), 'utf8'));
    if (m && typeof m.title === 'string' && m.title.trim()) title = m.title;
  } catch { /* fallback */ }

  const bundle = buildSourceBundle(dir, title);

  let conv: Awaited<ReturnType<typeof chats.createConversation>>;
  try {
    conv = await chats.createConversation(userId, {
      kind: 'normal',
      title: t('apps.edit_conv_title', { name: title }),
    });
  } catch (err) {
    log.warn(`openForEditing: createConversation failed user=${userId} appId=${safeId}: ${(err as Error).message}`);
    return { ok: false, error: `failed to create a conversation: ${(err as Error).message}` };
  }

  const up = await chatAttachments.uploadAttachment(userId, conv.conversation_id, SOURCE_BUNDLE_NAME, Buffer.from(bundle, 'utf8'));
  if (!up.ok) {
    // Roll back the conversation we just created so no empty conv is orphaned.
    try { await chats.deleteConversation(userId, conv.conversation_id); }
    catch (err) { log.warn(`openForEditing: rollback deleteConversation failed: ${(err as Error).message}`); }
    return { ok: false, error: (up as { error?: string }).error || 'failed to attach the app source' };
  }
  const sourceFileName = ((up as { info?: { name?: string } }).info?.name) || SOURCE_BUNDLE_NAME;
  log.info(`openForEditing user=${userId} appId=${safeId} -> cid=${conv.conversation_id} source=${sourceFileName}`);
  return { ok: true, conversation: conv, title, sourceFileName };
}
