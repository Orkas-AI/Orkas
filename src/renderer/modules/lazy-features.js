// ─── On-demand renderer feature bundles ───────────────────────────────────
//
// The chat-first shell uses classic scripts, so every eagerly listed script is
// parsed and evaluated before the user can see the last conversation. Keep
// tab-only bundles out of that path and preserve their required classic-script
// order when a user actually enters the corresponding surface.

const _rendererFeatureManifest = Object.freeze({
  settings: [
    { src: './modules/settings.js' },
    { src: './modules/memory.js' },
  ],
  marketplace: [
    { src: './modules/semver.js' },
    { src: './modules/marketplace.js' },
  ],
  agents: [
    // Direct-entry Agent views use the shared marketplace category registry.
    { src: './modules/semver.js' },
    { src: './modules/marketplace.js' },
  ],
  project: [
    { src: './modules/library-transfer.js' },
    { src: './modules/project-detail.js' },
  ],
  auto: [
    { src: './modules/auto.js' },
  ],
  contexts: [
    { src: './modules/library-transfer.js' },
    { src: './modules/contexts.js' },
    { src: './modules/kb-picker.js' },
  ],
  'kb-picker': [
    { src: './modules/kb-picker.js' },
  ],
  apps: [
    { src: './modules/saved-apps.js' },
  ],
  skills: [
    { src: './modules/semver.js' },
    { src: './modules/marketplace.js' },
    { src: './modules/skills.js' },
    { src: './modules/skills-bindings.js' },
  ],
});

const _rendererFeatureLoads = new Map();
const _rendererScriptLoads = new Map();
const _rendererFeatureAttempts = new Map();

function _rendererFeatureNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function _rendererFeatureTelemetryName(feature) {
  return Object.prototype.hasOwnProperty.call(_rendererFeatureManifest, feature)
    ? feature
    : 'unknown';
}

function _trackRendererFeatureLoad(result, feature, startedAt, retryCount, errorCode = '') {
  const normalizedResult = result === 'success' ? 'success' : 'failure';
  const normalizedFeature = _rendererFeatureTelemetryName(feature);
  const normalizedCode = errorCode === 'unknown_feature'
    ? 'unknown_feature'
    : 'script_load_failed';
  const payload = {
    result: normalizedResult,
    feature: normalizedFeature,
    duration_ms: Math.max(0, Math.round(_rendererFeatureNow() - startedAt)),
    retry_count: Math.max(0, Number(retryCount) || 0),
  };
  if (normalizedResult === 'failure') payload.error_code = normalizedCode;
  if (normalizedResult === 'failure') {
    try { console.warn('[renderer-feature]', payload); } catch (_) {}
  }
}

function _appendRendererFeatureScript(entry) {
  const existing = _rendererScriptLoads.get(entry.src);
  if (existing) return existing;
  const run = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = entry.src;
    script.async = false;
    script.dataset.rendererFeature = entry.src;
    script.onload = () => resolve();
    script.onerror = () => {
      if (entry.optional) {
        resolve();
        return;
      }
      reject(new Error(`renderer feature script failed: ${entry.src}`));
    };
    (document.head || document.documentElement).appendChild(script);
  });
  _rendererScriptLoads.set(entry.src, run);
  run.catch(() => {
    if (_rendererScriptLoads.get(entry.src) === run) _rendererScriptLoads.delete(entry.src);
  });
  return run;
}

/** Load a tab-only feature exactly once. Concurrent callers share the same
 *  promise, and manifest order is retained for classic-script lexical refs. */
function loadRendererFeature(name) {
  const feature = String(name || '');
  const entries = _rendererFeatureManifest[feature];
  if (!entries) {
    const startedAt = _rendererFeatureNow();
    _trackRendererFeatureLoad('failure', feature, startedAt, 0, 'unknown_feature');
    return Promise.reject(new Error(`unknown renderer feature: ${feature}`));
  }
  const existing = _rendererFeatureLoads.get(feature);
  if (existing) return existing;
  const attempt = (_rendererFeatureAttempts.get(feature) || 0) + 1;
  _rendererFeatureAttempts.set(feature, attempt);
  const startedAt = _rendererFeatureNow();
  const run = (async () => {
    for (const entry of entries) await _appendRendererFeatureScript(entry);
  })();
  _rendererFeatureLoads.set(feature, run);
  run.then(
    () => _trackRendererFeatureLoad('success', feature, startedAt, attempt - 1),
    () => _trackRendererFeatureLoad('failure', feature, startedAt, attempt - 1, 'script_load_failed'),
  );
  run.catch(() => {
    if (_rendererFeatureLoads.get(feature) === run) _rendererFeatureLoads.delete(feature);
  });
  return run;
}

window.loadRendererFeature = loadRendererFeature;
