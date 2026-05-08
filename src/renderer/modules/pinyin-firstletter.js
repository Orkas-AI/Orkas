// Chinese → pinyin first-letter utility (sort key only).
//
// Why: Electron ships small ICU, and Intl.Collator does not include
// zh pinyin tailoring, so all `-u-co-pinyin` / `'zh-Hans-CN'` forms
// silently fall back to stroke / code-point order. The result is that
// when CJK and ASCII names are mixed, every Chinese character clumps
// together and every Latin name clumps together — users perceive this
// as "random ordering".
// We load the Unicode → first-letter table provided by
// vendor/pinyin-firstletter/data.js (data sourced from pinyinjs by
// Xiaoming, MIT) and flatten each string into a "concatenated
// first-letters" sort key, then compare those keys with plain string
// comparison.
//
// Coverage: CJK Unified Ideographs U+4E00..U+9FA5 (6763 commonly-used
// + most extended-use chars). Characters outside that range pass
// through unchanged (so punctuation / Latin / digits participate via
// ASCII order).
// We deliberately do NOT load the polyphone table — empirically the
// main table dict.all already encodes "the most common everyday
// reading" (e.g. 乐→L for "乐观", 行→H for "银行", 长→Z for "长大"),
// while polyphone tends to put a secondary reading first
// (乐.polyphone='YL', primary yuè), so overriding would push entries
// like "乐观大胆派" into the `y` bucket instead of `l`. For sorting
// purposes the high-frequency main reading is what users expect.
const _BASE = 0x4E00;

function pinyinFirstLetter(ch) {
  if (!ch) return '';
  // Use the vendor table when available; if loading failed, return the
  // original character (so sort at least does not crash).
  const dict = (typeof pinyin_dict_firstletter !== 'undefined') ? pinyin_dict_firstletter : null;
  if (!dict || !dict.all) return ch;
  const idx = ch.charCodeAt(0) - _BASE;
  if (idx < 0 || idx >= dict.all.length) return ch;
  const letter = dict.all.charAt(idx);
  return letter ? letter.toLowerCase() : ch;
}

// Flatten the whole string into a "concatenated first-letters" sort
// key. Examples:
//   '悲观谨慎派' → 'bgjsp'
//   'Agent Skill 评估官' → 'agent skill psg'
//   'Claude Code' → 'claude code'
// Comparing two keys with `<` then yields the dictionary order users
// expect.
function pinyinSortKey(str) {
  if (!str) return '';
  let out = '';
  for (const ch of String(str)) {
    out += pinyinFirstLetter(ch);
  }
  return out.toLowerCase();
}
