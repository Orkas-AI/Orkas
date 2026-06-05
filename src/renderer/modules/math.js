// ─── MathJax bridge ───
//
// Exposes a single helper `typesetMath(rootEl)` that retypes any LaTeX inside
// rootEl using MathJax v3 (configured in index.html before the script loads).
//
// Behaviour:
//   • MathJax loads async via `<script defer>`. Before its startup promise
//     resolves, calls are queued and flushed when it is ready.
//   • Input sanity — our hand-rolled markdown renderer already protects
//     math blocks (via utils.js::renderMarkdownFull phase 1) so delimiters
//     survive markdown mangling; MathJax sees the original `$...$` etc.
//   • On malformed LaTeX MathJax 3 + the `noerrors` package renders the
//     raw TeX inline in red instead of throwing — so one broken formula
//     never blows up the whole bubble.
//   • Re-typesetting an element that already contains typeset math is safe:
//     MathJax `clear`s its prior output via `typesetClear` first.

const _mathLog = (typeof createLogger === 'function') ? createLogger('math') : console;

async function _mjReady() {
  // Before tex-chtml.js runs, `window.MathJax` is our config object (which
  // intentionally has `startup: { typeset: false }` — so checking for
  // `window.MathJax.startup` is NOT a reliable "is loaded" signal). The real
  // signal is `window.MathJax.typesetPromise` becoming a function, which
  // only happens after the runtime bundle replaces the config object with
  // the full MathJax object. Poll for that, then await `startup.promise`.
  if (typeof window.MathJax === 'undefined' || typeof window.MathJax.typesetPromise !== 'function') {
    await new Promise((resolve) => {
      const tick = () => {
        if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') return resolve();
        setTimeout(tick, 20);
      };
      tick();
    });
  }
  if (window.MathJax.startup && window.MathJax.startup.promise) {
    await window.MathJax.startup.promise;
  }
}

async function typesetMath(rootEl) {
  if (!rootEl) return;
  try {
    await _mjReady();
    // Clear any prior typeset output inside rootEl, then retypset. Without
    // typesetClear, re-rendering the same bubble leaves stale mjx-containers.
    if (window.MathJax.typesetClear) window.MathJax.typesetClear([rootEl]);
    await window.MathJax.typesetPromise([rootEl]);
    // Noise level: debug. Drop to trace / delete once stable.
    const hits = rootEl.querySelectorAll('mjx-container').length;
    if (hits) (_mathLog.info || console.info).call(_mathLog, `typeset ${hits} formula(s)`);
  } catch (err) {
    (_mathLog.warn || console.warn).call(_mathLog, 'typeset failed:', (err && err.message) || err);
  }
}

const _mathHtmlCache = new Map();
const MATH_HTML_CACHE_LIMIT = 160;

function _rememberMathHtml(key, value) {
  if (!key) return;
  if (_mathHtmlCache.has(key)) _mathHtmlCache.delete(key);
  _mathHtmlCache.set(key, value);
  while (_mathHtmlCache.size > MATH_HTML_CACHE_LIMIT) {
    const oldest = _mathHtmlCache.keys().next().value;
    if (oldest == null) break;
    _mathHtmlCache.delete(oldest);
  }
}

async function typesetMathHtml(html) {
  const key = String(html || '');
  if (!key) return '';
  const cached = _mathHtmlCache.get(key);
  if (cached) return cached;
  if (typeof document === 'undefined' || !document.createElement) return key;
  const host = document.createElement('div');
  host.className = 'math-typeset-buffer';
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.width = '720px';
  host.style.visibility = 'hidden';
  host.style.pointerEvents = 'none';
  host.style.contain = 'layout style paint';
  host.innerHTML = key;
  try {
    document.body?.appendChild(host);
    await _mjReady();
    if (window.MathJax.typesetClear) window.MathJax.typesetClear([host]);
    await window.MathJax.typesetPromise([host]);
    const out = host.innerHTML;
    _rememberMathHtml(key, out);
    return out;
  } catch (err) {
    (_mathLog.warn || console.warn).call(_mathLog, 'typeset html failed:', (err && err.message) || err);
    return key;
  } finally {
    if (host.parentElement) host.parentElement.removeChild(host);
  }
}

function prewarmMathJax(retries = 240) {
  if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
    _mjReady().catch((err) => {
      (_mathLog.warn || console.warn).call(_mathLog, 'prewarm failed:', (err && err.message) || err);
    });
    return;
  }
  if (retries <= 0) return;
  setTimeout(() => prewarmMathJax(retries - 1), 25);
}

window.typesetMath = typesetMath;
window.typesetMathHtml = typesetMathHtml;
setTimeout(() => prewarmMathJax(), 0);
