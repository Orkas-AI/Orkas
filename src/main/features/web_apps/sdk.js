/* Web App SDK v1. No privileged handles or credentials enter this context. */
(function () {
  'use strict';
  const pending = new Map();
  /* PREVIEW_PENDING */
  let hostConnected = false;
  let hostDiscovery = null;
  const documentId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  let nextId = 0;
  function fail(code, message) { return Object.assign(new Error(message || code), { code }); }
  function call(method, args, options) {
    const opts = options || {};
    if (window.parent === window) return Promise.reject(fail('E_HOST_UNAVAILABLE'));
    if (opts.signal && opts.signal.aborted) return Promise.reject(fail('E_CANCELLED'));
    const discoverBeforeInference = method === 'ai.generate' && !hostConnected;
    let wireArgs = args === undefined ? {} : args;
    if (discoverBeforeInference) {
      // Preserve postMessage's call-time input snapshot while discovery waits.
      try { wireArgs = structuredClone(wireArgs); }
      catch (_) { return Promise.reject(fail(opts.signal && opts.signal.aborted ? 'E_CANCELLED' : 'E_INPUT')); }
      if (opts.signal && opts.signal.aborted) return Promise.reject(fail('E_CANCELLED'));
    }
    const id = 'd' + documentId + 'q' + (++nextId);
    return new Promise((resolve, reject) => {
      const cancel = () => {
        parent.postMessage({ __orkasApp: 1, type: 'cancel', id }, '*');
        finish(false, { code: 'E_CANCELLED' });
      };
      const finish = (ok, value) => {
        const p = pending.get(id); if (!p) return;
        pending.delete(id); clearTimeout(p.timer);
        wireArgs = undefined;
        if (opts.signal) opts.signal.removeEventListener('abort', cancel);
        if (ok) resolve(value); else reject(fail(value.code || 'E_FAILED', value.message));
      };
      const timer = hostConnected || discoverBeforeInference ? undefined : setTimeout(() => {
        parent.postMessage({ __orkasApp: 1, type: 'cancel', id }, '*');
        finish(false, { code: 'E_HOST_UNAVAILABLE' });
      }, 10000);
      pending.set(id, { finish, timer, progress: opts.onProgress });
      if (opts.signal) opts.signal.addEventListener('abort', cancel, { once: true });
      const send = () => {
        if (!pending.has(id)) return; // Cancelled/departed while discovering.
        try {
          parent.postMessage({ __orkasApp: 1, type: 'call', id, method, args: wireArgs }, '*');
          wireArgs = undefined;
        }
        catch (_) { finish(false, { code: 'E_INPUT' }); }
      };
      if (discoverBeforeInference) {
        // A cold inference import can block the host's browser message routing.
        // Establish the existing read-only connection before starting that work;
        // the inference itself remains one request with no automatic replay.
        if (!hostDiscovery) hostDiscovery = call('host.getContext').finally(() => { hostDiscovery = null; });
        hostDiscovery.then(send, error => finish(false, { code: error.code || 'E_FAILED', message: error.message }));
      } else send();
    });
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || !event.data || event.data.__orkasApp !== 1) return;
    const d = event.data; const p = pending.get(d.id); if (!p) return;
    if (!hostConnected && ['ack', 'progress', 'result'].includes(d.type)) {
      hostConnected = true;
      for (const request of pending.values()) clearTimeout(request.timer);
    }
    if (d.type === 'ack') {
      clearTimeout(p.timer);
    } else if (d.type === 'progress') {
      if (typeof p.progress === 'function') { try { p.progress(d.value); } catch (_) {} }
    } else if (d.type === 'result') p.finish(d.ok, d.value);
  });
  window.addEventListener('pagehide', () => {
    for (const [id, p] of pending) {
      parent.postMessage({ __orkasApp: 1, type: 'cancel', id }, '*');
      p.finish(false, { code: 'E_CLOSED' });
    }
  });
  const api = { version: 1, call };
  for (const name of /* HOST_METHOD_NAMES */ []) {
    const [group, method] = name.split('.');
    if (!api[group]) api[group] = {};
    api[group][method] = (args, options) => call(name, args, options);
  }
  for (const value of Object.values(api)) if (value && typeof value === 'object') Object.freeze(value);
  (/** @type {any} */ (window)).orkasApp = Object.freeze(api);
})();
