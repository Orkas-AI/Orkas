/** Shared pure BM25 scorer; no storage, account or embedding dependencies. */
import { isCJK } from './tokenize';

const BM25_K1 = 1.5;
const BM25_B = 0.75;

/** BM25 relevance plus how much of the query the doc actually covers.
 * `coverage` counts distinct query tokens present in the doc; repeating a
 * token in the query still weights the score but cannot inflate coverage. */
export interface ScoredDoc { score: number; coverage: number }

/** One posting as the scorer needs it, whatever storage produced it. */
export interface PostingRow<K> { key: K; tf: number; len: number }

/**
 * BM25 with the CJK bigram anchor, over any postings source.
 *
 * Kept generic so the in-memory context/agent/skill indexes and the SQLite
 * chat store run the *same* arithmetic: two copies would drift, and ranking
 * drift is invisible until someone notices their search got worse.
 */
export function scorePostings<K>(
  docCount: number,
  avgdl: number,
  queryTokens: string[],
  readPostings: (term: string) => PostingRow<K>[],
  options?: { allowNonCjkMatches?: boolean },
): Map<K, ScoredDoc> {
  const scores = new Map<K, ScoredDoc>();
  if (!docCount) return scores;
  // A bigram is read for the anchor and again for scoring; one lookup each.
  const cache = new Map<string, PostingRow<K>[]>();
  const postings = (term: string): PostingRow<K>[] => {
    let rows = cache.get(term);
    if (!rows) { rows = readPostings(term); cache.set(term, rows); }
    return rows;
  };

  // CJK bigram anchor filter — tokenize emits both unigrams (`苏`) and
  // bigrams (`苏格`) per CJK char. Single CJK chars match millions of
  // irrelevant docs (`拉`, `底` are everywhere) and overwhelm BM25; without
  // an anchor, searching `苏格拉底` ranks docs that only happen to contain
  // `拉` or `底` because their unigram contributions accumulate. Whenever
  // the query carries at least one CJK bigram, restrict the candidate set
  // to docs that hit at least one of those bigrams; unigram contributions
  // still adjust ranking within that set. Queries that contain ONLY single
  // CJK chars (e.g. one-char `水`) fall through to the legacy unigram path
  // so short / single-char searches still work.
  const cjkBigrams = queryTokens.filter(
    (t) => t.length === 2 && isCJK(t[0]) && isCJK(t[1]),
  );
  let anchored: Set<K> | null = null;
  if (cjkBigrams.length) {
    anchored = new Set<K>();
    for (const t of cjkBigrams) for (const row of postings(t)) anchored.add(row.key);
    // The strict default returns empty when no bigram hits. Connector
    // metadata may opt into independent non-CJK matches below; unrelated
    // CJK unigrams still cannot contribute without an anchor.
    if (anchored.size === 0 && !options?.allowNonCjkMatches) return scores;
  }

  const counted = new Set<string>();
  for (const t of queryTokens) {
    const rows = postings(t);
    if (!rows.length) continue;
    const df = rows.length;
    const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    const independentNonCjkMatch = options?.allowNonCjkMatches && ![...t].some(isCJK);
    const firstSighting = !counted.has(t);
    counted.add(t);
    for (const row of rows) {
      // Tool metadata can mix languages: an English action keyword remains
      // a valid lexical match even when a translated CJK keyword is absent.
      // CJK-only contributions still require the existing bigram anchor.
      if (anchored && !anchored.has(row.key) && !independentNonCjkMatch) continue;
      const dl = typeof row.len === 'number' ? row.len : avgdl;
      const norm = 1 - BM25_B + BM25_B * (dl / avgdl);
      const contribution = idf * (row.tf * (BM25_K1 + 1)) / (row.tf + BM25_K1 * norm);
      const scored = scores.get(row.key);
      if (scored) {
        scored.score += contribution;
        if (firstSighting) scored.coverage += 1;
      } else {
        scores.set(row.key, { score: contribution, coverage: firstSighting ? 1 : 0 });
      }
    }
  }
  return scores;
}
