/**
 * Orkas — Electron main entry.
 *
 * Boot sequence:
 *   1. Side-effect import of `./install-data-root` resolves the install
 *      container (`~/.orkas` on macOS/Linux; on Windows a drive recorded
 *      in `%LOCALAPPDATA%\Orkas\install-pin.json`), runs the one-shot
 *      `PC/data` → `<container>/data` migration, and sets
 *      `ORKAS_WORKSPACE_ROOT`. Both dev and packaged go through this
 *      single path — the old dev/prod data-root split is gone. The side
 *      effect lives at module load (not in body code) because esbuild's
 *      CJS transformer hoists imports — `paths.ts` would otherwise load
 *      with an unset env var. See install-data-root.cjs header.
 *   2. Pin CORE_AGENT_AUTH_DIR to <WS_ROOT>/config/ so core-agent's
 *      credential store lives under data/ (local-only, never synced).
 *      The env var name is core-agent's public API — kept as
 *      `AUTH_DIR` for stability even though the dir now also holds
 *      `user.json` and `web-search-cache.json`.
 *   3. Create BrowserWindow loading renderer/index.html.
 *   4. IPC handlers serve invoke + stream calls from the renderer.
 *
 * File location: `PC/src/main/index.ts`. `bootstrap.cjs`'s
 * `require('./src/main')` resolves here automatically via Node's
 * folder → index resolution rule. `__dirname` points at `PC/src/main/`;
 * cross-tree references to renderer / resources go through
 * `paths.SRC_ROOT` — never splice `__dirname` directly.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { app, BrowserWindow, Menu, ipcMain, nativeImage, net, protocol, session, shell } from 'electron';
// Side-effect import: at module-load time this resolves the install
// container, runs the one-shot PC/data → <container>/data migration, and
// sets process.env.ORKAS_WORKSPACE_ROOT. Must be the FIRST project import
// — any module loaded before this would not see the env var. See
// install-data-root.cjs header for why the side effect lives at load time
// rather than in index.ts body (esbuild CJS hoists imports → body runs
// after paths.ts loads, which is too late to set the env var).
import './install-data-root.cjs';
import { desktopPlatform, osVersion } from './system_info';

const APP_USER_MODEL_ID = 'com.orkas.desktop';
const MARKETPLACE_DEFAULTS_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const MARKETPLACE_SERVER_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const MARKETPLACE_DEFAULTS_RETRY_DELAYS_MS = [3_000, 3_000, 3_000] as const;

// Source and packaged builds share one app identity and one server
// environment: global prod. This keeps local data paths and OS app grouping
// stable across run modes.
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
  // `chat-media://cid/<encCid>/<encName>` — serves image + video bytes for a
  // cid attachment. Sent attachments resolve under cloud/chat_attachments/;
  // composer-only draft cids resolve under local/chat_attachment_drafts/.
  // `stream:true`
  // only enables a streamed Response body — it does NOT make Chromium issue
  // byte-range requests on its own; the handler must advertise
  // `Accept-Ranges: bytes` and serve `206` itself (see `serveFileRange`).
  // Without that, `<video preload="metadata">` freezes a few seconds in
  // because Chromium can't resume past the cancelled metadata-probe fetch.
  {
    scheme: 'chat-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  // `chat-app://cid/<encCid>/<encArtifactId>/<relpath>` serves chat artifacts;
  // `chat-app://saved/<encAppId>/<relpath>` serves user-kept "My Apps" bundles.
  // Both are embedded in sandboxed iframes.
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

import * as paths from './paths';
import { parseByteRange } from './util/http-range';
import { registerDeferred, runBootPhases } from './util/boot_init';

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
const marketplaceBootLog = createLogger('marketplace_boot');

// Replay any pin / migration warnings buffered by install-data-root
// (which runs before logger.ts can be imported) into the daily log.
import { flushEarlyDiagnostics } from './install-data-root.cjs';
{
  const installLog = createLogger('install-data-root');
  flushEarlyDiagnostics((m) => installLog.warn(m));
}

// Raise Anthropic / OpenAI SDK default timeouts before any feature (which may
// transitively pull in pi-ai) loads them. See sdk-timeout-patch.ts.
import { installSdkTimeoutPatch } from './model/core-agent/sdk-timeout-patch';
installSdkTimeoutPatch();

// Keep SSE as the preferred model transport, but do not let a provider-local
// response-header failfast preempt Orkas' own turn-level abort/watchdog policy.
import { installSseHeaderTimeoutPatch } from './model/core-agent/sse-header-timeout-patch';
installSseHeaderTimeoutPatch();

// Provider-fetch diagnostics: dump the real undici cause chain for model
// endpoint failures.
import { installFetchDiag } from './model/core-agent/fetch-diag';
installFetchDiag();

import { setFetchImplementation } from './util/retry';
setFetchImplementation((input, init) => net.fetch(input as Parameters<typeof net.fetch>[0], init));

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
import * as reflectionOrchestrator from './features/reflection-orchestrator';
import * as autoTasks from './features/auto_tasks';
import * as systemSkills from './features/system_skills';
import * as builtinMarketplace from './features/builtin_marketplace';
import * as chatAttachments from './features/chat_attachments';
import * as chatArtifacts from './features/chat_artifacts';
import * as savedApps from './features/saved_apps';
import * as clientConfigFeature from './features/client_config';
import * as connectorsFeature from './features/connectors';
import * as windowState from './features/window_state';
// Server-backed account, multi-device sync, remote-control relay, and
// auto-update features are stripped in the open-source build. Connectors remain available
// through the open server bridge.

function createWindow(): BrowserWindow {
  const dev = !app.isPackaged;
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
  //   - Cmd/Ctrl+Shift+R is NOT intercepted here: it's the renderer-side
  //     devtools "relaunch" chord (calls `app.relaunch()`), so we let it
  //     fall through to renderer keydown.
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

  ipcMain.handle('orkas.env', () => {
    const systemVersion = osVersion();
    const platform = desktopPlatform();
    return {
      ok: true,
      isDev: !app.isPackaged,
      isPackaged: app.isPackaged,
      version: app.getVersion(),
      platform,
      osVersion: systemVersion,
      arch: process.arch,
    };
  });

  if (!app.isPackaged) {
    // The relaunch button shells out to run.sh / run.cmd instead of using
    // `app.relaunch()` so we can reuse `scripts/ensure-deps.cjs` for
    // dependency self-healing — otherwise pulling new code + relaunching
    // crashes immediately due to missing packages. The shell script handles
    // ensure-deps + killing the old electron + npm start; here we just
    // detach-spawn it and call `app.exit(0)`.
    ipcMain.handle('orkas.relaunch', () => {
      const isWin = process.platform === 'win32';
      const script = path.join(paths.PC_ROOT, isWin ? 'run.cmd' : 'run.sh');
      const [cmd, args] = isWin
        ? ['cmd.exe', ['/c', script]] as const
        : ['bash',    [script]]       as const;
      const child = spawn(cmd, args, {
        cwd: paths.PC_ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      log.info('relaunch via shell script', { script });
      app.exit(0);
      return { ok: true };
    });
  }

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
      os: 'X', working_dir: 'X', shell_hint: '', local_exec_state: 'X',
      output_format_hint: 'X',
      project_files_block: '',
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
        marketplace: skills.filter((s) => s.source === 'marketplace').length,
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

  // Stage 2: clear stale processing=true conversations from a previous crash.
  try { await chatsFeature.sweepStaleProcessing(); }
  catch (err) { log.warn('chats sweep failed', { error: (err as Error).message }); }

}

async function runBootMaintenanceSweeps(): Promise<void> {
  // file_cache orphan sweep — stat-based maintenance, not needed before the
  // first BrowserWindow exists.
  try {
    const uid = users.getActiveUserId();
    if (uid) {
      const mod = await import('./features/file_indexer');
      const { deleted } = await mod.pruneOrphans(uid);
      if (deleted) log.info('file_cache pruned', { deleted });
    }
  } catch (err) { log.warn('file_cache sweep failed', { error: (err as Error).message }); }

  // Workspace empty-subdir sweep — clean up legacy per-conv slug dirs that
  // were materialised by bash's defensive mkdir on a turn that produced
  // nothing. Deferred boot is still safe: no in-flight bash process exists
  // this early in the app lifetime. Top-level scan only.
  try {
    const uid = users.getActiveUserId();
    if (uid) {
      const userWs = await import('./features/user_workspace');
      userWs.sweepEmptyConvDirs(uid);
    }
  } catch (err) { log.warn('workspace empty-dir sweep failed', { error: (err as Error).message }); }
}

let marketplaceReconcileStatusSubscribed = false;
let marketplaceReconcileInFlight: Promise<void> | null = null;
let marketplaceReconcileInFlightKey = '';
const marketplaceDefaultsRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const marketplaceDefaultsRetryAttempts = new Map<string, number>();

function subscribeMarketplaceReconcileStatus(m: typeof import('./features/marketplace_reconcile')): void {
  if (marketplaceReconcileStatusSubscribed) return;
  marketplaceReconcileStatusSubscribed = true;
  m.subscribeReconcileStatus((status) => {
    ipc.broadcastToRenderer('marketplace:reconcile-status', status);
  });
}

function marketplaceBootContextStillActive(uid: string): boolean {
  if (!uid || users.isAnonymousLocalId(uid)) return false;
  try { return users.getActiveUserId() === uid; }
  catch { return false; }
}

function clearMarketplaceDefaultsRetry(runKey: string): void {
  const timer = marketplaceDefaultsRetryTimers.get(runKey);
  if (timer) clearTimeout(timer);
  marketplaceDefaultsRetryTimers.delete(runKey);
  marketplaceDefaultsRetryAttempts.delete(runKey);
}

function scheduleMarketplaceDefaultsRetry(runKey: string, uid: string, error: string): void {
  if (marketplaceDefaultsRetryTimers.has(runKey)) return;
  const attempt = marketplaceDefaultsRetryAttempts.get(runKey) || 0;
  const delayMs = MARKETPLACE_DEFAULTS_RETRY_DELAYS_MS[attempt];
  if (delayMs === undefined) {
    marketplaceBootLog.warn('marketplace default installs retry exhausted', { error });
    marketplaceDefaultsRetryAttempts.delete(runKey);
    return;
  }
  marketplaceDefaultsRetryAttempts.set(runKey, attempt + 1);
  const timer = setTimeout(() => {
    marketplaceDefaultsRetryTimers.delete(runKey);
    if (!marketplaceBootContextStillActive(uid)) {
      marketplaceDefaultsRetryAttempts.delete(runKey);
      return;
    }
    runMarketplaceInstallReconcile('marketplace-defaults-retry').catch((err) => {
      marketplaceBootLog.warn('marketplace default installs retry failed', {
        error: (err as Error).message,
      });
    });
  }, delayMs);
  timer.unref?.();
  marketplaceDefaultsRetryTimers.set(runKey, timer);
  marketplaceBootLog.info('scheduled marketplace default installs retry', {
    attempt: attempt + 1,
    delay_ms: delayMs,
    error,
  });
}

async function runMarketplaceInstallReconcile(reason: string): Promise<void> {
  const uid = users.getActiveUserId();
  if (!marketplaceBootContextStillActive(uid)) {
    marketplaceBootLog.info('skip marketplace reconcile: local user unavailable', { reason });
    return;
  }

  const runKey = uid;
  if (marketplaceReconcileInFlight && marketplaceReconcileInFlightKey === runKey) {
    await marketplaceReconcileInFlight;
    return;
  }

  const shouldContinue = (): boolean => marketplaceBootContextStillActive(uid);
  marketplaceReconcileInFlightKey = runKey;
  marketplaceReconcileInFlight = (async () => {
    let defaultSeedStatusActive = false;
    let marketplaceReconcileModule: typeof import('./features/marketplace_reconcile') | null = null;
    const clearDefaultSeedStatus = (): void => {
      if (marketplaceReconcileModule && defaultSeedStatusActive) {
        marketplaceReconcileModule.setDefaultInstallSeedStatus(false);
        defaultSeedStatusActive = false;
      }
    };

    try {
      const [mp, m] = await Promise.all([
        import('./features/marketplace'),
        import('./features/marketplace_reconcile'),
      ]);
      marketplaceReconcileModule = m;
      subscribeMarketplaceReconcileStatus(m);

      if (await mp.hasKnownDefaultInstallWork(uid)) {
        m.setDefaultInstallSeedStatus(true);
        defaultSeedStatusActive = true;
      }

      if (!shouldContinue()) {
        clearDefaultSeedStatus();
        return;
      }

      const forceMarketplaceNetwork = reason === 'marketplace-defaults-retry';
      const seeded = await mp.ensureDefaultInstalls(uid, {
        shouldContinue,
        minIntervalMs: forceMarketplaceNetwork ? 0 : MARKETPLACE_DEFAULTS_REFRESH_INTERVAL_MS,
        force: forceMarketplaceNetwork,
      });
      if (seeded.failed) {
        clearDefaultSeedStatus();
        scheduleMarketplaceDefaultsRetry(runKey, uid, seeded.error || 'unknown error');
      } else {
        clearMarketplaceDefaultsRetry(runKey);
      }
      if ((seeded.seeded_agents || seeded.seeded_skills) && !defaultSeedStatusActive) {
        m.setDefaultInstallSeedStatus(true);
        defaultSeedStatusActive = true;
      }

      if (!shouldContinue()) {
        clearDefaultSeedStatus();
        return;
      }

      await m.checkServerUpdatesForInstalls(uid, {
        shouldContinue,
        minIntervalMs: MARKETPLACE_SERVER_CHECK_INTERVAL_MS,
      });
      const result = await m.reconcileInstalls(uid, { shouldContinue });
      if (
        result.pulled_agents || result.pulled_skills
        || result.pruned_agents || result.pruned_skills
        || result.restored_agents || result.restored_skills
        || result.patched_agents || result.patched_skills
      ) {
        marketplaceBootLog.info('marketplace install reconcile completed', { reason, ...result });
      }
    } catch (err) {
      clearDefaultSeedStatus();
      marketplaceBootLog.warn('marketplace install reconcile failed', {
        reason,
        error: (err as Error).message,
      });
    }
  })().finally(() => {
    if (marketplaceReconcileInFlightKey === runKey) {
      marketplaceReconcileInFlight = null;
      marketplaceReconcileInFlightKey = '';
    }
  });
  await marketplaceReconcileInFlight;
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

// `chat-media://cid/<encCid>/<encName>` — streams a single attachment file for
// the renderer's `<img>` / `<video>` tags. Sent attachments resolve under
// cloud/chat_attachments/; composer-only draft cids resolve under local drafts.
// The two-segment path (fixed host +
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

// `chat-app://cid/<encCid>/<encArtifactId>/<relpath...>` streams LLM-generated
// chat artifacts; `chat-app://saved/<encAppId>/<relpath...>` streams saved
// "My Apps" bundles. Both are read-only and every disk request is filtered
// through a feature resolver (safe ids / safe relpath / traversal guard /
// served-extension allowlist / regular-file check). The reserved virtual
// relpath `__orkas/bridge.js` is served from the in-memory `BRIDGE_JS`
// constant, not from disk. Fixed hosts sidestep URL-parser divergence the same
// way `chat-media://cid/...` does. `Access-Control-Allow-Origin: *` is set
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
      const host = u.host.toLowerCase();
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

      if (host === 'saved') {
        const appId = cid;
        const savedRelPath = rawSegs.slice(1).map((s) => (s ? decodeURIComponent(s) : '')).join('/');
        if (!appId) {
          log.warn('chat-app/saved: bad URL (need appId)', { reqUrl });
          return new Response('bad request', { status: 400 });
        }
        if (savedRelPath === chatArtifacts.BRIDGE_RELPATH) {
          return _withArtifactCors(new Response(chatArtifacts.BRIDGE_JS, {
            headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=60' },
          }));
        }
        const uid = users.getActiveUserId();
        const resolved = savedApps.resolveSavedAppFilePath(uid, appId, savedRelPath);
        if (!resolved.ok) {
          const code = (resolved as { code?: string }).code;
          const errMsg = (resolved as { error?: string }).error;
          log.warn('chat-app/saved: reject', { reqUrl, code, error: errMsg });
          return new Response(String(errMsg || code || 'error'), { status: _statusFor(code) });
        }
        const st = fs.statSync(resolved.absPath);
        log.info('chat-app/saved: serving', { abs: resolved.absPath, mime: resolved.mime, bytes: st.size });
        return _withArtifactCors(serveFileRange(request, resolved.absPath, resolved.mime, st.size));
      }

      if (host !== 'cid') {
        log.warn('chat-app: unknown host', { reqUrl, host: u.host });
        return new Response('bad request', { status: 400 });
      }
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
    // Source-run macOS uses Electron.app's own Info.plist, so set the dock
    // icon at runtime. Packaged builds still pick up the configured icns.
    if (process.platform === 'darwin' && app.dock) {
      const iconPath = path.join(paths.SRC_ROOT, 'resources', 'icons', 'icon.png');
      const img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) app.dock.setIcon(img);
    }
    if (process.platform === 'win32') {
      app.setAppUserModelId(APP_USER_MODEL_ID);
    }
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
    // Renderer permission gate. Voice input is stripped from the open-source build, so media
    // capture is denied; clipboard permissions are kept for copy/paste flows.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'clipboard-read' || permission === 'clipboard-sanitized-write');
    });
    registerIpc();
    clientConfigFeature.clientConfig.subscribeAll((keys) => {
      ipc.broadcastToRenderer('client-config:changed', { keys });
    });
    const CLIENT_CONFIG_STARTUP_DELAY_MS = 8_000;
    const CONNECTORS_BOOTSTRAP_DELAY_MS = 5_000;
    const BOOT_BACKGROUND_DEFER_MS = 6_000;
    clientConfigFeature.start({
      startupDelayMs: CLIENT_CONFIG_STARTUP_DELAY_MS,
      forceStartupRefresh: false,
    });
    const connectorsTimer = setTimeout(() => {
      connectorsFeature.bootstrap(users.getActiveUserId()).catch(() => {
        /* errors logged inside the feature; never block app startup */
      });
    }, CONNECTORS_BOOTSTRAP_DELAY_MS);
    connectorsTimer.unref?.();
    createWindow();

    // Boot tasks declared via util/boot_init.ts. Two phases × two modes:
    //
    //   registerImmediate(name, fn[, 'serial'])  → runs now, parallel by default
    //   registerDeferred(name, fn[, 'serial'])   → runs after BOOT_BACKGROUND_DEFER_MS
    //
    // The runner swallows per-task errors (logged at warn) so one bad
    // module can't keep the rest of boot from progressing. Slow tasks
    // (>1.5s) emit a warn so regressions show up in the boot log.
    //
    // Replaces the pre-existing `setImmediate(...)` / `setTimeout(...)` /
    // `import().then()` / async-IIFE soup that had grown around here.

    registerDeferred('auth:warmup', () => authFeature.warmup());
    registerDeferred('boot:maintenance-sweeps', () => runBootMaintenanceSweeps());
    registerDeferred('search:reconcile', () => searchFeature.reconcileAll());
    registerDeferred('kb:reconcile', async () => {
      // Picks up files dropped into contexts/ via Finder while the app was
      // off + any divergence from a just-synced vector.db. UI gets live
      // updates through the `kb.events` stream as files transition status.
      const { reconcile } = await import('./features/kb_indexer');
      await reconcile(users.getActiveUserId());
    });
    registerDeferred('marketplace:prime-cache', async () => {
      // Primes the in-memory category cache from disk/fallback only; the lazy
      // path in features/marketplace_biz.ts refreshes from Server when needed.
      const m = await import('./features/marketplace_biz');
      await m.primeCategoryCache({ localOnly: true });
    });
    registerDeferred('marketplace:reconcile', () => runMarketplaceInstallReconcile('startup'));

    // Deferred after the renderer has had a few seconds to paint. Per-agent
    // metacognitive reflection (single 12h-chained loop; the delay just stops
    // the first cycle from racing first paint) and the auto-tasks per-task
    // setTimeout scheduler bootstrap.
    registerDeferred('reflection:loop', () => {
      reflectionOrchestrator.startReflectionLoop(users.getActiveUserId());
    });
    registerDeferred('system-skills:reconcile', () => systemSkills.reconcileAllForActiveUserWithRetry({ retries: 2, reason: 'startup' }));
    registerDeferred('builtin-marketplace:seed', () => builtinMarketplace.seedBuiltinMarketplaceForUser(users.getActiveUserId()));
    registerDeferred('auto-tasks:scheduler', () => autoTasks.startScheduler());

    // Drive the immediate batch + schedule the deferred one.
    void runBootPhases(BOOT_BACKGROUND_DEFER_MS);

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
