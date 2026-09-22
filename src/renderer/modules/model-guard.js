// ─── Model config guard ──────────────────────────────────────────────────
// Central gate that keeps LLM-dependent actions disabled until the user has
// at least one (provider, model, credential) entry. `ensureModelConfigured()`
// is the synchronous action boundary: it short-circuits with an alert and a
// Settings redirect when no model is available. There is intentionally no
// persistent page-level warning; the user only needs guidance when starting
// an action that requires a model.
// Refreshed at boot and after Settings reloads following a successful
// credential/entry transaction, OAuth entry creation, repair, or deletion.

const _guardLog = createLogger('model-guard');

function _modelGuardErrorType(error) {
  return error && typeof error.name === 'string' ? error.name : 'unknown';
}

let _hasConfiguredModel = true;   // optimistic — flipped to false after refresh if empty
let _modelGuardRefreshSequence = 0;

async function refreshModelGuard() {
  const refreshSequence = ++_modelGuardRefreshSequence;
  try {
    const res = await window.orkas.invoke('auth.hasConfiguredModel');
    // Only flip the flag when the IPC returned a definitive answer. A
    // failed call (unknown channel on an old main process, transient
    // error) should leave the UI optimistic rather than lock the user
    // out of every feature. The backend runner still fails loudly on
    // actual sends if no entry exists, so we don't lose correctness.
    if (res && res.ok) {
      const configured = !!res.configured;
      await refreshModelConfigSnapshot();
      if (refreshSequence !== _modelGuardRefreshSequence) return _hasConfiguredModel;
      _hasConfiguredModel = configured;
    } else {
      _guardLog.warn('refresh ipc not-ok', { error: res && res.error });
    }
  } catch (e) {
      _guardLog.warn('refresh failed', { error: (e && e.message) || String(e) });
  }
  if (refreshSequence !== _modelGuardRefreshSequence) return _hasConfiguredModel;
  return _hasConfiguredModel;
}

async function refreshModelConfigSnapshot() {
  try {
    const res = await window.orkas.invoke('auth.listEntries');
    if (res && res.ok && Array.isArray(res.entries)) {
      window.dispatchEvent(new CustomEvent('orkas:model-entries-changed', {
        detail: { entries: res.entries },
      }));
    }
  } catch (err) {
    _guardLog.warn('model config snapshot refresh failed', { error: (err && err.message) || String(err) });
  }
}

function isModelConfigured() {
  return _hasConfiguredModel;
}

/**
 * Synchronous gate used by action handlers before firing an LLM-backed
 * request. Returns `true` when configured (caller proceeds); `false` after
 * showing an alert + bouncing the user to the settings page.
 *
 * `opts.silent === true` skips the alert — useful for background/auto paths
 * (queued sends, polling) where we just want to quietly no-op.
 */
function ensureModelConfigured(opts = {}) {
  if (_hasConfiguredModel) return true;
  if (!opts.silent) {
    const msg = opts.message || t('model_guard.modal');
    try {
      if (typeof uiAlert === 'function') uiAlert(msg);
      else window.alert(msg);
    } catch (_) { /* swallow — alert is best-effort */ }
    if (typeof setView === 'function') {
      setView('settings', null, { entryPoint: 'model_guard_blocked_action' });
    }
    _activateModelCredentialsTab();
  }
  return false;
}

function _activateModelCredentialsTab() {
  const activate = () => {
    if (typeof window.activateSettingsTab !== 'function') return false;
    window.activateSettingsTab('credentials');
    return true;
  };
  // Settings can be initialized lazily by setView(). Its first render uses
  // the default Account tab. Wait for the owning feature when necessary,
  // then repeat on the next turn to win its initial-render race.
  if (!activate()) {
    const load = (typeof loadRendererFeature === 'function')
      ? loadRendererFeature
      : window.loadRendererFeature;
    if (typeof load === 'function') {
      Promise.resolve(load('settings')).then(activate).catch(() => {});
    }
  }
  setTimeout(activate, 0);
}
