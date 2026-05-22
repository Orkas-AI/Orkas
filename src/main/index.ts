/**
 * Orkas — Electron main entry.
 *
 * Boot sequence:
 *   1. Redirect WS_ROOT → userData/data in packaged builds (before any
 *      require of main/paths which reads ORKAS_WORKSPACE_ROOT at load time).
 *   2. Pin CORE_AGENT_AUTH_DIR to <WS_ROOT>/config/ so core-agent's
 *      credential store lives under data/ (local-only, never synced).
 *      The env var name is core-agent's public API — kept as
 *      `AUTH_DIR` for stability even though the dir now also holds
 *      `user.json` and `web-search-cache.json`.
 *   3. Require paths + features → triggers builtin skill content sync.
 *   4. Create BrowserWindow loading renderer/index.html.
 *   5. IPC handlers serve invoke + stream calls from the renderer.
 *
 * File location: `PC/src/main/index.ts`. `bootstrap.cjs`'s
 * `require('./src/main')` resolves here automatically via Node's
 * folder → index resolution rule. `__dirname` points at `PC/src/main/`;
 * cross-tree references to renderer / builtin / resources go through
 * `paths.SRC_ROOT` — never splice `__dirname` directly.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import { app, BrowserWindow, Menu, ipcMain, nativeImage, protocol, shell } from 'electron';

// Force the user-visible app name to "Orkas" before anything else
// reads it. In dev (running `electron .`) Electron defaults to the
// `name` field in package.json (lowercase "orkas") or — when launched
// without that being effective — to literally "Electron", which leaks
// to the macOS Dock tooltip and the menu bar. Packaged builds set this
// via electron-builder's `productName`; this call covers dev + any
// edge case where productName isn't picked up early.
app.setName('Orkas');

// Dev = local Server. The PC has three API base resolvers (`features/account/server.ts`,
// `ORKAS_API_BASE_URL` env var first — pinning it here once means every business call routes to
// the local Server when running unpackaged (no scattered build-mode branches in feature modules).
// Packaged builds: not set → each resolver falls back to its profile/prod default.
// Explicit launcher env (`./dev.sh`, `ORKAS_API_BASE_URL=… ./run.sh`) wins, so a dev can still
// repro a bug against a remote Server. `app.isPackaged` here is allowlisted in
// `OpenSource/SyncCode/strip-rules.json::isPackaged_allowed_files`.
if (!app.isPackaged && !process.env.ORKAS_API_BASE_URL) {
  process.env.ORKAS_API_BASE_URL = 'http://127.0.0.1:8888/api';
}

// Register the KB file protocol BEFORE `app.whenReady()` — privileged
// schemes can't be added after. `kb-file:///<relpath>` serves a single
// file out of the current active user's `<uid>/cloud/contexts/`. Used by
// the renderer's PDF iframe (Chromium's built-in PDFium handles `.pdf`
// directly when served via a standard scheme). Other bytes types fall
// back to `shell.openPath`.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kb-file',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  // `chat-media://cid/<encCid>/<encName>` — serves image + video bytes out
  // of the active user's `<uid>/cloud/chat_attachments/<cid>/`. `stream:true`
  // only enables a streamed Response body — it does NOT make Chromium issue
  // byte-range requests on its own; the handler must advertise
  // `Accept-Ranges: bytes` and serve `206` itself (see `serveFileRange`).
  // Without that, `<video preload="metadata">` freezes a few seconds in
  // because Chromium can't resume past the cancelled metadata-probe fetch.
  {
    scheme: 'chat-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  // `chat-app://cid/<encCid>/<encArtifactId>/<relpath>` — serves the files of
  // an LLM-generated interactive web-app artifact out of
  // `<uid>/cloud/chat_artifacts/<cid>/<artifactId>/`, embedded in a sandboxed
  // `<iframe>` in the chat bubble (renderer `modules/chat-artifact.js`).
  // `standard:true` gives the iframe a real origin (`chat-app://cid`) so it
  // can use `<script type="module">` / same-origin `fetch` of sibling files /
  // `localStorage`; `secure:true` lets the `file://` renderer frame it
  // without a mixed-content block (same as `kb-file://`). `stream:true` for
  // the Range-aware streamed body (see `serveFileRange`).
  {
    scheme: 'chat-app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// WS_ROOT env injection (`~/.orkas/data` on mac/linux; Windows pinned
// drive's `<drive>:\.orkas\data`) is already done in `bootstrap.cjs` via
// `install-data-root.cjs`, and **must** happen there — TypeScript's
// import hoisting would pull `paths.ts`'s require ahead of any
// env-setting block here, so doing it later is too late. Container
// resolution + Windows pin + source-run migration logic lives in
// `src/main/install-data-root.cjs`.
import * as paths from './paths';
import { parseByteRange } from './util/http-range';

// `CORE_AGENT_AUTH_DIR` is pinned per-uid by `features/users.activateUser()`
// (runs inside `runBootSelfCheck` below). `resolveAuthDir()` in core-agent
// re-reads the env on every call so switching at runtime is safe.

// Skill runner env vars (ORKAS_NODE / ORKAS_PC_DIR / ELECTRON_RUN_AS_NODE)
// are injected per-call into the bash-tool sandbox by
// `model/core-agent/client.ts::buildSkillSandboxEnv()`. Do NOT set them on
// `process.env` here: the sandbox strips parent env anyway, and
// `ELECTRON_RUN_AS_NODE` would leak to Electron's own GPU/Renderer/Utility
// helpers (crashing the app at boot: "GPU process isn't usable. Goodbye.").

import * as storage from './storage';
import { initLogger, createLogger } from './logger';
initLogger();
const log = createLogger('orkas');

// Raise Anthropic / OpenAI SDK default timeouts before any feature (which may
// transitively pull in pi-ai) loads them. See sdk-timeout-patch.ts.
import { installSdkTimeoutPatch } from './model/core-agent/sdk-timeout-patch';
installSdkTimeoutPatch();

// Provider-fetch diagnostics — always on. Dumps the real undici cause
// chain (the cause that pi-ai's internal retry loop would otherwise
// swallow) into data/logs/. See fetch-diag.ts.
import { installFetchDiag } from './model/core-agent/fetch-diag';
installFetchDiag();

import { prompts } from './prompts/loader';
import * as ipc from './ipc';
import * as users from './features/users';
import * as skillsFeature from './features/skills';
import * as agentsFeature from './features/agents';
import * as contextsFeature from './features/contexts';
import * as chatsFeature from './features/chats';
import * as searchFeature from './features/search';
import * as authFeature from './features/auth';
import * as appConfig from './features/config';
import { getRendererTables } from './i18n';
import * as reflectionTrigger from './features/reflection-trigger';
import * as scheduledTasks from './features/scheduled_tasks';
import * as chatAttachments from './features/chat_attachments';
import * as chatArtifacts from './features/chat_artifacts';
// `features/sync/*` and `ipc/sync.ts` are stripped in OrkasOpen (depends on account).
import * as connectorsFeature from './features/connectors';
import * as windowState from './features/window_state';
// (sync + relay both depend on account; connectors depends on the Server OAuth bridge).


function createWindow(): BrowserWindow {
  const dev = !app.isPackaged;
  const dev = false;
  const restored = windowState.restoreWindowState();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    ...restored.bounds,
    title: '',
    backgroundColor: '#ffffff',
    icon: path.join(paths.SRC_ROOT, 'resources', 'icons', 'icon.png'),
    webPreferences: {
      // preload sits next to index.ts in PC/src/main/ — just __dirname + 'preload.js'.
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: dev,
      // Enables Chromium's built-in PDF viewer (PDFium) inside iframes.
      // Required for `<iframe src="kb-file:///.../report.pdf">` in the KB
      // viewer. Has no effect on other plugin types since Electron strips
      // the NPAPI / NaCl code path.
      plugins: true,
    },
  });
  windowState.watchWindowState(win);
  if (restored.isMaximized) win.maximize();

  win.loadFile(path.join(paths.SRC_ROOT, 'renderer', 'index.html'));

  // Block HTML <title> from populating the native titlebar — we want a
  // frame-only look (drag works, but no label across the top).
  win.on('page-title-updated', (e) => e.preventDefault());

  // External links in chat bubbles / knowledge base / settings always open
  // in the system default browser:
  //   - `target="_blank"` / `window.open()`  → setWindowOpenHandler
  //   - `<a href>` clicks without a target   → will-navigate (otherwise
  //     Electron navigates the current window away and replaces the UI).
  // Non-http(s) is always rejected (`file://` only fires through the
  // initial loadFile, which doesn't reach this handler).
  const openIfExternal = (raw: string): boolean => {
    const url = String(raw || '').trim();
    if (!/^https?:\/\//i.test(url)) return false;
    shell.openExternal(url).catch((err: unknown) => {
      log.warn('openExternal failed', { url, error: (err as Error)?.message || String(err) });
    });
    return true;
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openIfExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (openIfExternal(url)) event.preventDefault();
  });

  // Hijack Cmd/Ctrl+R / F5 uniformly:
  //   - Packaged: refresh disabled (the App doesn't need reload).
  //   - Dev: force reloadIgnoringCache so that after editing
  //     renderer/*.css or *.js, Cmd+R picks up the new version directly —
  //     no need to hand-bump the `?v=` cache-busting suffix in renderer.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.shift) return;
    const k = (input.key || '').toLowerCase();
    const mod = input.meta || input.control;
    const isReload = (mod && k === 'r') || k === 'f5';
    if (!isReload) return;
    event.preventDefault();
    if (dev) win.webContents.reloadIgnoringCache();
  });

  return win;
}

function registerIpc(): void {
  ipc.register();

  ipcMain.handle('orkas.ping', () => {
    return { ok: true, pong: 'pong', ts: storage.nowIso() };
  });

  ipcMain.handle('orkas.appVersion', () => app.getVersion());

  // Synchronous boot bundle for i18n. Renderer's preload calls this via
  // `ipcRenderer.sendSync` BEFORE any DOM scripts run, so the renderer can
  // populate _currentLang + _tables synchronously at module load — first
  // paint shows the user's preferred language with no English flash. Using
  // sendSync (and not the async `config.getLanguage` IPC) is the whole point:
  // an async round-trip schedules a microtask, paint slips through. Reads
  // ~100 KB of locale JSON per renderer boot; SSD-fast.
  ipcMain.on('orkas:bootI18n', (event) => {
    try {
      const lang = appConfig.getLanguage();
      event.returnValue = { ok: true, lang, tables: getRendererTables() };
    } catch (err) {
      log.warn('bootI18n failed', { error: (err as Error)?.message });
      event.returnValue = { ok: false };
    }
  });

  ipcMain.handle('orkas.diagnostics', async () => {
    const sample = {
      nowIso: storage.nowIso(),
      uid: storage.genUserId(),
      cid: storage.genConversationId(),
      safeIdValid: storage.safeId('abc-123_XYZ'),
      safeIdInvalid: storage.safeId('../etc/passwd'),
    };
    const tplNormal = prompts.load('chat_commander', {
      contexts_dir: 'X',
      builtin_agents_dir: 'X', custom_agents_dir: 'X',
      builtin_skills_dir: 'X', custom_skills_dir: 'X',
      agents_index: '', plan_state: '',
      os: 'X', working_dir: 'X', local_exec_state: 'X',
    });
    const tplLen = tplNormal.length;
    const skills = await skillsFeature.listSkills();
    const agentsList = await agentsFeature.listAgents();
    const contextEntries = await contextsFeature.getContextIndexEntries();
    return {
      ok: true,
      env: {
        appRoot: paths.APP_ROOT,
        pcRoot: paths.PC_ROOT,
        wsRoot: paths.WS_ROOT,
        usersFile: paths.USERS_FILE,
      },
      storage: sample,
      prompts: {
        chatNormalBytes: tplLen,
        hasOrganize: prompts.exists('contexts_organize'),
      },
      skills: {
        total: skills.length,
        builtin: skills.filter((s) => s.source === 'builtin').length,
        custom: skills.filter((s) => s.source === 'custom').length,
        ids: skills.map((s) => `${s.source}:${s.id}`),
      },
      agents: {
        total: agentsList.length,
        ids: agentsList.map((a) => a.agent_id),
      },
      contexts: {
        total: contextEntries.length,
        entries: contextEntries.slice(0, 20),
      },
    };
  });
}

async function runBootSelfCheck(): Promise<void> {
  const diag = {
    appRoot: paths.APP_ROOT,
    wsRoot: paths.WS_ROOT,
    promptChatNormal: prompts.exists('chat_commander'),
    promptOrganize: prompts.exists('contexts_organize'),
  };
  log.info('boot self-check', diag);

  // Stage 1: activate the primary user — mkdirs `<uid>/{cloud,local}/*` and
  // pins `CORE_AGENT_AUTH_DIR` to `<uid>/local/config/`. Must run before any
  // feature touches user-scoped paths (every feature goes through
  // `getActiveUserId()`).
  try {
    const rec = users.initActiveUser();
    log.info('active user', { user_id: rec.user_id });
  } catch (err) {
    log.error('failed to activate user', { error: (err as Error).message });
    throw err;
  }

  // Stage 1b: resolve UI language from `<uid>/cloud/config/preferences.json`,
  // falling back to `app.getLocale()` on first boot.
  try {
    const lang = appConfig.initLanguageFromApp();
    log.info('i18n language resolved', { lang });
  } catch (err) { log.warn('i18n init failed', { error: (err as Error).message }); }

  // Stage 2: one-shot migration of any pre-marketplace `data/builtin/{agents,skills}/`
  // tree into the active uid's cloud/. Idempotent via marker file; no-op on fresh
  // installs. After this runs there is no more globally-shared builtin tree — every
  // marketplace install lives at `<uid>/local/marketplace/` and gets reconciled from
  // the cloud `installs.json` manifest.
  try {
    const { migrateLegacyBuiltinToCloud } = await import('./util/migrate-marketplace');
    const out = await migrateLegacyBuiltinToCloud(users.getActiveUserId());
    if (out.moved_agents || out.moved_skills) {
      log.info('legacy builtin migrated', out);
    }
  } catch (err) {
    log.warn('legacy builtin migrate failed', { error: (err as Error).message });
  }

  // Stage 3: clear stale processing=true conversations from a previous crash.
  try { await chatsFeature.sweepStaleProcessing(); }
  catch (err) { log.warn('chats sweep failed', { error: (err as Error).message }); }

  // Stage 4: file_cache orphan sweep — cheap stat-based scan.
  try {
    const uid = users.getActiveUserId();
    if (uid) {
      const mod = await import('./features/file_indexer');
      const { deleted } = await mod.pruneOrphans(uid);
      if (deleted) log.info('file_cache pruned', { deleted });
    }
  } catch (err) { log.warn('file_cache sweep failed', { error: (err as Error).message }); }

  // Stage 5: workspace empty-subdir sweep — clean up legacy per-conv slug
  // dirs that were materialised by bash's defensive mkdir on a turn that
  // produced nothing. Boot-time is the safe moment: no in-flight bash
  // process is holding cwd open. Top-level scan only.
  try {
    const uid = users.getActiveUserId();
    if (uid) {
      const userWs = await import('./features/user_workspace');
      userWs.sweepEmptyConvDirs(uid);
    }
  } catch (err) { log.warn('workspace empty-dir sweep failed', { error: (err as Error).message }); }
}

// `kb-file://<relpath>` — maps a KB-relative path to the active user's
// `<uid>/cloud/contexts/<relpath>` on disk and returns the bytes with an
// explicit Content-Type. Used by the renderer's PDF viewer iframe.
//
// Path extraction is string-based rather than via `new URL()`: Node's
// WHATWG URL parser and Chromium's request normalizer treat non-built-in
// schemes differently, and the resulting `pathname` values can diverge in
// subtle ways (leading slashes, host vs path split). Slicing after the
// scheme and stripping a variable number of slashes is the robust form.
const _KB_FILE_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
};

/**
 * Stream a file on disk back through a `protocol.handle` callback with HTTP
 * Range support — shared by `kb-file://` and `chat-media://`.
 *
 * Why this exists: a `protocol.handle` reply that returns `200` + a
 * `Content-Length` but no `Accept-Ranges` makes Chromium treat the resource
 * as non-seekable. For `<video preload="metadata">` that is fatal — Chromium's
 * metadata probe fetches only the head of the file and then *cancels* its
 * request; when playback later runs past that prefetched head buffer it has no
 * way to resume (the resource is "not range-capable" and the original request
 * is gone), so the `<video>` freezes a few seconds in with no error in the UI.
 * Advertising `Accept-Ranges: bytes` + honouring `206` requests is the fix; it
 * also makes seeking work and lets PDFium fetch only the pages it shows.
 *
 * Also switches the body from `fs.readFileSync` — the old handlers buffered the
 * whole file into memory, so a 200 MB video spiked RSS by 200 MB — to a lazy
 * `fs.createReadStream`.
 *
 * `totalSize` is the caller's already-statted byte length, so we don't `stat`
 * the file a second time.
 */
function serveFileRange(
  request: Request,
  absPath: string,
  contentType: string,
  totalSize: number,
): Response {
  const baseHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=60',
  };
  const range = parseByteRange(request.headers.get('Range'), totalSize);

  if (range === 'unsatisfiable') {
    return new Response('requested range not satisfiable', {
      status: 416,
      headers: { ...baseHeaders, 'Content-Range': `bytes */${totalSize}` },
    });
  }

  const nodeStream = range
    ? fs.createReadStream(absPath, { start: range.start, end: range.end })
    : fs.createReadStream(absPath);
  nodeStream.on('error', (err) => {
    log.warn('media stream error', { absPath, error: (err as Error).message });
  });
  const body = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  if (range) {
    return new Response(body, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${range.start}-${range.end}/${totalSize}`,
        'Content-Length': String(range.end - range.start + 1),
      },
    });
  }
  return new Response(body, {
    headers: { ...baseHeaders, 'Content-Length': String(totalSize) },
  });
}

function registerKbFileProtocol(): void {
  protocol.handle('kb-file', async (request) => {
    const reqUrl = request.url;
    try {
      // URL shape on the wire: `kb-file://kb/<relpath>` — `kb` is a fixed
      // fake host (see renderer `_encodeKbFileUrl`). Tolerate older /
      // unusual normalisations (`kb-file://<seg>/...`, `kb-file:///…`) by
      // extracting the pathname via `new URL`; standard-scheme URLs parse
      // cleanly once a host is present.
      let rel = '';
      try {
        const u = new URL(reqUrl);
        rel = decodeURIComponent(u.pathname || '').replace(/^\/+/, '');
      } catch {
        // Last resort: string split after the scheme + slashes + host.
        const after = reqUrl.replace(/^kb-file:\/*/i, '');
        const noHost = after.includes('/') ? after.slice(after.indexOf('/') + 1) : after;
        rel = decodeURIComponent(noHost.split('?')[0].split('#')[0]);
      }
      if (!rel) {
        log.warn('kb-file: empty rel', { reqUrl });
        return new Response('bad request: empty path', { status: 400 });
      }
      const uid = users.getActiveUserId();
      const root = path.resolve(paths.userContextsDir(uid));
      const abs = path.resolve(root, rel);
      const relCheck = path.relative(root, abs);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        log.warn('kb-file: traversal blocked', { reqUrl, rel });
        return new Response('forbidden', { status: 403 });
      }
      let st: fs.Stats | undefined;
      try { st = fs.statSync(abs); } catch { /* falls through to 404 below */ }
      if (!st || !st.isFile()) {
        log.warn('kb-file: not found', { reqUrl, rel, abs });
        return new Response('not found', { status: 404 });
      }
      log.info('kb-file: serving', { reqUrl, abs, bytes: st.size });
      const ext = path.extname(abs).toLowerCase();
      const contentType = _KB_FILE_MIME[ext] || 'application/octet-stream';
      return serveFileRange(request, abs, contentType, st.size);
    } catch (err) {
      log.warn('kb-file serve failed', { reqUrl, error: (err as Error).message });
      return new Response('error', { status: 500 });
    }
  });
}

// `chat-media://cid/<encCid>/<encName>` — streams a single attachment file
// out of the active user's `<uid>/cloud/chat_attachments/<cid>/` for the
// renderer's `<img>` / `<video>` tags. The two-segment path (fixed host +
// cid + name) sidesteps URL-parser divergence the way `kb-file` does.
//
// All the safety work (name + cid validation, path-traversal guard, file
// existence + regular-file check, extension whitelist) lives inside
// `chat_attachments.resolveAttachmentAbsPath` so the same guard rails get
// unit-tested without spinning up Electron.
// Turn a URL pathname (always leading-slash, URL-encoded) into a real abs
// path on the running OS. On Windows pathnames like `/C:/Users/x/a.png`
// must have the leading `/` stripped to get the real drive-letter path.
// On Unix the pathname IS the abs path.
function _pathnameToAbsPath(pathname: string): string {
  const decoded = decodeURIComponent(pathname || '');
  if (process.platform === 'win32') {
    // Match `/X:/...` or `/X:\...` — strip the synthetic leading slash.
    if (/^\/[A-Za-z]:[\\/]/.test(decoded)) return decoded.slice(1);
  }
  return decoded;
}

// Map resolveLocalMediaPath / resolveAttachmentAbsPath error codes → HTTP.
function _statusFor(code: string | undefined): number {
  if (code === 'bad_input') return 400;
  if (code === 'forbidden') return 403;
  if (code === 'too_large') return 413;
  return 404;
}

function registerChatMediaProtocol(): void {
  protocol.handle('chat-media', async (request) => {
    const reqUrl = request.url;
    try {
      // Two route shapes, dispatched by URL host:
      //   chat-media://cid/<encCid>/<encName>      — per-conversation attachment
      //   chat-media://local/<abs-path-no-leading-slash>  — any local media file
      let u: URL;
      try { u = new URL(reqUrl); }
      catch {
        log.warn('chat-media: unparseable URL', { reqUrl });
        return new Response('bad request', { status: 400 });
      }
      const host = u.host.toLowerCase();

      if (host === 'cid') {
        const segs = decodeURIComponent(u.pathname || '')
          .replace(/^\/+/, '')
          .split('/');
        const cid = segs[0] || '';
        const name = segs.slice(1).join('/');
        if (!cid || !name) {
          log.warn('chat-media/cid: bad URL', { reqUrl });
          return new Response('bad request', { status: 400 });
        }
        const uid = users.getActiveUserId();
        const resolved = chatAttachments.resolveAttachmentAbsPath(uid, cid, name);
        if (!resolved.ok) {
          const code = (resolved as { code?: string }).code;
          log.warn('chat-media/cid: reject', { reqUrl, code, error: (resolved as { error?: string }).error });
          return new Response(String((resolved as { error?: string }).error || code || 'error'), { status: _statusFor(code) });
        }
        const st = fs.statSync(resolved.absPath);
        log.info('chat-media/cid: serving', { abs: resolved.absPath, kind: resolved.kind, bytes: st.size });
        return serveFileRange(request, resolved.absPath, chatAttachments.mediaMimeFor(name), st.size);
      }

      if (host === 'local') {
        // pathname starts with `/`; on Windows the drive-letter prefix needs
        // that leading slash stripped. `_pathnameToAbsPath` handles both.
        // Try media (image/video) first; fall through to preview (pdf/html)
        // on bad-ext only — every other failure (not_found / too_large) is
        // terminal, so we don't mask a real error by re-checking under a
        // different bucket.
        const abs = _pathnameToAbsPath(u.pathname || '');
        let resolved: ReturnType<typeof chatAttachments.resolveLocalMediaPath>
          | ReturnType<typeof chatAttachments.resolveLocalPreviewPath>
          = chatAttachments.resolveLocalMediaPath(abs);
        if (!resolved.ok && (resolved as { code?: string }).code === 'bad_input') {
          // Only retry under preview when the media resolver rejected on extension;
          // path validation errors ('path must be absolute' / 'path required') re-raise.
          const previewTry = chatAttachments.resolveLocalPreviewPath(abs);
          if (previewTry.ok) resolved = previewTry;
        }
        if (!resolved.ok) {
          // Same `(x as {field?: T}).field` access pattern as the cid branch above —
          // tsc's narrow on `if (!resolved.ok)` doesn't always propagate to the
          // error-branch fields here, so go through the type-assertion escape hatch.
          const err = resolved as { code?: string; error?: string };
          log.warn('chat-media/local: reject', { reqUrl, code: err.code, error: err.error });
          return new Response(String(err.error || ''), { status: _statusFor(err.code) });
        }
        const st = fs.statSync(resolved.absPath);
        log.info('chat-media/local: serving', { abs: resolved.absPath, kind: resolved.kind, bytes: st.size });
        return serveFileRange(request, resolved.absPath, chatAttachments.mediaMimeFor(resolved.absPath), st.size);
      }

      log.warn('chat-media: unknown host', { reqUrl, host });
      return new Response('bad request', { status: 400 });
    } catch (err) {
      log.warn('chat-media serve failed', { reqUrl, error: (err as Error).message });
      return new Response('error', { status: 500 });
    }
  });
}

// `chat-app://cid/<encCid>/<encArtifactId>/<relpath...>` — streams the files
// of an LLM-generated interactive web-app artifact out of the active user's
// `<uid>/cloud/chat_artifacts/<cid>/<artifactId>/`. Read-only; every request
// is filtered through `chatArtifacts.resolveArtifactFilePath` (safe-cid /
// safe-artifactId / safe-relpath + `path.relative` traversal guard + served
// extension allowlist + regular-file check). The reserved virtual relpath
// `__orkas/bridge.js` is served from the in-memory `BRIDGE_JS` constant, not
// from disk. Fixed host (`cid`) sidesteps URL-parser divergence the same way
// `chat-media://cid/...` does. `Access-Control-Allow-Origin: *` is set
// defensively — `chat-app://` URLs are only issuable from inside this app.
function _withArtifactCors(resp: Response): Response {
  // Re-wrap so we can add the header without mutating the shared
  // `serveFileRange` helper (kb-file / chat-media must not change). The body
  // stream is passed through untouched — Chromium consumes it once.
  const headers = new Headers(resp.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

function registerChatAppProtocol(): void {
  protocol.handle('chat-app', async (request) => {
    const reqUrl = request.url;
    try {
      let u: URL;
      try { u = new URL(reqUrl); }
      catch {
        log.warn('chat-app: unparseable URL', { reqUrl });
        return new Response('bad request', { status: 400 });
      }
      if (u.host.toLowerCase() !== 'cid') {
        log.warn('chat-app: unknown host', { reqUrl, host: u.host });
        return new Response('bad request', { status: 400 });
      }
      // pathname is `/<encCid>/<encArtifactId>/<relpath...>` (always leading
      // slash, URL-encoded). Decode the whole thing then split — decoding
      // first then splitting on `/` is wrong if a relpath segment contained
      // an encoded slash, but artifact file paths never do (safeRelPath
      // rejects `\0` / `\`, and an encoded `/` would just be a path
      // separator anyway); decode per-segment to be precise.
      const rawSegs = (u.pathname || '').replace(/^\/+/, '').split('/');
      const cid = rawSegs[0] ? decodeURIComponent(rawSegs[0]) : '';
      const artifactId = rawSegs[1] ? decodeURIComponent(rawSegs[1]) : '';
      const relPath = rawSegs.slice(2).map((s) => (s ? decodeURIComponent(s) : '')).join('/');
      if (!cid || !artifactId) {
        log.warn('chat-app: bad URL (need cid + artifactId)', { reqUrl });
        return new Response('bad request', { status: 400 });
      }

      // Reserved virtual path: the runtime bridge script (not on disk).
      if (relPath === chatArtifacts.BRIDGE_RELPATH) {
        return _withArtifactCors(new Response(chatArtifacts.BRIDGE_JS, {
          headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=60' },
        }));
      }

      const uid = users.getActiveUserId();
      const resolved = chatArtifacts.resolveArtifactFilePath(uid, cid, artifactId, relPath);
      if (!resolved.ok) {
        // Cast in the error branch — `strictNullChecks: false` keeps the
        // whole union here (same workaround as the chat-media handler above).
        const code = (resolved as { code?: string }).code;
        const errMsg = (resolved as { error?: string }).error;
        log.warn('chat-app: reject', { reqUrl, code, error: errMsg });
        return new Response(String(errMsg || code || 'error'), { status: _statusFor(code) });
      }
      const st = fs.statSync(resolved.absPath);
      log.info('chat-app: serving', { abs: resolved.absPath, mime: resolved.mime, bytes: st.size });
      return _withArtifactCors(serveFileRange(request, resolved.absPath, resolved.mime, st.size));
    } catch (err) {
      log.warn('chat-app serve failed', { reqUrl, error: (err as Error).message });
      return new Response('error', { status: 500 });
    }
  });
}

// Single-instance lock prevents double-launch from duplicating the backend.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    await runBootSelfCheck();
    // Dev-mode dock icon: packaged macOS picks up .icns from Info.plist,
    // but dev runs the bundled Electron.app's own Info.plist — we must
    // setIcon at runtime to see our logo. The Windows taskbar reads
    // BrowserWindow.icon directly so this branch isn't needed there
    // (same on Linux).
    if (process.platform === 'darwin' && app.dock) {
      const iconPath = path.join(paths.SRC_ROOT, 'resources', 'icons', 'icon.png');
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) app.dock.setIcon(img);
    }
    // Windows taskbar: by default the Electron dev process inherits
    // electron.exe's AppUserModelID, and the taskbar uses that ID to look
    // up the icon → it ends up showing the default Electron logo. Setting
    // our own ID here makes Windows fall back to BrowserWindow.icon.
    // Packaged NSIS writes the same ID.
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.orkas.desktop');
    }
    // Strip the default Electron menu. On macOS we still need a minimal
    // menu bar so native shortcuts (Cmd+C/V/Q/A, Hide, Services, …) keep
    // working — keep only `appMenu` + `editMenu`. On Win/Linux just pass
    // null, which removes the in-window menu bar entirely.
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
      ]));
    } else {
      Menu.setApplicationMenu(null);
    }
    registerKbFileProtocol();
    registerChatMediaProtocol();
    registerChatAppProtocol();
    registerIpc();
    createWindow();

    // Reconnect persisted MCP connector instances + register the before-quit shutdown hook.
    // Independent of account: connectors are machine-local and work for any active uid.
    connectorsFeature.bootstrap(users.getActiveUserId()).catch(() => {
      /* errors logged inside the feature; never block app startup */
    });

    // Background: pick up any out-of-band changes to source files (sync
    // drop-in, manual edits) into the search idx. Query path does not run
    // reconcile — this is the only place it fires during normal op.
    setImmediate(() => {
      const searchLog = createLogger('search');
      searchFeature.reconcileAll().catch((err) => {
        searchLog.warn('startup reconcile failed', { error: err?.message || String(err) });
      });
    });

    // Background: prime auth's dynamic-import caches so the first open of
    // the settings page doesn't wait on core-agent + pi-ai/oauth cold load.
    setImmediate(() => { authFeature.warmup(); });

    // Background: reconcile the KB vector store against disk — picks up files
    // dropped into contexts/ via Finder while the app was off, and swallows
    // any divergence from a just-synced vector.db. Runs async; UI gets live
    // updates through the `kb.events` stream as files transition status.
    setImmediate(async () => {
      const kbLog = createLogger('kb_indexer');
      try {
        const { reconcile } = await import('./features/kb_indexer');
        const uid = users.getActiveUserId();
        await reconcile(uid);
      } catch (err) {
        kbLog.warn('startup reconcile failed', { error: (err as Error).message });
      }
    });

    // Background: per-agent metacognitive reflection. Time-triggered (48h
    // cooldown per agent), not per-turn. Delay so it doesn't race the UI's
    // first paint or the user's first action.
    setTimeout(() => {
      const uid = users.getActiveUserId();
      const reflectLog = createLogger('reflection-trigger');
      reflectionTrigger.runStartupReflections(uid).catch((err) => {
        reflectLog.error('startup reflection batch failed', { error: err?.message || String(err) });
      });
    }, reflectionTrigger.STARTUP_DELAY_MS);

    // Background: scheduled-agent-tasks tick (every 30s). Reads
    // <uid>/cloud/config/scheduled_tasks.json on each tick and dispatches
    // due tasks through the same bus entry point a manual run takes
    // (chats.createConversation + groupChat.send). Idempotent.
    scheduledTasks.startScheduler();

    // Background: prime the marketplace category cache so the first openMarketplace
    // doesn't pay the round-trip on cold start. Errors are swallowed — the lazy
    // path in features/marketplace_biz.ts is the real safety net.
    import('./features/marketplace_biz').then((m) => m.primeCategoryCache()).catch(() => {});

    // Background marketplace setup: (1) seed the default installs manifest on first launch
    // (no manifest file → fetch `/marketplace/defaults` → write a row per official item),
    // (2) reconcile downloads any manifest rows whose local content is missing. Step 1
    // populates the manifest that step 2 consumes; both are fire-and-forget so a slow / down
    // server never blocks UI boot. Reconcile status updates broadcast to renderers so the
    // marketplace panel can show a "syncing" banner — layering keeps `features/` free of
    // `ipc/` imports, broadcast wiring lives here (same pattern as `group_chat.subscribe`).
    (async () => {
      try {
        const mp = await import('./features/marketplace');
        const seeded = await mp.ensureDefaultInstalls(users.getActiveUserId());
        if (seeded.seeded_agents || seeded.seeded_skills) {
          createLogger('marketplace_defaults').info('seeded default installs', seeded);
        }
      } catch (err) {
        createLogger('marketplace_defaults').warn('default installs seed failed', {
          error: (err as Error).message,
        });
      }
      try {
        const m = await import('./features/marketplace_reconcile');
        m.subscribeReconcileStatus((status) => {
          ipc.broadcastToRenderer('marketplace:reconcile-status', status);
        });
        // Server-side update sweep runs first so the manifest leads the per-machine
        // `_install.json` for items the admin has republished — reconcile then picks up the
        // mismatch and re-pulls the new blob. Network failures here are swallowed by the
        // helper itself; reconcile still runs against the stale manifest.
        await m.checkServerUpdatesForInstalls(users.getActiveUserId());
        await m.reconcileInstalls(users.getActiveUserId());
      } catch (err) {
        createLogger('marketplace_reconcile').warn('startup reconcile failed', {
          error: (err as Error).message,
        });
      }
    })();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Flush pending search-index writes + close KB vector DBs before exit.
  let shutdownFlushed = false;
  app.on('before-quit', async (e) => {
    if (shutdownFlushed) return;
    e.preventDefault();
    try { await searchFeature.flushAll(); }
    catch (err) { createLogger('search').warn('final flush failed', { error: (err as Error).message }); }
    try {
      const kb = await import('./features/kb_vector');
      kb.closeAllKb();
    } catch (err) { createLogger('kb_vector').warn('close failed', { error: (err as Error).message }); }
    shutdownFlushed = true;
    app.quit();
  });
}
