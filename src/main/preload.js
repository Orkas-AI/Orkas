/**
 * Preload — exposes a minimal, explicitly-whitelisted API to the renderer
 * via contextBridge. No other Node capabilities leak into window.
 *
 * Contract (renderer-visible surface):
 *   window.orkas.ping()                            → { ok, pong, ts }
 *   window.orkas.diagnostics()                     → boot-time summary
 *   window.orkas.invoke(channel, payload)          → { ok, ...result } | { ok:false, error }
 *   window.orkas.stream(channel, payload, onEvent) → { promise, cancel }
 *       - promise resolves when the stream ends (normally or cancelled)
 *       - cancel() aborts the stream
 *       - onEvent(ev) called with each SSE-shape event
 *
 * Why {promise, cancel} instead of AbortSignal: with sandbox+contextIsolation
 * in place, objects crossing contextBridge have their prototype chain
 * stripped, so an AbortSignal from the renderer loses addEventListener.
 * A plain function is cloneable across contexts.
 *
 * Channel names are free-form strings routed by main/ipc/index.js.
 */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Synchronous i18n boot — handed to the renderer via contextBridge before any
// renderer-side script runs. The renderer's i18n module reads window.__orkasI18nBoot
// at script-tag execution time (line 1118 of index.html, after all data-i18n
// elements have been parsed), so applyDomI18n() can translate the DOM before
// the first paint. Falls back to a null bundle on failure — i18n.js then runs
// its old async initI18n() path. sendSync blocks for one short IPC round-trip
// (~1-2 ms); the trade is paying that for zero language-flash on startup.
let _i18nBoot = null;
try {
  const res = ipcRenderer.sendSync('orkas:bootI18n');
  if (res && res.ok && res.lang && res.tables && Object.prototype.hasOwnProperty.call(res.tables, res.lang)) {
    _i18nBoot = { lang: res.lang, tables: res.tables };
  }
} catch (_) { /* main not ready / handler missing → renderer falls back to async */ }

let _streamCounter = 0;
function nextRequestId() {
  _streamCounter += 1;
  return `r${Date.now().toString(36)}-${_streamCounter.toString(36)}`;
}

function invoke(channel, payload) {
  return ipcRenderer.invoke('orkas.invoke', { channel, payload: payload || {} });
}

/**
 * Resolve genuine DOM File objects to OS paths inside preload and immediately
 * hand them to main. Raw paths are never exposed to renderer JavaScript, and
 * file bytes never cross contextBridge/base64 IPC.
 *
 * Scopes: `contexts` (Library), `project` (project files), `conversation`
 * (composer attachments for `opts.cid`). `opts.onResolved(indexes)` — when
 * given — is called synchronously, before main starts copying, with the
 * positions of the Files that resolved to a path; the composer paints their
 * chips immediately and byte-uploads only the path-less rest. Indexes carry
 * no path data.
 */
function importLocalFiles(scope, files, opts) {
  const list = Array.isArray(files) ? files : Array.from(files || []);
  const entries = [];
  list.slice(0, 200).forEach((file, index) => {
    try {
      const localPath = webUtils && typeof webUtils.getPathForFile === 'function'
        ? webUtils.getPathForFile(file)
        : '';
      if (!localPath) return;
      entries.push({
        index,
        path: localPath,
        name: String((file && file.name) || ''),
        size: Math.max(0, Number((file && file.size) || 0)),
      });
    } catch (_) { /* synthetic/non-local File; caller can use the small-file fallback */ }
  });
  if (opts && typeof opts.onResolved === 'function') {
    try { opts.onResolved(entries.map((entry) => entry.index)); }
    catch (_) { /* renderer callback must not block the import */ }
  }
  const importScope = scope === 'project'
    ? 'project'
    : scope === 'conversation' ? 'conversation' : 'contexts';
  return ipcRenderer.invoke('orkas.importLocalFiles', {
    scope: importScope,
    projectId: opts && opts.projectId ? String(opts.projectId) : '',
    targetDir: opts && opts.targetDir ? String(opts.targetDir) : '',
    cid: opts && opts.cid ? String(opts.cid) : '',
    entries,
  });
}

/**
 * Fire-and-forget log record forwarded to main, where it lands in the
 * daily file under a `renderer/<module>` scope. Use via the renderer-side
 * `createLogger(module)` wrapper — never call this directly from UI code.
 */
function logRecord(record) {
  try {
    // invoke is awaited-able but callers don't need to; swallow errors so
    // a logging failure never breaks user interaction.
    ipcRenderer.invoke('orkas.invoke', {
      channel: 'log.record',
      payload: record || {},
    }).catch(() => {});
  } catch (_) { /* preload must not throw */ }
}

// Push-event subscription — for main-initiated broadcasts where the renderer doesn't drive
// the lifecycle (unlike `stream` which the renderer starts). Channel names are restricted to
// a known prefix list so the renderer can't tap into arbitrary internal IPC traffic.
const PUSH_EVENT_CHANNELS = new Set([
  'conversation:media_materialized',
  'conversation:task_terminal',
  'local-agent:permission',
  'local-agent:permission_cancelled',
  'local-agent:user-input',
  'local-agent:user-input_cancelled',
]);
// Local feature lifecycle events cross the same scoped push bridge.
const PUSH_EVENT_PREFIXES = ['marketplace:', 'conversations:', 'connectors:', 'web-assist:', 'client-config:', 'delete_file.', 'bridge:', 'bash:', 'folder:', 'interactive-cli:', 'projects:'];
function isAllowedPushChannel(channel) {
  if (typeof channel !== 'string') return false;
  return PUSH_EVENT_CHANNELS.has(channel) || PUSH_EVENT_PREFIXES.some((p) => channel.startsWith(p));
}

/** Subscribe to a main-initiated push event. Returns an `unsubscribe()` function.
 *  Throws if the channel isn't in the allow-list (see PUSH_EVENT_PREFIXES). */
function onPushEvent(channel, handler) {
  if (!isAllowedPushChannel(channel)) {
    throw new Error(`push channel not allowed: ${channel}`);
  }
  if (typeof handler !== 'function') throw new Error('handler must be a function');
  const listener = (_evt, payload) => {
    try { handler(payload); } catch (_) { /* swallow — listener must not throw */ }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function stream(channel, payload, onEvent) {
  const requestId = nextRequestId();
  const channelKey = `stream:${requestId}`;
  let settled = false;
  let cancelled = false;

  const promise = new Promise((resolve, reject) => {
    const listener = (_evt, ev) => {
      if (!ev || settled) return;
      if (ev.type === 'done') {
        settled = true;
        ipcRenderer.removeListener(channelKey, listener);
        if (cancelled) reject(Object.assign(new Error('stream cancelled'), { name: 'AbortError' }));
        else resolve();
        return;
      }
      try { onEvent && onEvent(ev); }
      catch (err) {
        settled = true;
        ipcRenderer.removeListener(channelKey, listener);
        ipcRenderer.send('orkas.streamCancel', requestId);
        reject(err);
      }
    };

    ipcRenderer.on(channelKey, listener);
    ipcRenderer.send('orkas.streamStart', { requestId, channel, payload: payload || {} });
  });

  const cancel = () => {
    if (settled || cancelled) return;
    cancelled = true;
    ipcRenderer.send('orkas.streamCancel', requestId);
  };

  return { promise, cancel };
}

// Quality validator — renderer reads persisted ValidationReports to display the
// violation list when a write / install was rejected.
const quality = {
  readSkillReport: (id) => invoke('quality.readSkillReport', { id }),
  readAgentReport: (id) => invoke('quality.readAgentReport', { id }),
};

// Global recycle bin. Unlike `sync`, this stays available in offline builds:
// it contains both cloud-sync tombstones (when sync exists) and local in-app
// delete snapshots.
const recycleBin = {
  list: () => invoke('recycle.list'),
  restore: (id) => invoke('recycle.restore', { id: String(id || '') }),
  delete: (id) => invoke('recycle.delete', { id: String(id || '') }),
};

// Expose the sync-fetched i18n bundle on its own bridge key so the renderer
// can pick it up at module load. Read-only — the renderer never mutates it.
contextBridge.exposeInMainWorld('__orkasI18nBoot', _i18nBoot);

contextBridge.exposeInMainWorld('orkas', {
  ping: () => ipcRenderer.invoke('orkas.ping'),
  diagnostics: () => ipcRenderer.invoke('orkas.diagnostics'),
  importLocalFiles,
  env: () => ipcRenderer.invoke('orkas.env'),
  relaunch: () => ipcRenderer.invoke('orkas.relaunch'),
  reportUserActivity: () => ipcRenderer.send('orkas.userActivity'),
  getNativeSearchEnabled: () => invoke('devtools.getNativeSearchEnabled'),
  setNativeSearchEnabled: (enabled) => invoke('devtools.setNativeSearchEnabled', { enabled }),
  getLanguage: () => invoke('config.getLanguage'),
  setLanguage: (language) => invoke('config.setLanguage', { language }),
  getLocales: () => invoke('config.getLocales'),
  recycleBin,
  quality,
  invoke,
  stream,
  onPushEvent,
  log: logRecord,
});

// Final-package launch smoke. The main process adds this private renderer
// argument only when the release validator starts an isolated hidden window.
// A successful ping proves the preload bridge and main IPC handler both ran;
// DOMContentLoaded proves the packaged renderer was read and initialized.
if (process.argv.includes('--orkas-packaged-launch-smoke')) {
  window.addEventListener('DOMContentLoaded', () => {
    ipcRenderer.invoke('orkas.ping')
      .then((ping) => ipcRenderer.invoke('orkas.packagedLaunchSmokeReady', {
        preloadLoaded: true,
        ping: ping && ping.pong,
        rendererReadyState: document.readyState,
      }))
      .catch((error) => {
        console.error('[packaged-launch-smoke] preload/renderer readiness failed', error);
      });
  }, { once: true });
}
