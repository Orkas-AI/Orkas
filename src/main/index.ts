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
import { app, BrowserWindow, Menu, ipcMain, nativeImage, protocol, shell } from 'electron';

// Force the user-visible app name to "Orkas" before anything else
// reads it. In dev (running `electron .`) Electron defaults to the
// `name` field in package.json (lowercase "orkas") or — when launched
// without that being effective — to literally "Electron", which leaks
// to the macOS Dock tooltip and the menu bar. Packaged builds set this
// via electron-builder's `productName`; this call covers dev + any
// edge case where productName isn't picked up early.
app.setName('Orkas');

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
  // lets Chromium do byte-range requests on `<video>` seek without us
  // manually implementing Range handling (we hand back a normal Response
  // and Chromium / Electron handles scroll + seek over it).
  {
    scheme: 'chat-media',
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
import * as reflectionTrigger from './features/reflection-trigger';
import * as chatAttachments from './features/chat_attachments';

function createWindow(): BrowserWindow {
  const dev = !app.isPackaged;
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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
        builtinSkillsSource: paths.BUILTIN_SKILLS_SOURCE,
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
    builtinSource: paths.BUILTIN_SKILLS_SOURCE,
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

  // Stage 2: builtin skill content sync from `src/builtin/skills/` →
  // `data/builtin/skills/`. core-agent's SkillLoader picks these up directly
  // from the top-level dir, shared across all uids.
  try {
    skillsFeature.syncBuiltinSkills();
  } catch (err) {
    log.warn('skill bootstrap failed', { error: (err as Error).message });
  }

  // Stage 2b: builtin agents sync (hash-tree; cheap if empty).
  try { agentsFeature.syncBuiltinAgents(); }
  catch (err) { log.warn('builtin-agents sync failed', { error: (err as Error).message }); }

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
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        log.warn('kb-file: not found', { reqUrl, rel, abs });
        return new Response('not found', { status: 404 });
      }
      log.info('kb-file: serving', { reqUrl, abs });
      const ext = path.extname(abs).toLowerCase();
      const contentType = _KB_FILE_MIME[ext] || 'application/octet-stream';
      const buf = fs.readFileSync(abs);
      return new Response(buf, {
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(buf.length),
          // Let Chromium's PDFium cache range fetches for scroll.
          'Cache-Control': 'private, max-age=60',
        },
      });
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
        const buf = fs.readFileSync(resolved.absPath);
        return new Response(buf, {
          headers: {
            'Content-Type': chatAttachments.mediaMimeFor(name),
            'Content-Length': String(buf.length),
            'Cache-Control': 'private, max-age=60',
          },
        });
      }

      if (host === 'local') {
        // pathname starts with `/`; on Windows the drive-letter prefix needs
        // that leading slash stripped. `_pathnameToAbsPath` handles both.
        const abs = _pathnameToAbsPath(u.pathname || '');
        const resolved = chatAttachments.resolveLocalMediaPath(abs);
        if (!resolved.ok) {
          log.warn('chat-media/local: reject', { reqUrl, code: resolved.code, error: resolved.error });
          return new Response(resolved.error, { status: _statusFor(resolved.code) });
        }
        const buf = fs.readFileSync(resolved.absPath);
        log.info('chat-media/local: serving', { abs: resolved.absPath, kind: resolved.kind, bytes: buf.length });
        return new Response(buf, {
          headers: {
            'Content-Type': chatAttachments.mediaMimeFor(resolved.absPath),
            'Content-Length': String(buf.length),
            'Cache-Control': 'private, max-age=60',
          },
        });
      }

      log.warn('chat-media: unknown host', { reqUrl, host });
      return new Response('bad request', { status: 400 });
    } catch (err) {
      log.warn('chat-media serve failed', { reqUrl, error: (err as Error).message });
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
    registerIpc();
    createWindow();

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
