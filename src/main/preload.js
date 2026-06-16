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

const { contextBridge, ipcRenderer } = require('electron');

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
const PUSH_EVENT_PREFIXES = ['marketplace:', 'conversations:', 'connectors:', 'client-config:', 'delete_file.', 'bridge:', 'bash:'];
function isAllowedPushChannel(channel) {
  if (typeof channel !== 'string') return false;
  return PUSH_EVENT_PREFIXES.some((p) => channel.startsWith(p));
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
    if (settled) return;
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
  env: () => ipcRenderer.invoke('orkas.env'),
  relaunch: () => ipcRenderer.invoke('orkas.relaunch'),
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
