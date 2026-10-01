import { describe, expect, it } from 'vitest';
import { scorePostings } from '../../../../src/main/features/search/bm25';

const postings = (term: string) => ({
  invoice: [{ key: 'english', tf: 1, len: 3 }],
  发: [{ key: 'noise', tf: 1, len: 3 }],
  票: [{ key: 'noise', tf: 1, len: 3 }],
  发票: [{ key: 'chinese', tf: 1, len: 3 }],
}[term] || []);

describe('BM25 language boundaries', () => {
  it('retains strict CJK anchoring for existing search callers', () => {
    expect([...scorePostings(3, 3, ['invoice', '发', '票', '发票'], postings).keys()]).toEqual(['chinese']);
    expect(scorePostings(3, 3, ['invoice', '金', '金额'], postings).size).toBe(0);
  });
  it('allows independent Latin matches for connector metadata without admitting CJK unigram noise', () => {
    const scores = scorePostings(3, 3, ['invoice', '发', '票', '发票'], postings, { allowNonCjkMatches: true });
    expect([...scores.keys()]).toEqual(['english', 'chinese']);
    expect(scores.get('english')!.score).toBeCloseTo(Math.log(1 + 2.5 / 1.5));
    expect(scores.has('noise')).toBe(false);
    expect([...scorePostings(3, 3, ['invoice', '金', '金额'], postings, { allowNonCjkMatches: true }).keys()]).toEqual(['english']);
  });
  it('does not change pure-English scores or CJK-only no-match results', () => {
    expect(scorePostings(3, 3, ['invoice'], postings, { allowNonCjkMatches: true })).toEqual(scorePostings(3, 3, ['invoice'], postings));
    expect(scorePostings(3, 3, ['金', '金额'], postings, { allowNonCjkMatches: true }).size).toBe(0);
  });
});
