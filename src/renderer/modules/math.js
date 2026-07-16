// ─── MathJax bridge ───
//
// Exposes a single helper `typesetMath(rootEl)` that retypes any LaTeX inside
// rootEl using MathJax v3 (configured in index.html before the script loads).
//
// Behaviour:
//   • The 1.16 MB runtime is injected only after content containing TeX is
//     actually rendered. Plain chat sessions never fetch/parse MathJax.
//   • Concurrent first-formula calls share one load promise.
//   • Input sanity — our hand-rolled markdown renderer already protects
//     math blocks (via utils.js::renderMarkdownFull phase 1) so delimiters
//     survive markdown mangling; MathJax sees the original `$...$` etc.
//   • On malformed LaTeX MathJax 3 + the `noerrors` package renders the
//     raw TeX inline in red instead of throwing — so one broken formula
//     never blows up the whole bubble.
//   • Re-typesetting an element that already contains typeset math is safe:
//     MathJax `clear`s its prior output via `typesetClear` first.

const _mathLog = (typeof createLogger === 'function') ? createLogger('math') : console;
let _mathJaxLoadPromise = null;

function _containsMath(value) {
  const text = String(value || '');
  if (!text) return false;
  return /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(^|[^\\$])\$(?!\s|\d)[^$\n]+?\$(?!\d)/m.test(text);
}

function _rootContainsMath(rootEl) {
  if (!rootEl) return false;
  return _containsMath(rootEl.textContent || rootEl.innerHTML || '');
}

function _loadMathJaxRuntime() {
  if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') return Promise.resolve();
  if (_mathJaxLoadPromise) return _mathJaxLoadPromise;
  _mathJaxLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = './vendor/mathjax/tex-chtml.js';
    script.async = true;
    script.dataset.orkasMathjax = '1';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('failed to load MathJax runtime'));
    (document.head || document.documentElement).appendChild(script);
  });
  return _mathJaxLoadPromise;
}

async function _mjReady() {
  await _loadMathJaxRuntime();
  if (window.MathJax.startup && window.MathJax.startup.promise) {
    await window.MathJax.startup.promise;
  }
  if (typeof window.MathJax.typesetPromise !== 'function') {
    throw new Error('MathJax runtime did not initialize');
  }
}

async function typesetMath(rootEl) {
  if (!rootEl || !_rootContainsMath(rootEl)) return;
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
  if (!_containsMath(key)) return key;
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

window.typesetMath = typesetMath;
window.typesetMathHtml = typesetMathHtml;
