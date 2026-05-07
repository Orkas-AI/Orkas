// 中文 → 拼音首字母 工具 (sort key only)。
//
// Why: Electron 自带的是 small ICU,Intl.Collator 不带 zh pinyin tailoring,
// 所有 -u-co-pinyin / 'zh-Hans-CN' 的形式都会静默回落到笔画/编码序,导致
// 中英文混排排序时所有汉字堆一起、英文堆一起,用户感知就是"乱"。
// 这里加载 vendor/pinyin-firstletter/data.js 提供的 Unicode → 首字母 表
// (拼音首字母数据来自 pinyinjs / 小茗同学,MIT),把字符串展平成"按首
// 字母拼起来"的 sort key,然后用普通字符串比较即可。
//
// 数据范围:CJK Unified Ideographs U+4E00..U+9FA5(覆盖 6763 一级 + 大多
// 二级汉字),范围外的字符按原样保留(让标点/Latin/数字按 ASCII 序参与比较)。
// 不读 polyphone 多音字表 —— 实测主表 dict.all 已经是"日常高频读音"
// (乐→L 乐观、行→H 银行、长→Z 长大),polyphone 反而把次要读音排在
// 第一位(乐 polyphone='YL',首读 yuè),覆盖会让"乐观大胆派"被排到 y 段
// 而不是 l 段。排序场景不需要多音区分,直接用主表的高频读音最准。
const _BASE = 0x4E00;

function pinyinFirstLetter(ch) {
  if (!ch) return '';
  // 走得到 vendor 数据则用,加载失败时退回原字符(让 sort 至少不崩)
  const dict = (typeof pinyin_dict_firstletter !== 'undefined') ? pinyin_dict_firstletter : null;
  if (!dict || !dict.all) return ch;
  const idx = ch.charCodeAt(0) - _BASE;
  if (idx < 0 || idx >= dict.all.length) return ch;
  const letter = dict.all.charAt(idx);
  return letter ? letter.toLowerCase() : ch;
}

// 把整串展开成"按首字母拼起来"的 sort key。
// 例:'悲观谨慎派' → 'bgjsp';'Agent Skill 评估官' → 'agent skill psg';
// 'Claude Code' → 'claude code'。然后两个 key 用 < 直接比就是用户预期的字典序。
function pinyinSortKey(str) {
  if (!str) return '';
  let out = '';
  for (const ch of String(str)) {
    out += pinyinFirstLetter(ch);
  }
  return out.toLowerCase();
}
