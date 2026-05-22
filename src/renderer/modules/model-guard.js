// ─── Model config guard ──────────────────────────────────────────────────
// Central gate that keeps LLM-dependent features disabled until the user
// has at least one (provider, model, credential) entry. Two surfaces:
//   1) a persistent banner pinned above the main content area that links
//      to the settings page (hidden on settings itself);
//   2) `ensureModelConfigured()`, a synchronous check that action handlers
//      call before firing an LLM-backed request — it short-circuits with
//      an alert + settings redirect when the user hasn't configured a
//      model yet, so every action path fails the same way.
// Refreshed at boot and after each successful `auth.addEntry` in the
// settings page.

const _guardLog = createLogger('model-guard');

let _hasConfiguredModel = true;   // optimistic — flipped to false after refresh if empty
let _guardBannerEl = null;
let _guardChecked = false;

function _ensureGuardBanner() {
  if (_guardBannerEl) return _guardBannerEl;
  const main = document.querySelector('.main-content');
  if (!main) return null;
  const el = document.createElement('div');
  el.className = 'model-guard-banner';
  el.id = 'model-guard-banner';
  el.style.display = 'none';
  el.innerHTML = `
    <span class="model-guard-icon" aria-hidden="true">●</span>
    <span class="model-guard-text">${escapeHtml(t('model_guard.banner'))}</span>
    <button type="button" class="btn btn-sm btn-primary model-guard-cta">${escapeHtml(t('model_guard.cta'))}</button>
  `;
  el.querySelector('.model-guard-cta').addEventListener('click', () => {
    if (typeof setView === 'function') setView('settings');
    // Drop the user straight on the 配置 (Credentials) tab — that's where
    // the model-auth UI lives now (Phase 4 4-tab restructure).
    if (typeof window.activateSettingsTab === 'function') window.activateSettingsTab('credentials');
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
}

async function refreshModelGuard() {
  try {
    const res = await window.orkas.invoke('auth.hasConfiguredModel');
    // Only flip the flag when the IPC returned a definitive answer. A
    // failed call (unknown channel on an old main process, transient
    // error) should leave the UI optimistic rather than lock the user
    // out of every feature. The backend runner still fails loudly on
    // actual sends if no entry exists, so we don't lose correctness.
    if (res && res.ok) {
      _hasConfiguredModel = !!res.configured;
      _guardChecked = true;
    } else {
      _guardLog.warn('refresh ipc not-ok', { error: res && res.error });
    }
  } catch (e) {
    _guardLog.warn('refresh failed', { error: (e && e.message) || String(e) });
  }
  _applyGuardVisuals();
  return _hasConfiguredModel;
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
    if (typeof setView === 'function') setView('settings');
    if (typeof window.activateSettingsTab === 'function') window.activateSettingsTab('credentials');
  }
  return false;
}
