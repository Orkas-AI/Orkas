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
// TITLE_MAX). Add a new filler? Update BOTH sides + the parity fixture set.
//
// CJS bridge at the bottom: §9 escape so the parity test can `require()` the
// constants directly. No-op in the browser (`module` is undefined).

const _AUTO_TITLE_ZH_FILLER = /^(帮我看一下|可不可以|帮我看下|帮我看看|麻烦你|帮我看|我想要|想问问|能不能|可以不|可以吗|请帮我|看一下|麻烦|帮我|我想|想问|请问|看下|看看)\s*/;
const _AUTO_TITLE_EN_FILLER = /^(could you|would you|can you|help me|i'?d like to|i want to|please)\s+/i;
const _AUTO_TITLE_CLAUSE = /[，。？！；;,.?!]/;
const _AUTO_TITLE_MAX = 30;

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
  const clauseIdx = s.search(_AUTO_TITLE_CLAUSE);
  if (clauseIdx >= 4) s = s.slice(0, clauseIdx);
  s = s.trim();
  if (!s) s = raw;
  if (s.length > _AUTO_TITLE_MAX) s = s.slice(0, _AUTO_TITLE_MAX) + '…';
  return s;
}

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = {
    _autoTitle,
    _AUTO_TITLE_ZH_FILLER,
    _AUTO_TITLE_EN_FILLER,
    _AUTO_TITLE_CLAUSE,
    _AUTO_TITLE_MAX,
  };
}
