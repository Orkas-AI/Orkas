import type { MemorySearchResult } from "./types.js";

/**
 * Simple BM25-inspired keyword scoring for full-text search.
 */
export function bm25Score(
  query: string,
  document: string,
  opts?: { k1?: number; b?: number; avgDocLen?: number },
): number {
  const k1 = opts?.k1 ?? 1.5;
  const b = opts?.b ?? 0.75;
  const avgDocLen = opts?.avgDocLen ?? 500;

  const queryTerms = tokenize(query);
  const docTerms = tokenize(document);
  const docLen = docTerms.length;

  if (queryTerms.length === 0 || docLen === 0) return 0;

  // Term frequency in document
  const tf = new Map<string, number>();
  for (const term of docTerms) {
    tf.set(term, (tf.get(term) ?? 0) + 1);
  }

  let score = 0;
  for (const term of queryTerms) {
    const termFreq = tf.get(term) ?? 0;
    if (termFreq === 0) continue;

    // Simplified BM25 (no IDF since we don't have corpus stats)
    const numerator = termFreq * (k1 + 1);
    const denominator = termFreq + k1 * (1 - b + b * (docLen / avgDocLen));
    score += numerator / denominator;
  }

  // Normalize to 0-1 range
  return Math.min(score / queryTerms.length, 1);
}

/**
 * Merge vector search results with keyword search results using
 * reciprocal rank fusion (RRF).
 */
export function mergeHybridResults(
  vectorResults: MemorySearchResult[],
  keywordResults: MemorySearchResult[],
  opts?: { vectorWeight?: number; keywordWeight?: number; k?: number },
): MemorySearchResult[] {
  const vectorWeight = opts?.vectorWeight ?? 0.7;
  const keywordWeight = opts?.keywordWeight ?? 0.3;
  const k = opts?.k ?? 60; // RRF constant

  const merged = new Map<string, MemorySearchResult & { fusionScore: number }>();

  // Score vector results by rank
  for (let i = 0; i < vectorResults.length; i++) {
    const r = vectorResults[i];
    const key = `${r.path}:${r.startLine}`;
    const rrf = vectorWeight / (k + i + 1);
    const existing = merged.get(key);
    if (existing) {
      existing.fusionScore += rrf;
      existing.score = Math.max(existing.score, r.score);
    } else {
      merged.set(key, { ...r, fusionScore: rrf });
    }
  }

  // Score keyword results by rank
  for (let i = 0; i < keywordResults.length; i++) {
    const r = keywordResults[i];
    const key = `${r.path}:${r.startLine}`;
    const rrf = keywordWeight / (k + i + 1);
    const existing = merged.get(key);
    if (existing) {
      existing.fusionScore += rrf;
      existing.score = Math.max(existing.score, r.score);
    } else {
      merged.set(key, { ...r, fusionScore: rrf });
    }
  }

  // Sort by fusion score and return
  return [...merged.values()]
    .sort((a, b) => b.fusionScore - a.fusionScore)
    .map(({ fusionScore: _, ...rest }) => rest);
}

/** Tokenize text into lowercase terms. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Extract keywords from a query for FTS expansion. */
export function extractKeywords(query: string): string[] {
  const stopWords = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "been",
    "being", "have", "has", "had", "do", "does", "did", "will",
    "would", "could", "should", "may", "might", "can", "shall",
    "of", "at", "by", "for", "with", "about", "against", "between",
    "through", "during", "before", "after", "above", "below",
    "to", "from", "up", "down", "in", "out", "on", "off",
    "over", "under", "again", "further", "then", "once",
    "and", "but", "or", "nor", "not", "so", "yet",
    "this", "that", "these", "those", "it", "its",
    "what", "which", "who", "whom", "how", "when", "where", "why",
  ]);

  return tokenize(query).filter((t) => !stopWords.has(t) && t.length > 2);
}
