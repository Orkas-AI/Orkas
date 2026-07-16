// Shared security boundary for generated-artifact iframes.
//
// This file is intentionally a classic script: chat-artifact.js is eager and
// saved-apps.js is lazy-loaded, so both consume the same small global API.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OrkasArtifactSecurity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Generated apps may run code, submit forms, and use same-origin storage.
  // They may not create popups or navigate the top-level renderer.
  const SANDBOX = 'allow-scripts allow-same-origin allow-forms';

  function safeExternalHttpUrl(raw) {
    const value = String(raw == null ? '' : raw).trim();
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      if (!parsed.hostname || parsed.username || parsed.password) return null;
      return parsed.href;
    } catch (_) {
      return null;
    }
  }

  function trustedArtifactMessage(event, frame) {
    if (!event || !frame) return false;
    let source;
    try { source = frame.contentWindow; } catch (_) { return false; }
    if (!source || event.source !== source) return false;
    const data = event.data;
    return !!data && typeof data === 'object' && data.__orkasArtifact === true;
  }

  return Object.freeze({ SANDBOX, safeExternalHttpUrl, trustedArtifactMessage });
});
