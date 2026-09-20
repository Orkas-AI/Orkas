/* Web App SDK v1. No privileged handles or credentials enter this context. */
(function () {
  'use strict';
  const pending = new Map();
  let nextId = 0;
  function fail(code, message) { return Object.assign(new Error(message || code), { code }); }
  function call(method, args, options) {
    const opts = options || {};
    if (window.parent === window) return Promise.reject(fail('E_HOST_UNAVAILABLE'));
    if (opts.signal && opts.signal.aborted) return Promise.reject(fail('E_CANCELLED'));
    if (pending.size >= 4) return Promise.reject(fail('E_LIMIT'));
    const id = 'q' + (++nextId);
    return new Promise((resolve, reject) => {
      const cancel = () => {
        parent.postMessage({ __orkasApp: 1, type: 'cancel', id }, '*');
        finish(false, { code: 'E_CANCELLED' });
      };
      const finish = (ok, value) => {
        const p = pending.get(id); if (!p) return;
        pending.delete(id); clearTimeout(p.timer);
        if (opts.signal) opts.signal.removeEventListener('abort', cancel);
        if (ok) resolve(value); else reject(fail(value.code || 'E_FAILED', value.message));
      };
      const timer = setTimeout(() => {
        parent.postMessage({ __orkasApp: 1, type: 'cancel', id }, '*');
        finish(false, { code: 'E_HOST_UNAVAILABLE' });
      }, 10000);
      pending.set(id, { finish, timer, progress: opts.onProgress });
      if (opts.signal) opts.signal.addEventListener('abort', cancel, { once: true });
      try { parent.postMessage({ __orkasApp: 1, type: 'call', id, method, args: args === undefined ? {} : args }, '*'); }
      catch (_) { finish(false, { code: 'E_INPUT' }); }
    });
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || !event.data || event.data.__orkasApp !== 1) return;
    const d = event.data; const p = pending.get(d.id); if (!p) return;
    if (d.type === 'ack') {
      clearTimeout(p.timer);
      p.timer = setTimeout(() => {
        parent.postMessage({ __orkasApp: 1, type: 'cancel', id: d.id }, '*');
        p.finish(false, { code: 'E_CANCELLED' });
      }, 310000);
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
