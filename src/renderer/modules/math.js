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

window.typesetMath = typesetMath;
