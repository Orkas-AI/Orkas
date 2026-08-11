// ─── Model config guard ──────────────────────────────────────────────────
// Central gate that keeps LLM-dependent features disabled until the user
// has at least one (provider, model, credential) entry. Two surfaces:
//   1) a persistent banner pinned above the main content area that links
//      to the settings page (hidden on settings itself);
//   2) `ensureModelConfigured()`, a synchronous check that action handlers
//      call before firing an LLM-backed request — it short-circuits with
//      an alert + settings redirect when the user hasn't configured a
//      model yet, so every action path fails the same way.
// Refreshed at boot and after Settings reloads following a successful
// credential/entry transaction, OAuth entry creation, repair, or deletion.

const _guardLog = createLogger('model-guard');

function _modelGuardErrorType(error) {
  return error && typeof error.name === 'string' ? error.name : 'unknown';
}

let _hasConfiguredModel = true;   // optimistic — flipped to false after refresh if empty
let _guardBannerEl = null;
let _guardChecked = false;
let _modelGuardRefreshSequence = 0;
let _modelConfigSnapshotSignature = '';

function _ensureGuardBanner() {
  if (_guardBannerEl) return _guardBannerEl;
  const main = document.querySelector('.main-content');
  if (!main) return null;
  const el = document.createElement('div');
  el.className = 'model-guard-banner';
  el.id = 'model-guard-banner';
  el.style.display = 'none';
  const dotIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('dot', 'ui-icon')
    : '';
  el.innerHTML = `
    <span class="model-guard-icon" aria-hidden="true">${dotIcon}</span>
    <span class="model-guard-text">${escapeHtml(t('model_guard.banner'))}</span>
    <button type="button" class="btn btn-sm btn-primary model-guard-cta">${escapeHtml(t('model_guard.cta'))}</button>
  `;
  el.querySelector('.model-guard-cta').addEventListener('click', () => {
    if (typeof setView === 'function') {
      setView('settings', null, { entryPoint: 'model_guard_banner' });
    }
    // Drop the user straight on the 配置 (Credentials) tab — that's where
    // the model-auth UI lives now (Phase 4 4-tab restructure).
    _activateModelCredentialsTab();
  });
  // Keep this one in sync when user toggles language.
  window.addEventListener('i18n-change', () => {
    if (!_guardBannerEl) return;
    const txt = _guardBannerEl.querySelector('.model-guard-text');
    const cta = _guardBannerEl.querySelector('.model-guard-cta');
    if (txt) txt.textContent = t('model_guard.banner');
    if (cta) cta.textContent = t('model_guard.cta');
  });
  // Pin to the top of the main content area so it's visible on every view
  // except settings (see CSS: `.panel-settings-active .model-guard-banner`).
  main.insertBefore(el, main.firstChild);
  _guardBannerEl = el;
  return el;
}

function _applyGuardVisuals() {
  const banner = _ensureGuardBanner();
  if (banner) banner.style.display = _hasConfiguredModel ? 'none' : '';
  document.body.classList.toggle('model-not-configured', !_hasConfiguredModel);
  syncModelGuardBannerTelemetry();
}

/** Called after both model-state refreshes and logical view changes. The CSS
 * hides this banner on Settings, so only count an impression on a view where
 * the user can actually see it. */
function syncModelGuardBannerTelemetry() {
  const visible = !_hasConfiguredModel
    && _modelGuardSourceView() !== 'settings'
    && !!_guardBannerEl
    && _guardBannerEl.style.display !== 'none';
  if (visible && !_guardBannerTelemetryVisible && window.Monitor) {
    Monitor.event('model_guard_banner_impression', _modelGuardTelemetryPayload());
  }
  _guardBannerTelemetryVisible = visible;
}

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
      const telemetryContext = configured
        ? null
        : await _refreshModelGuardTelemetryContext();
      await refreshModelConfigSnapshot();
      if (refreshSequence !== _modelGuardRefreshSequence) return _hasConfiguredModel;
      _hasConfiguredModel = configured;
      _guardChecked = true;
      if (telemetryContext) _guardTelemetryContext = telemetryContext;
    } else {
      _guardLog.warn('refresh ipc not-ok', { error: res && res.error });
    }
  } catch (e) {
      _guardLog.warn('refresh failed', { error: (e && e.message) || String(e) });
  }
  if (refreshSequence !== _modelGuardRefreshSequence) return _hasConfiguredModel;
  _applyGuardVisuals();
  return _hasConfiguredModel;
}

async function refreshModelConfigSnapshot() {
  try {
    const res = await window.orkas.invoke('auth.listEntries');
    if (res && res.ok && Array.isArray(res.entries)) {
      window.dispatchEvent(new CustomEvent('orkas:model-entries-changed', {
        detail: { entries: res.entries },
      }));
      trackModelConfigSnapshot(res.entries);
    }
  } catch (err) {
    _guardLog.warn('model config snapshot refresh failed', { error: (err && err.message) || String(err) });
  }
}

function _modelConfigTelemetryEntry(entry, entryRank) {
  const rawProvider = String((entry && entry.provider) || '').trim();
  const rawModel = String((entry && entry.model) || '').trim();
  if (!rawProvider || !rawModel) return null;
  const legacyDynamicProvider = /^cp:/i.test(rawProvider) || rawProvider === 'custom-openai';
  const userEnteredModel = legacyDynamicProvider
    || rawProvider === 'custom'
    || rawProvider === 'openrouter';
  const normalizedProvider = legacyDynamicProvider ? 'custom' : rawProvider;
  return {
    provider: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(normalizedProvider)
      ? normalizedProvider
      : 'unknown',
    model: userEnteredModel
      ? 'custom'
      : (/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,119}$/.test(rawModel) ? rawModel : 'unknown'),
    entry_rank: entryRank,
  };
}

function trackModelConfigSnapshot(entries) {
  try {
    if (!window.Monitor || typeof Monitor.event !== 'function') return;
    const safeEntries = (Array.isArray(entries) ? entries : [])
      .map((entry, idx) => _modelConfigTelemetryEntry(entry, idx + 1))
      .filter(Boolean);
    const uid = (typeof globalThis.currentUserId === 'string') ? globalThis.currentUserId : '';
    const signature = uid + '|' + safeEntries
      .map((entry) => entry.provider + '/' + entry.model + '#' + entry.entry_rank)
      .join('|');
    if (signature === _modelConfigSnapshotSignature) return;
    _modelConfigSnapshotSignature = signature;

    const snapshotId = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
    Monitor.event('model_config_snapshot', {
      snapshot_id: snapshotId,
      entry_count: safeEntries.length,
    });
    safeEntries.forEach((entry) => {
      Monitor.event('model_config_entry', {
        snapshot_id: snapshotId,
        provider: entry.provider,
        model: entry.model,
        entry_rank: entry.entry_rank,
      });
    });
  } catch (err) {
    _guardLog.warn('model config snapshot telemetry failed', { error: (err && err.message) || String(err) });
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
