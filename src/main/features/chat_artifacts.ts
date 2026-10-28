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
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { setImmediate as yieldToHost } from 'node:timers/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import {
  artifactDirForConversation,
  chatArtifactCidDirForConversation,
  chatArtifactRelPath,
} from '../util/project-layout';
import { appTypeSchema, metadataAppType, type AppType } from './web_apps/data-contract';
import { manifestSchema } from './web_apps/catalog';
import type { ZodIssue } from 'zod';
import { createLogger } from '../logger';
import { logErrorSummary, maskId } from '../util/log-redact';
import { isPathAllowed } from '../util/path-sandbox';
import { writeTextAtomicSync } from '../storage';
import { replaceDirectoryAtomically } from '../util/atomic-directory-replace';
import { fileEditLock } from '../util/locks';

const log = createLogger('chat_artifacts');

// ── Paths & extension allowlists ──────────────────────────────────────────

// What the `chat-app://` handler is willing to serve. Web assets only — no
// executables, no archives.
export const SERVED_EXTS: ReadonlySet<string> = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.xml', '.txt',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.csv',
  '.avif', '.webmanifest', '.mp3', '.wav', '.ogg', '.mp4', '.webm', '.glb', '.gltf', '.md',
]);
// Extensions whose content is text (so `create_artifact` can validate UTF-8
// for utf8-encoded files, and which is the natural shape for hand-written app
// code). Anything else must be supplied as base64.
export const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.xml', '.txt', '.csv', '.webmanifest', '.gltf', '.md',
]);

const META_FILENAME = '__orkas-meta.json';
// Reserved virtual path prefix served by the protocol handler (the runtime
// bridge script), never read from disk; `create_artifact` rejects files under
// it so an artifact can't shadow the real bridge.
export const RESERVED_PREFIX = '__orkas/';
export const BRIDGE_RELPATH = '__orkas/bridge.js';
export const BRIDGE_SCRIPT_TAG = `<script src="${BRIDGE_RELPATH}"></script>`;

/**
 * The chat embed frame the renderer gives an artifact.
 *
 * Canonical here rather than in the renderer because `create_artifact`'s
 * pre-exposure smoke has to validate against the same box the user actually
 * gets. `renderer/modules/chat-artifact.js` mirrors these numbers and
 * `test/main/features/chat-artifact-frame-contract.test.ts` pins the two
 * together, so the gate can never drift away from the surface it guards.
 */
export const ARTIFACT_FRAME = Object.freeze({
  /** Height the iframe starts at, before the artifact reports its own. */
  defaultHeight: 420,
  /** Ceiling. Taller content scrolls inside the frame rather than growing it. */
  maxHeight: 640,
  minHeight: 80,
  /**
   * Representative embed width for the smoke. `.chat-artifact-card` is
   * `width: 40cqw` against the chat column, so a maximised window lands near
   * 480px — close to a third of the 1280px the smoke used to validate at,
   * which is why artifacts kept shipping desktop layouts that collapsed to
   * their own mobile breakpoint once embedded.
   */
  smokeWidth: 480,
});

// ── Types ────────────────────────────────────────────────────────────────

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string; code?: string; feature?: string; message?: string };

export interface ArtifactFileInput {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

export interface ArtifactMeta {
  revision?: number;
  savedAppId?: string;
  browserStorage?: 'isolated-v1';
  appType?: AppType;
  title: string;
  agentId: string;
  createdAt: string; // ISO
}

interface ResolveOk { ok: true; absPath: string; mime: string }
interface ResolveErr { ok: false; code: 'bad_input' | 'forbidden' | 'not_found'; error: string }
export type ResolveResult = ResolveOk | ResolveErr;
export type ArtifactInspection =
  | { ok: true; status: 'ok'; appType: AppType }
  | { ok: true; status: 'unavailable'; reason: string }
  | { ok: false; error: string };

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
  if (s.includes('\x00') || s.includes('\\')) throw new Error('invalid relpath');
  const segs = s.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') throw new Error('invalid relpath segment');
    if (seg.startsWith('.')) throw new Error('relpath segment must not start with "."');
  }
  return segs.join('/');
}

function notifyArtifactDirty(userId: string, cid: string, artifactId: string): void {
  void userId;
  void cid;
  void artifactId;
}

function notifyArtifactDeleted(userId: string, cid: string, artifactId: string, rel: string): void {
  void userId;
  void cid;
  void artifactId;
  void rel;
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
    case '.webmanifest':       return 'application/manifest+json';
    case '.avif':              return 'image/avif';
    case '.mp3':               return 'audio/mpeg';
    case '.wav':               return 'audio/wav';
    case '.ogg':               return 'audio/ogg';
    case '.mp4':               return 'video/mp4';
    case '.webm':              return 'video/webm';
    case '.glb':               return 'model/gltf-binary';
    case '.gltf':              return 'model/gltf+json';
    case '.md':                return 'text/markdown; charset=utf-8';
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

/** An artifact that already drives its own height. Loading the bridge on top
 *  of a hand-rolled reporter would put two writers on the same frame height. */
function reportsOwnHeight(html: string): boolean {
  return html.includes('__orkasArtifact') && /['"]resize['"]/.test(html);
}

/**
 * Give every artifact the auto-sizing bridge instead of hoping it opts in.
 *
 * The frame is cross-origin by design, so the host cannot measure the content
 * and an artifact that never posts `resize` is stuck at
 * `ARTIFACT_FRAME.defaultHeight` for its whole life. That was documented only
 * as "apps may load `__orkas/bridge.js`" in a parameter description, and in
 * practice nobody opted in: on 2026-08-26 three consecutive artifacts in one
 * conversation shipped `100vh` layouts with zero height reporting and rendered
 * roughly 39% clipped, with the clipped part being the controls the user had
 * asked for over the preceding three revisions.
 *
 * Injecting the tag makes correct sizing the default. An artifact that already
 * references the bridge, or already reports its own height, is left untouched.
 */
export function ensureBridgeScript(html: string): string {
  if (html.includes(BRIDGE_RELPATH) || reportsOwnHeight(html)) return html;
  const tag = `${BRIDGE_SCRIPT_TAG}\n`;
  const headClose = html.search(/<\/head\s*>/i);
  if (headClose >= 0) return `${html.slice(0, headClose)}${tag}${html.slice(headClose)}`;
  const bodyClose = html.search(/<\/body\s*>/i);
  if (bodyClose >= 0) return `${html.slice(0, bodyClose)}${tag}${html.slice(bodyClose)}`;
  return `${html}\n${tag}`;
}

// ── Declaration rejection detail ─────────────────────────────────────────

// The author corrects and resubmits from this text, so it names the failing
// member and the schema-side expectation. It never echoes rejected values;
// unsupported keys appear only when they are identifier-shaped. Bounded so a
// pathological manifest cannot flood the tool result or the reject log.
const DECLARATION_ERROR_PREFIX = 'invalid application interface declaration in orkas-app.json: ';
const DECLARATION_ISSUE_LIMIT = 3;
const DECLARATION_ERROR_MAX = 600;
const IDENTIFIER_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

function declarationError(detail: string): string {
  const text = DECLARATION_ERROR_PREFIX + detail;
  return text.length <= DECLARATION_ERROR_MAX ? text : text.slice(0, DECLARATION_ERROR_MAX - 3) + '...';
}

function declarationPath(issuePath: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const part of issuePath) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += (out ? '.' : '') + (typeof part === 'string' && IDENTIFIER_KEY.test(part) ? part : '<key>');
  }
  return out || 'root';
}

/** The schema-side reason for one issue, without its location. */
function declarationReason(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type': {
      const received = issue.input === null ? 'null' : Array.isArray(issue.input) ? 'array' : typeof issue.input;
      return received === 'undefined' ? 'is required' : `must be ${issue.expected}, received ${received}`;
    }
    case 'invalid_value':
      return issue.values.length === 1
        ? issue.input === undefined ? 'is required' : `must be ${JSON.stringify(issue.values[0])}`
        : `must be one of ${issue.values.join(', ')}`;
    case 'unrecognized_keys': {
      const named = issue.keys.filter(key => IDENTIFIER_KEY.test(key));
      const unnamed = issue.keys.length - named.length;
      const list = [...named.slice(0, 5), ...(named.length > 5 ? [`+${named.length - 5} more`] : []),
        ...(unnamed ? [`${unnamed} other key(s)`] : [])];
      return `has unsupported field(s) ${list.join(', ')}`;
    }
    case 'invalid_format':
      return 'has an invalid format';
    default:
      // Remaining zod messages and data-contract refinements are schema-authored.
      return `: ${issue.message}`;
  }
}

/** Group identical reasons; unsupported fields first because an invented
 *  member (e.g. `interfaces`) usually explains the missing required ones. */
function describeDeclarationIssues(issues: readonly ZodIssue[]): string {
  const groups = new Map<string, string[]>();
  const ordered = [...issues].sort((a, b) => Number(b.code === 'unrecognized_keys') - Number(a.code === 'unrecognized_keys'));
  for (const issue of ordered) {
    const reason = declarationReason(issue);
    const paths = groups.get(reason) ?? [];
    paths.push(declarationPath(issue.path));
    groups.set(reason, paths);
  }
  const rendered = [...groups].map(([reason, paths]) => {
    const where = paths.slice(0, DECLARATION_ISSUE_LIMIT).join(', ') + (paths.length > DECLARATION_ISSUE_LIMIT ? ` (+${paths.length - DECLARATION_ISSUE_LIMIT} more)` : '');
    return reason.startsWith(':') ? where + reason : `${where} ${reason}`;
  });
  const shown = rendered.slice(0, DECLARATION_ISSUE_LIMIT).join('; ');
  return rendered.length > DECLARATION_ISSUE_LIMIT ? `${shown} (+${rendered.length - DECLARATION_ISSUE_LIMIT} more)` : shown;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Create or explicitly revise an artifact bundle for (uid, cid, agentId). Validates the file set
 * (must include exactly one top-level `index.html`; extension allowlist; UTF-8 for utf8-encoded text files; relpath
 * safety; no `__orkas/` or `__orkas-meta.json` clobber), writes atomically
 * (temp dir → rename), and stamps `__orkas-meta.json`.
 */
export async function createArtifact(
  userId: string,
  cid: string,
  agentId: string,
  input: { title?: unknown; files?: unknown; appType?: unknown; artifactId?: unknown },
  finalize?: (stagedDir: string, artifactId: string) => Promise<void>,
): Promise<Result<{ artifactId: string; title: string; revision: number }>> {
  let safeConvId: string;
  try { safeConvId = safeCid(cid); }
  catch (err) { return { ok: false, error: (err as Error).message }; }

  let targetId: string | undefined;
  let previousMeta: ArtifactMeta | undefined;
  let previousRaw: string | undefined;
  let previousFiles: string[] = [];
  if (input.artifactId !== undefined) {
    try {
      targetId = safeArtifactId(input.artifactId);
      const resolved = resolveArtifactDir(userId, safeConvId, targetId);
      if (!resolved.ok) return { ok: false, error: 'application to revise was not found in this conversation' };
      previousMeta = readArtifactMeta(userId, safeConvId, targetId, { strictSaveBinding: true });
      if (!previousMeta || previousMeta.agentId !== agentId || !previousMeta.appType) {
        return { ok: false, error: 'application revision requires an existing app from this creator' };
      }
      previousRaw = fs.readFileSync(path.join(resolved.dirPath, META_FILENAME), 'utf8');
      previousFiles = listArtifactFilesRel(resolved.dirPath);
    } catch {
      return { ok: false, error: 'application revision target is invalid or unavailable' };
    }
  }

  let boundType:AppType|undefined;
  try{boundType=await (await import('./saved_apps')).boundAppType(userId,cid);}
  catch(err){
    log.warn('createArtifact app binding unavailable',{user_id:maskId(userId),conversation_id:maskId(safeConvId),error:logErrorSummary(err)});
    return {ok:false,error:'app editing source unavailable; reopen editing from the app or save as a new app'};
  }
  const selectedType=appTypeSchema.safeParse((input.appType === 'cloud' ? 'web' : input.appType) ?? previousMeta?.appType ?? boundType ?? 'local');
  if(!selectedType.success || (boundType && selectedType.data!==boundType) || (previousMeta && selectedType.data!==previousMeta.appType))return {ok:false,error:'app type must match the task or editing source'};
  const appType=selectedType.data;
  const title = (typeof input?.title === 'string' && input.title.trim())
    ? input.title.trim().slice(0, 120)
    : previousMeta?.title ?? 'Interactive app';

  if (!Array.isArray(input?.files) || input.files.length === 0) {
    return { ok: false, error: 'files: required, must be a non-empty array of { path, content }' };
  }
  // Validate names before staging. Retain source strings, not a decoded copy
  // of every asset; decode and write one file at a time below.
  const prepared: Array<{ rel: string; content: string; encoding: 'base64' | 'utf8' }> = [];
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
    if (encoding === 'base64' && !/^[A-Za-z0-9+/_\-=\s]*$/.test(f.content)) {
      return { ok: false, error: `file "${rel}": invalid base64 content` };
    }
    if (rel === 'index.html') hasIndex = true;
    prepared.push({ rel, content: f.content, encoding });
    if (prepared.length % 256 === 0) await yieldToHost();
  }
  const declared=prepared.find(f=>f.rel==='orkas-app.json');
  let declaredText='';
  if(declared){
    const bytes=Buffer.from(declared.content,declared.encoding);declaredText=bytes.toString('utf8');
    if(!Buffer.from(declaredText,'utf8').equals(bytes))return {ok:false,error:declarationError('content must be UTF-8 text')};
    let parsedJson:unknown;
    try{parsedJson=JSON.parse(declaredText);}catch{return {ok:false,error:declarationError('content must be valid JSON')};}
    // Input is retained only for the type/required distinction below; rejected
    // values never enter the bounded declaration error or logs.
    const parsed=manifestSchema.safeParse(parsedJson,{reportInput:true});
    if(!parsed.success)return {ok:false,error:declarationError(describeDeclarationIssues(parsed.error.issues))};
    const manifest=parsed.data;
    const hostOnly=manifest.capabilities.filter(c=>c!=='data');
    if(appType==='web'&&hostOnly.length)return {ok:false,error:`web applications cannot use host interfaces: declared local-only capabilities ${hostOnly.join(', ')}; web apps may declare only data`};
    if(manifest.capabilities.includes('data')&&!manifest.data)return {ok:false,error:'data definition is required'};
  }
  // Older strict manifest readers reject this additive protocol marker before
  // running a web bundle; they cannot silently treat it as a host app.
  if(appType==='web'){
    if(declared){declared.content=JSON.stringify({...JSON.parse(declaredText),minimumClient:'1.9.0'});declared.encoding='utf8';}
    else prepared.push({rel:'orkas-app.json',encoding:'utf8',content:JSON.stringify({sdkVersion:1,minimumClient:'1.9.0',capabilities:[]})});
  }
  if (!hasIndex) return { ok: false, error: 'files must include a top-level "index.html"' };

  const meta: ArtifactMeta = {
    ...(previousRaw ? JSON.parse(previousRaw) : { browserStorage: 'isolated-v1' }),
    appType,
    title,
    agentId: typeof agentId === 'string' ? agentId : '',
    createdAt: previousMeta?.createdAt ?? new Date().toISOString(),
    revision: (previousMeta?.revision ?? (previousMeta ? 1 : 0)) + 1,
  };
  const metaBuf = Buffer.from(JSON.stringify(meta, null, 2), 'utf8');

  // Mint an id that isn't already taken (collisions are astronomically
  // unlikely with 9 random bytes, but a few retries cost nothing).
  let artifactId = targetId ?? '';
  let finalDir = targetId ? artifactDirForConversation(userId, safeConvId, targetId) : '';
  for (let attempt = 0; !artifactId && attempt < 5; attempt++) {
    const candidate = crypto.randomBytes(9).toString('base64url'); // 12 url-safe chars
    const dir = artifactDirForConversation(userId, safeConvId, candidate);
    if (!fs.existsSync(dir)) { artifactId = candidate; finalDir = dir; break; }
  }
  if (!artifactId) return { ok: false, error: 'could not allocate an artifact id' };

  try {
    await replaceDirectoryAtomically(finalDir, async tmpDir => {
      for (const { rel, content, encoding } of prepared) {
        let buf = Buffer.from(content, encoding);
        if (encoding === 'utf8') {
          if (buf.toString('utf8') !== content) throw new Error(`file "${rel}": content is not valid UTF-8`);
          if (rel === 'index.html' && appType === 'local') buf = Buffer.from(ensureBridgeScript(content), 'utf8');
        }
        const dst = path.join(tmpDir, rel);
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.writeFile(dst, buf);
        totalBytes += buf.length;
      }
      await fsp.writeFile(path.join(tmpDir, META_FILENAME), metaBuf);
      await finalize?.(tmpDir, artifactId);
    }, undefined, {
      activationGuard: activate => fileEditLock(finalDir).runExclusive(async () => {
        if (targetId) {
          const current = resolveArtifactDir(userId, safeConvId, targetId);
          if (!current.ok || await fsp.readFile(path.join(finalDir, META_FILENAME), 'utf8') !== previousRaw) {
            throw new Error('application changed while preparing the revision');
          }
        } else if (fs.existsSync(finalDir)) throw new Error('application identity already exists');
        return activate();
      }),
      onCleanupError: err => log.warn('artifact replacement cleanup deferred', { error: logErrorSummary(err) }),
    });
  } catch (err) {
    log.warn('artifact preparation failed', { error: logErrorSummary(err) });
    return { ok: false, error: targetId ? 'could not update the application; the previous version is retained' : 'could not prepare the application' };
  }
  log.info('artifact committed', { user_id: maskId(userId), conversation_id: maskId(safeConvId),
    artifact_id: maskId(artifactId), file_count: prepared.length, bytes: totalBytes, revision: meta.revision });
  notifyArtifactDirty(userId, safeConvId, artifactId);
  if (previousFiles.length) {
    const retained = new Set(listArtifactFilesRel(finalDir));
    for (const rel of previousFiles) if (!retained.has(rel)) notifyArtifactDeleted(userId, safeConvId, artifactId, rel);
  }
  return { ok: true, artifactId, title, revision: meta.revision! };
}

export async function inspectArtifactIndex(userId: string, cid: string, artifactId: string): Promise<ArtifactInspection> {
  const resolved = resolveArtifactFilePath(userId, cid, artifactId, 'index.html');
  if (!resolved.ok) {
    return { ok: true, status: 'unavailable', reason: (resolved as { error?: string }).error || 'artifact index is unavailable' };
  }
  try {
    fs.accessSync((resolved as { absPath: string }).absPath, fs.constants.R_OK);
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'failed to inspect artifact index' };
  }
  // An unresolvable editing binding leaves the bubble unlabelled, never local.
  try { return { ok: true, status: 'ok', appType: await (await import('./saved_apps')).resolveArtifactAppType(userId, cid, artifactId) }; }
  catch (err) {
    log.warn('inspectArtifactIndex app binding unavailable', { error: logErrorSummary(err) });
    return { ok: false, error: 'app editing source unavailable' };
  }
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
  const dir = artifactDirForConversation(userId, safeConvId, safeId);
  let st: fs.Stats;
  try {
    const lst = fs.lstatSync(dir);
    if (lst.isSymbolicLink()) return { ok: false, code: 'not_found', error: 'artifact not found' };
    st = fs.statSync(dir);
  }
  catch { return { ok: false, code: 'not_found', error: 'artifact not found' }; }
  if (!st.isDirectory()) return { ok: false, code: 'not_found', error: 'artifact not found' };
  if (!isPathAllowed(dir, [chatArtifactCidDirForConversation(userId, safeConvId)])) {
    return { ok: false, code: 'not_found', error: 'artifact not found' };
  }
  return { ok: true, dirPath: dir };
}

/** Remove one newly-created artifact before it becomes user-visible. Used by
 *  create_artifact when post-processing or interaction smoke checks fail. */
export function discardArtifact(
  userId: string,
  cid: string,
  artifactId: string,
): Result<{ deleted: boolean }> {
  let safeConvId: string;
  let safeId: string;
  try { safeConvId = safeCid(cid); safeId = safeArtifactId(artifactId); }
  catch (err) {
    log.warn('discardArtifact rejected invalid identity', {
      user_id: maskId(userId),
      cid: maskId(cid),
      artifact_id: maskId(artifactId),
      error: logErrorSummary(err),
    });
    return { ok: false, error: 'invalid artifact identity' };
  }
  const resolved = resolveArtifactDir(userId, safeConvId, safeId);
  if (!resolved.ok) {
    const error = (resolved as { error?: string }).error || 'artifact not found';
    log.warn('discardArtifact resolve failed', {
      user_id: maskId(userId),
      cid: maskId(safeConvId),
      artifact_id: maskId(safeId),
    });
    return { ok: false, error };
  }
  const deletedFiles = listArtifactFilesRel(resolved.dirPath);
  try {
    fs.rmSync(resolved.dirPath, { recursive: true, force: false });
  } catch (err) {
    log.warn('discardArtifact delete failed', {
      user_id: maskId(userId),
      cid: maskId(safeConvId),
      artifact_id: maskId(safeId),
      error: logErrorSummary(err),
    });
    return { ok: false, error: 'failed to discard artifact' };
  }
  for (const rel of deletedFiles) notifyArtifactDeleted(userId, safeConvId, safeId, rel);
  return { ok: true, deleted: true };
}

/** Read an artifact's metadata, if present. Best-effort (returns undefined on
 *  any failure — callers fall back to a generic title). Save-target resolution
 *  opts into strict association reads so damaged state never redirects a write. */
export function readArtifactMeta(userId: string, cid: string, artifactId: string, opts: { strictSaveBinding?: boolean } = {}): ArtifactMeta | undefined {
  let safeConvId: string;
  let safeId: string;
  try { safeConvId = safeCid(cid); safeId = safeArtifactId(artifactId); }
  catch { return undefined; }
  try {
    const raw = fs.readFileSync(path.join(artifactDirForConversation(userId, safeConvId, safeId), META_FILENAME), 'utf8');
    const obj = JSON.parse(raw) as Partial<ArtifactMeta>;
    const validSavedAppId = typeof obj?.savedAppId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(obj.savedAppId);
    if (opts.strictSaveBinding && (!obj || typeof obj !== 'object' || Array.isArray(obj)
        || (Object.hasOwn(obj, 'savedAppId') && !validSavedAppId))) throw new Error('invalid save binding');
    if (obj && typeof obj === 'object') {
      return {
        ...(Number.isSafeInteger(obj.revision) && obj.revision! > 0 ? { revision: obj.revision } : {}),
        ...(validSavedAppId ? { savedAppId: obj.savedAppId } : {}),
        appType: metadataAppType(obj.appType),
        ...(obj.browserStorage === 'isolated-v1' ? { browserStorage: obj.browserStorage } : {}),
        title: typeof obj.title === 'string' ? obj.title : 'Interactive app',
        agentId: typeof obj.agentId === 'string' ? obj.agentId : '',
        createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : '',
      };
    }
  } catch (error) {
    if (opts.strictSaveBinding && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('app_save_binding_unavailable');
    }
  }
  return undefined;
}

/** Host-owned save association; never accepted from application source files. */
export function bindSavedApp(userId: string, cid: string, artifactId: string, appId: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(appId)) throw new Error('invalid app id');
  const source = resolveArtifactDir(userId, cid, artifactId);
  if (!source.ok) throw new Error('artifact unavailable');
  const file = path.join(source.dirPath, META_FILENAME);
  if (!isPathAllowed(file, [source.dirPath])) throw new Error('artifact unavailable');
  let meta = {};
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('artifact unavailable');
    meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writeTextAtomicSync(file, JSON.stringify({ ...meta, savedAppId: appId }, null, 2));
  notifyArtifactDirty(userId, cid, artifactId);
}

export interface ArtifactSummary {
  artifactId: string;
  title: string;
  agentId: string;
  createdAt: string;
  /** Total bytes on disk and newest mtime, so the conversation output list can
   *  present an artifact next to ordinary files without special-casing them. */
  bytes: number;
  mtime: number;
}

/**
 * Every artifact this conversation holds, newest first.
 *
 * An artifact is a directory bundle rather than a file, so it is summarized as
 * one row: the pool is the only place it exists, and until this listing it was
 * reachable only from the bubble that created it — scroll past that bubble and
 * a `create_artifact` app could not be found again.
 *
 * Best-effort: an unreadable or malformed entry is skipped rather than failing
 * the whole listing.
 */
export function listArtifacts(userId: string, cid: string): ArtifactSummary[] {
  let safeConvId: string;
  try { safeConvId = safeCid(cid); }
  catch { return []; }

  const root = chatArtifactCidDirForConversation(userId, safeConvId);
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }

  const out: ArtifactSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let artifactId: string;
    try { artifactId = safeArtifactId(entry.name); }
    catch { continue; }
    const dir = artifactDirForConversation(userId, safeConvId, artifactId);
    let bytes = 0;
    let mtime = 0;
    let files: fs.Dirent[];
    try { files = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    // An artifact with no entry point is a half-written or discarded bundle;
    // the `chat-app://` handler could not serve it either.
    if (!files.some((file) => file.isFile() && file.name === 'index.html')) continue;
    for (const file of files) {
      if (!file.isFile()) continue;
      try {
        const st = fs.statSync(path.join(dir, file.name));
        bytes += st.size;
        mtime = Math.max(mtime, Math.floor(st.mtimeMs));
      } catch { /* skip an unreadable sibling, keep the bundle */ }
    }
    const meta = readArtifactMeta(userId, safeConvId, artifactId);
    out.push({
      artifactId,
      title: meta?.title || '',
      agentId: meta?.agentId || '',
      createdAt: meta?.createdAt || '',
      bytes,
      mtime,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime || a.artifactId.localeCompare(b.artifactId));
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

  const root = path.resolve(artifactDirForConversation(userId, safeConvId, safeId));
  const abs = path.resolve(root, rel);
  const relCheck = path.relative(root, abs);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    return { ok: false, code: 'forbidden', error: 'path traversal blocked' };
  }
  try {
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { ok: false, code: 'not_found', error: 'not found' };
    }
  } catch {
    return { ok: false, code: 'not_found', error: 'not found' };
  }
  if (!isPathAllowed(abs, [root])) {
    return { ok: false, code: 'forbidden', error: 'symlink escape blocked' };
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
  const dir = chatArtifactCidDirForConversation(userId, safeConvId);
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
  for (const item of deleted) notifyArtifactDeleted(userId, safeConvId, item.artifactId, item.rel);
  return count;
}
