export const LIBRARY_CONTENT_MIN_SCORE = 0.45;
export const LIBRARY_CONTENT_STRONG_SCORE = 0.65;
const LIBRARY_CONTENT_SCORE_BASE = 20;
const LIBRARY_CONTENT_SCORE_RANGE = 20;

export function isRelevantLibraryContentScore(score: unknown): boolean {
  const parsed = Number(score);
  return Number.isFinite(parsed) && parsed >= LIBRARY_CONTENT_MIN_SCORE;
}

const LATIN_STOP_WORDS = new Set([
  'and', 'are', 'but', 'for', 'from', 'how', 'into', 'not', 'the', 'this',
  'what', 'when', 'where', 'which', 'who', 'with',
]);

function lexicalAnchors(query: string): string[] {
  const anchors: string[] = [];
  const parts = query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  for (const part of parts) {
    if (/[\u3040-\u30ff\u3400-\u9fff]/u.test(part)) {
      const width = part.length >= 4 ? 4 : 2;
      if (part.length < width) continue;
      for (let index = 0; index <= part.length - width; index += 1) {
        anchors.push(part.slice(index, index + width));
      }
      continue;
    }
    if (part.length >= 3 && !LATIN_STOP_WORDS.has(part)) anchors.push(part);
  }
  return [...new Set(anchors)];
}

export function hasLibraryContentLexicalAnchor(
  query: string,
  values: ReadonlyArray<unknown>,
): boolean {
  const anchors = lexicalAnchors(String(query || ''));
  if (!anchors.length) return false;
  const haystack = values.map((value) => String(value || '')).join('\n').toLocaleLowerCase();
  const matched = anchors.filter((anchor) => haystack.includes(anchor));
  if (anchors.length === 1 && matched.length === 1) return true;
  if (matched.some((anchor) => (
    anchor.length >= 8 || /[\u3040-\u30ff\u3400-\u9fff]/u.test(anchor)
  ))) return true;
  return new Set(matched).size >= 2;
}

export function isRelevantLibraryContentHit(
  query: string,
  hit: {
    score: unknown;
    path?: unknown;
    title?: unknown;
    content?: unknown;
  },
): boolean {
  const score = Number(hit.score);
  if (!isRelevantLibraryContentScore(score)) return false;
  if (score >= LIBRARY_CONTENT_STRONG_SCORE) return true;
  return hasLibraryContentLexicalAnchor(
    query,
    [hit.path, hit.title, hit.content],
  );
}

export function libraryContentDisplayScore(score: unknown): number {
  const bounded = Math.max(0, Math.min(1, Number(score) || 0));
  return LIBRARY_CONTENT_SCORE_BASE + bounded * LIBRARY_CONTENT_SCORE_RANGE;
}
