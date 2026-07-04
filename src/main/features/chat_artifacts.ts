/**
 * Interactive web-app "artifacts" for the main chat.
 *
 * An artifact is a self-contained multi-file web app the LLM produces via the
 * `create_artifact` tool (HTML/CSS/JS, optional inline binary assets). It is
 * written to disk and served read-only through the `chat-app://` protocol (see
 * `src/main/index.ts`), then embedded in a sandboxed `<iframe>` inside the
 * assistant bubble (renderer `modules/chat-artifact.js`). User interaction
 * round-trips back to the creating agent via `postMessage` (see the renderer
 * widget) — there is no iframe→disk channel by design (the sandbox boundary).
 *
 * Layout: `<uid>/cloud/chat_artifacts/<cid>/<artifactId>/`
 *   index.html               required entry point
 *   <other files...>         siblings (css / js / json / svg / inline assets)
 *   __orkas-meta.json        { title, agentId, createdAt } — written by us;
 *                            `create_artifact` may not supply this name
 * Cloud-synced with the conversation; purged by cid on conversation delete.
 * A *separate* pool from `chat_attachments/` on purpose — attachments are user
 * uploads scanned by `buildAttachmentManifest` to feed the model; artifacts
 * are arbitrary directory trees that must not be scanned that way.
 *
 * Guard rails mirror `chat_attachments.resolveAttachmentAbsPath`:
 *   - safeCid / safeArtifactId / safeRelPath reject path separators, traversal
 *     names, NULs, empties; relpath segments are validated one by one
 *   - the served extension allowlist blocks executables and anything not a web
 *     asset; `create_artifact` additionally requires every file to declare a
 *     known extension and (for utf8 content) to actually be valid UTF-8
 *   - after `path.resolve` the final abs path MUST still live under
 *     `<cid>/<artifactId>/` (belt-and-braces anti-traversal)
 *   - file must exist and be a regular file
 *
 * If binary assets larger than the per-file cap are ever needed, the right
 * extension is base64-encoded content (already supported below) — never widen
 * the served allowlist to executable types.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { artifactDir, chatArtifactCidDir } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('chat_artifacts');

// ── Caps & extension allowlists ──────────────────────────────────────────

export const MAX_ARTIFACT_FILES = 20;
export const MAX_BYTES_PER_FILE = 256 * 1024;       // 256 KB
export const MAX_BYTES_TOTAL    = 1 * 1024 * 1024;  // 1 MB
const MAX_RELPATH_LEN = 200;

// What the `chat-app://` handler is willing to serve. Web assets only — no
// executables, no archives.
const SERVED_EXTS: ReadonlySet<string> = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.xml', '.txt',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.csv',
]);
// Extensions whose content is text (so `create_artifact` can validate UTF-8
// for utf8-encoded files, and which is the natural shape for hand-written app
// code). Anything else must be supplied as base64.
const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.xml', '.txt', '.csv',
]);

const META_FILENAME = '__orkas-meta.json';
// Reserved virtual path prefix served by the protocol handler (the runtime
// bridge script), never read from disk; `create_artifact` rejects files under
// it so an artifact can't shadow the real bridge.
export const RESERVED_PREFIX = '__orkas/';
export const BRIDGE_RELPATH = '__orkas/bridge.js';

// ── Types ────────────────────────────────────────────────────────────────

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

export interface ArtifactFileInput {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

export interface ArtifactMeta {
  title: string;
  agentId: string;
  createdAt: string; // ISO
}

interface ResolveOk { ok: true; absPath: string; mime: string }
interface ResolveErr { ok: false; code: 'bad_input' | 'forbidden' | 'not_found'; error: string }
export type ResolveResult = ResolveOk | ResolveErr;

// ── Safe-name helpers ────────────────────────────────────────────────────

function safeCid(cid: unknown): string {
  if (typeof cid !== 'string' || !cid) throw new Error('cid required');
  if (cid.includes('/') || cid.includes('\\') || cid.includes('\x00') || cid === '.' || cid === '..') {
    throw new Error('invalid cid');
  }
  return cid;
}

function safeArtifactId(id: unknown): string {
  if (typeof id !== 'string' || !id) throw new Error('artifactId required');
  // Generated ids are base64url (alphanumerics + `-` + `_`); be a touch
  // permissive for forward-compat but never allow separators / dots / NUL.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('invalid artifactId');
  return id;
}

/** Validate + normalise a forward-slash relative path. Returns the normalised
 *  form (always `/`-joined, no leading slash). Throws on anything unsafe. */
function safeRelPath(rel: unknown): string {
  if (typeof rel !== 'string') throw new Error('relpath required');
  let s = rel.trim();
  if (s.startsWith('/')) s = s.slice(1);
  if (!s) throw new Error('empty relpath');
  if (s.length > MAX_RELPATH_LEN) throw new Error('relpath too long');
  if (s.includes('\x00') || s.includes('\\')) throw new Error('invalid relpath');
  const segs = s.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') throw new Error('invalid relpath segment');
    if (seg.startsWith('.')) throw new Error('relpath segment must not start with "."');
  }
  return segs.join('/');
}

function artifactRelPath(cid: string, artifactId: string, rel = ''): string {
  return ['cloud/chat_artifacts', cid, artifactId, rel].filter(Boolean).join('/');
}

function notifyArtifactDirty(cid: string, artifactId: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = null as { markDirty?: (domain: string, relPath: string) => void };
    sync?.markDirty?.('chat_artifacts', artifactRelPath(cid, artifactId));
  } catch { /* features/sync stripped */ }
}

function notifyArtifactDeleted(cid: string, artifactId: string, rel: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = null as { markDeleted?: (relPath: string) => Promise<void> | void };
    void sync?.markDeleted?.(artifactRelPath(cid, artifactId, rel));
  } catch { /* features/sync stripped */ }
}

function listArtifactFilesRel(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listArtifactFilesRel(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function extOf(name: string): string {
  return path.extname(name).toLowerCase();
}

/** MIME for the `chat-app://` handler. `.js` / `.mjs` resolve to
 *  `text/javascript` so Chromium runs them as module scripts. */
export function mimeFor(name: string): string {
  switch (extOf(name)) {
    case '.html': case '.htm': return 'text/html; charset=utf-8';
    case '.js': case '.mjs':   return 'text/javascript; charset=utf-8';
    case '.css':               return 'text/css; charset=utf-8';
    case '.json': case '.map': return 'application/json; charset=utf-8';
    case '.svg':               return 'image/svg+xml';
    case '.xml':               return 'application/xml; charset=utf-8';
    case '.txt': case '.csv':  return 'text/plain; charset=utf-8';
    case '.png':               return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif':               return 'image/gif';
    case '.webp':              return 'image/webp';
    case '.bmp':               return 'image/bmp';
    case '.ico':               return 'image/x-icon';
    case '.wasm':              return 'application/wasm';
    case '.woff':              return 'font/woff';
    case '.woff2':             return 'font/woff2';
    case '.ttf':               return 'font/ttf';
    case '.otf':               return 'font/otf';
    default:                   return 'application/octet-stream';
  }
}

// ── Runtime bridge (served at the reserved virtual path) ─────────────────
//
// Opt-in: an artifact that wants auto-sizing + a tidy send() helper does
// `<script src="__orkas/bridge.js"></script>`. Everything still works without
// it — the app may also `parent.postMessage({__orkasArtifact:true, ...}, '*')`
// directly.
export const BRIDGE_JS = `(function(){
  function post(type, extra){
    try { parent.postMessage(Object.assign({ __orkasArtifact: true, type: type }, extra || {}), '*'); }
    catch (e) {}
  }
  function reportHeight(){
    try {
      var h = Math.max(
        document.documentElement ? document.documentElement.scrollHeight : 0,
        document.body ? document.body.scrollHeight : 0
      );
      if (h > 0) post('resize', { height: h });
    } catch (e) {}
  }
  var api = {
    send: function(payload){ post('submit', { payload: payload }); },
    resize: function(px){ var n = Number(px); post('resize', { height: (isFinite(n) && n > 0) ? n : 0 }); },
    openExternal: function(url){ post('open-external', { url: String(url || '') }); }
  };
  try {
    if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', reportHeight);
    else setTimeout(reportHeight, 0);
    window.addEventListener('load', reportHeight);
    if (typeof ResizeObserver !== 'undefined') {
      try { new ResizeObserver(reportHeight).observe(document.documentElement); } catch (e) {}
    } else {
      setInterval(reportHeight, 1000);
    }
  } catch (e) {}
  window.orkasArtifact = api;
})();
`;

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Write a new artifact bundle for (uid, cid, agentId). Validates the file set
 * (must include exactly one top-level `index.html`; per-file + total + count
 * caps; extension allowlist; UTF-8 for utf8-encoded text files; relpath
 * safety; no `__orkas/` or `__orkas-meta.json` clobber), writes atomically
 * (temp dir → rename), and stamps `__orkas-meta.json`.
 */
export function createArtifact(
  userId: string,
  cid: string,
  agentId: string,
  input: { title?: unknown; files?: unknown },
): Result<{ artifactId: string; title: string }> {
  let safeConvId: string;
  try { safeConvId = safeCid(cid); }
  catch (err) { return { ok: false, error: (err as Error).message }; }

  const title = (typeof input?.title === 'string' && input.title.trim())
    ? input.title.trim().slice(0, 120)
    : 'Interactive app';

  if (!Array.isArray(input?.files) || input.files.length === 0) {
    return { ok: false, error: 'files: required, must be a non-empty array of { path, content }' };
  }
  if (input.files.length > MAX_ARTIFACT_FILES) {
    return { ok: false, error: `too many files (max ${MAX_ARTIFACT_FILES})` };
  }

  // Validate + materialise every file in memory first; only touch disk once
  // the whole set checks out.
  const prepared: Array<{ rel: string; buf: Buffer }> = [];
  const seen = new Set<string>();
  let hasIndex = false;
  let totalBytes = 0;
  for (const raw of input.files) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'each file must be an object { path, content }' };
    const f = raw as ArtifactFileInput;
    let rel: string;
    try { rel = safeRelPath(f.path); }
    catch (err) { return { ok: false, error: `file path ${JSON.stringify((raw as { path?: unknown }).path)}: ${(err as Error).message}` }; }
    if (rel === META_FILENAME || rel.startsWith(RESERVED_PREFIX)) {
      return { ok: false, error: `file path "${rel}" is reserved` };
    }
    const lc = rel.toLowerCase();
    if (seen.has(lc)) return { ok: false, error: `duplicate file path "${rel}"` };
    seen.add(lc);
    const ext = extOf(rel);
    if (!SERVED_EXTS.has(ext)) {
      return { ok: false, error: `file "${rel}": unsupported extension ${ext || '(none)'}` };
    }
    if (typeof f.content !== 'string') return { ok: false, error: `file "${rel}": content must be a string` };
    const encoding = f.encoding === 'base64' ? 'base64' : 'utf8';
    if (encoding === 'utf8' && !TEXT_EXTS.has(ext)) {
      return { ok: false, error: `file "${rel}": ${ext} content must be base64-encoded (set "encoding":"base64")` };
    }
    let buf: Buffer;
    if (encoding === 'base64') {
      if (!/^[A-Za-z0-9+/_\-=\s]*$/.test(f.content)) {
        return { ok: false, error: `file "${rel}": invalid base64 content` };
      }
      buf = Buffer.from(f.content, 'base64'); // tolerant of url-safe alphabet + whitespace
    } else {
      buf = Buffer.from(f.content, 'utf8');
      if (buf.toString('utf8') !== f.content) return { ok: false, error: `file "${rel}": content is not valid UTF-8` };
    }
    if (buf.length > MAX_BYTES_PER_FILE) {
      return { ok: false, error: `file "${rel}": exceeds ${Math.round(MAX_BYTES_PER_FILE / 1024)}KB per-file cap` };
    }
    totalBytes += buf.length;
    if (totalBytes > MAX_BYTES_TOTAL) {
      return { ok: false, error: `bundle exceeds ${Math.round(MAX_BYTES_TOTAL / 1024)}KB total cap` };
    }
    if (rel === 'index.html') hasIndex = true;
    prepared.push({ rel, buf });
  }
  if (!hasIndex) return { ok: false, error: 'files must include a top-level "index.html"' };

  const meta: ArtifactMeta = {
    title,
    agentId: typeof agentId === 'string' ? agentId : '',
    createdAt: new Date().toISOString(),
  };
  const metaBuf = Buffer.from(JSON.stringify(meta, null, 2), 'utf8');

  // Mint an id that isn't already taken (collisions are astronomically
  // unlikely with 9 random bytes, but a few retries cost nothing).
  let artifactId = '';
  let finalDir = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = crypto.randomBytes(9).toString('base64url'); // 12 url-safe chars
    const dir = artifactDir(userId, safeConvId, candidate);
    if (!fs.existsSync(dir)) { artifactId = candidate; finalDir = dir; break; }
  }
  if (!artifactId) return { ok: false, error: 'could not allocate an artifact id' };

  const tmpDir = `${finalDir}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  try {
    for (const { rel, buf } of prepared) {
      const dst = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, buf);
    }
    fs.writeFileSync(path.join(tmpDir, META_FILENAME), metaBuf);
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    fs.renameSync(tmpDir, finalDir);
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    log.warn(`createArtifact failed user=${userId} cid=${safeConvId}: ${(err as Error).message}`);
    return { ok: false, error: `failed to write artifact: ${(err as Error).message}` };
  }
  log.info(`createArtifact user=${userId} cid=${safeConvId} id=${artifactId} files=${prepared.length} bytes=${totalBytes} agent=${meta.agentId}`);
  notifyArtifactDirty(safeConvId, artifactId);
  return { ok: true, artifactId, title };
}

/** Resolve (uid, cid, artifactId) → the validated, existing artifact directory.
 *  Used by `features/saved_apps.ts` to copy a bundle out of the chat pool —
 *  it gets the same safe-cid / safe-artifactId guards without re-implementing
 *  them. `code` maps to HTTP the same way `resolveArtifactFilePath`'s does. */
export function resolveArtifactDir(
  userId: string,
  cid: string,
  artifactId: string,
): { ok: true; dirPath: string } | { ok: false; code: 'bad_input' | 'not_found'; error: string } {
  let safeConvId: string;
  let safeId: string;
  try { safeConvId = safeCid(cid); safeId = safeArtifactId(artifactId); }
  catch (err) { return { ok: false, code: 'bad_input', error: (err as Error).message }; }
  const dir = artifactDir(userId, safeConvId, safeId);
  let st: fs.Stats;
  try { st = fs.statSync(dir); }
  catch { return { ok: false, code: 'not_found', error: 'artifact not found' }; }
  if (!st.isDirectory()) return { ok: false, code: 'not_found', error: 'artifact not found' };
  return { ok: true, dirPath: dir };
}

/** Read an artifact's metadata, if present. Best-effort (returns undefined on
 *  any failure — callers fall back to a generic title). */
export function readArtifactMeta(userId: string, cid: string, artifactId: string): ArtifactMeta | undefined {
  let safeConvId: string;
  let safeId: string;
  try { safeConvId = safeCid(cid); safeId = safeArtifactId(artifactId); }
  catch { return undefined; }
  try {
    const raw = fs.readFileSync(path.join(artifactDir(userId, safeConvId, safeId), META_FILENAME), 'utf8');
    const obj = JSON.parse(raw) as Partial<ArtifactMeta>;
    if (obj && typeof obj === 'object') {
      return {
        title: typeof obj.title === 'string' ? obj.title : 'Interactive app',
        agentId: typeof obj.agentId === 'string' ? obj.agentId : '',
        createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : '',
      };
    }
  } catch { /* missing / malformed */ }
  return undefined;
}

/**
 * Resolve (uid, cid, artifactId, relPath) → an on-disk file to stream, with
 * every guard rail the `chat-app://` protocol handler needs. Empty `relPath`
 * defaults to `index.html`. The reserved virtual path `__orkas/bridge.js` is
 * NOT a disk file — the handler must check for it before calling this and
 * serve `BRIDGE_JS` instead; this function rejects any `__orkas/...` request.
 *
 * Error codes map to HTTP: 'bad_input'→400, 'forbidden'→403, 'not_found'→404.
 */
export function resolveArtifactFilePath(
  userId: string,
  cid: string,
  artifactId: string,
  relPath: string,
): ResolveResult {
  let safeConvId: string;
  let safeId: string;
  try { safeConvId = safeCid(cid); safeId = safeArtifactId(artifactId); }
  catch (err) { return { ok: false, code: 'bad_input', error: (err as Error).message }; }

  let rel: string;
  const trimmed = typeof relPath === 'string' ? relPath.replace(/^\/+/, '').trim() : '';
  if (!trimmed) {
    rel = 'index.html';
  } else {
    try { rel = safeRelPath(trimmed); }
    catch (err) { return { ok: false, code: 'bad_input', error: (err as Error).message }; }
  }
  if (rel.startsWith(RESERVED_PREFIX)) {
    // Only `__orkas/bridge.js` exists, and the handler serves it before
    // reaching here; anything else under `__orkas/` is nothing.
    return { ok: false, code: 'not_found', error: 'not found' };
  }
  const ext = extOf(rel);
  if (!SERVED_EXTS.has(ext)) {
    return { ok: false, code: 'forbidden', error: `extension not served: ${ext || '(none)'}` };
  }

  const root = path.resolve(artifactDir(userId, safeConvId, safeId));
  const abs = path.resolve(root, rel);
  const relCheck = path.relative(root, abs);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    return { ok: false, code: 'forbidden', error: 'path traversal blocked' };
  }
  let st: fs.Stats;
  try { st = fs.statSync(abs); }
  catch { return { ok: false, code: 'not_found', error: 'not found' }; }
  if (!st.isFile()) return { ok: false, code: 'not_found', error: 'not a file' };
  return { ok: true, absPath: abs, mime: mimeFor(rel) };
}

/** Remove every artifact for a conversation (`chat_artifacts/<cid>/`). Returns
 *  the number of artifact directories removed. Called from
 *  `chats.deleteConversation` next to `chat_attachments.purgeByCid`. */
export async function purgeByCid(userId: string, cid: string): Promise<number> {
  let safeConvId: string;
  try { safeConvId = safeCid(cid); }
  catch { return 0; }
  const dir = chatArtifactCidDir(userId, safeConvId);
  let count = 0;
  const deleted: Array<{ artifactId: string; rel: string }> = [];
  try {
    if (fs.existsSync(dir)) {
      try {
        const artifactIds = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
        count = artifactIds.length;
        for (const artifactId of artifactIds) {
          const artifactRoot = path.join(dir, artifactId);
          for (const rel of listArtifactFilesRel(artifactRoot)) deleted.push({ artifactId, rel });
        }
      }
      catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) { log.warn(`purgeByCid(${cid}): ${(err as Error).message}`); }
  for (const item of deleted) notifyArtifactDeleted(safeConvId, item.artifactId, item.rel);
  return count;
}
