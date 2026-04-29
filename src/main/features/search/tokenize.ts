/**
 * Text → tokens for the local inverted index.
 *
 * Strategy:
 *   - lowercase
 *   - CJK chars → unigram + 2-gram with the next CJK char
 *   - ASCII runs of [a-z0-9_] → emitted as a single word (length ≥ 2)
 *   - everything else (punctuation, whitespace) → splitter
 */

const CJK_RE = /[\u3400-\u9fff\uac00-\ud7af\u3040-\u309f\u30a0-\u30ff]/;
const ASCII_WORD_RE = /[a-z0-9_]/;

export function isCJK(ch: string): boolean { return CJK_RE.test(ch); }

// Stop tokens — skipped during indexing and querying so ultra-common words
// don't dominate the postings and inflate scores for noise docs. CJK is
// written per-char; English is whole words.
export const STOP_TOKENS: ReadonlySet<string> = new Set([
  // zh common
  '的', '是', '了', '在', '我', '你', '他', '她', '它',
  '这', '那', '有', '和', '与', '或', '也', '就',
  '都', '还', '要', '会', '说', '去', '来', '到',
  '一', '二', '三', '个', '们', '吗', '啊', '吧',
  '呢', '呀', '哦', '嗯', '啦', '呐', '哈', '哼',
  '不', '没', '很', '但', '如', '果', '所', '以',
  '被', '把', '让', '给', '向', '从', '对', '为',
  // en common
  'the', 'be', 'to', 'of', 'and', 'a', 'in', 'that',
  'have', 'it', 'for', 'not', 'on', 'with', 'he', 'as',
  'you', 'do', 'at', 'this', 'but', 'his', 'by', 'from',
  'they', 'we', 'say', 'her', 'she', 'or', 'an',
  'will', 'my', 'one', 'all', 'would', 'there', 'their', 'what',
  'so', 'up', 'out', 'if', 'about', 'who', 'get', 'which',
  'go', 'me', 'is', 'are', 'was', 'were', 'been', 'being',
]);

export function tokenize(text: unknown): string[] {
  const out: string[] = [];
  if (!text || typeof text !== 'string') return out;
  const s = text.toLowerCase();
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (isCJK(ch)) {
      if (!STOP_TOKENS.has(ch)) out.push(ch);
      const next = s[i + 1];
      // Only build the 2-gram if neither char is a stop; a stop char as part
      // of a phrase still pollutes the index with low-signal posting rows.
      if (next && isCJK(next) && !STOP_TOKENS.has(ch) && !STOP_TOKENS.has(next)) {
        out.push(ch + next);
      }
      i++;
    } else if (ASCII_WORD_RE.test(ch)) {
      let j = i;
      while (j < s.length && ASCII_WORD_RE.test(s[j])) j++;
      const word = s.slice(i, j);
      if (word.length >= 2 && !STOP_TOKENS.has(word)) out.push(word);
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

export function termFrequencies(text: unknown): Record<string, number> {
  const tf: Record<string, number> = Object.create(null);
  for (const t of tokenize(text)) tf[t] = (tf[t] || 0) + 1;
  return tf;
}
