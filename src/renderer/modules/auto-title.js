// Heuristic conversation auto-title — mirror of `src/main/util/auto-title.ts`.
//
// Defined as a top-level renderer module so `_autoTitle` is a global available
// to consumers in `agents.js` / `conversation.js` / `project-detail.js` once
// `<script src="./modules/auto-title.js">` runs. Renderer rules (PC/CLAUDE.md
// §8) forbid `import`/`export` in renderer files; the regex/constant pair
// stays duplicated on this side by design.
//
// Drift between this file and `src/main/util/auto-title.ts` is caught by
// `test/renderer/auto-title-parity.test.ts` (asserts regex.source/flags +
// the width budget, and compares output on script-mix fixtures). The width
// table below mirrors `src/main/util/name-limit.ts`, which main reuses.
// Change a regex, the budget, or the width table? Update BOTH sides + the
// parity fixtures.
//
// CJS bridge at the bottom: §9 escape so the parity test can `require()` the
// constants directly. No-op in the browser (`module` is undefined).

const _AUTO_TITLE_ZH_FILLER = /^(帮我看一下|可不可以|帮我看下|帮我看看|麻烦你|帮我看|我想要|想问问|能不能|可以不|可以吗|请帮我|看一下|麻烦|帮我|我想|想问|请问|看下|看看)\s*/;
const _AUTO_TITLE_EN_FILLER = /^(could you|would you|can you|help me|i'?d like to|i want to|please)\s+/i;
// Half-width display units, not characters: counting characters cut a CJK
// title at twice the rendered width of a Latin one. Mirrors TITLE_MAX_UNITS.
const _AUTO_TITLE_MAX_UNITS = 50;

function _autoTitleGraphemes(text) {
  try {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(seg.segment(text), function (part) { return part.segment; });
    }
  } catch (err) { /* fall through to code points */ }
  return Array.from(text);
}

function _autoTitleCodePointWidth(cp) {
  if (!Number.isFinite(cp)) return 1;
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x11ff)
    || (cp >= 0x2e80 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7af)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe10 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xffef)
    || (cp >= 0x1f300 && cp <= 0x1faff)
  ) return 2;
  return 1;
}

/** Mirror of `auto-title.ts::truncateTitleToWidth`. Whole grapheme clusters
 *  only, so an emoji is never halved. */
function _truncateTitleToWidth(text) {
  const clusters = _autoTitleGraphemes(String(text == null ? '' : text));
  let total = 0;
  let kept = '';
  for (let i = 0; i < clusters.length; i++) {
    let w = 0;
    const chars = Array.from(clusters[i]);
    for (let j = 0; j < chars.length; j++) {
      w = Math.max(w, _autoTitleCodePointWidth(chars[j].codePointAt(0)));
    }
    w = w || 1;
    if (total + w > _AUTO_TITLE_MAX_UNITS) return kept + '…';
    kept += clusters[i];
    total += w;
  }
  return kept;
}

/** Returns the auto-derived sidebar title for `text`. Empty input → ''
 *  (caller is expected to fall back to its own placeholder, typically
 *  `t('chat.default_title')`). Backend equivalent: `chats.ts::autoTitle`. */
function _autoTitle(text) {
  const raw = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
  if (!raw) return '';
  let s = raw;
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s.replace(_AUTO_TITLE_ZH_FILLER, '').replace(_AUTO_TITLE_EN_FILLER, '');
    if (s === before) break;
  }
  s = s.trim();
  if (!s) s = raw;
  s = _truncateTitleToWidth(s);
  return s;
}

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = {
    _autoTitle,
    _AUTO_TITLE_ZH_FILLER,
    _AUTO_TITLE_EN_FILLER,
    _AUTO_TITLE_MAX_UNITS,
    _truncateTitleToWidth,
  };
}
