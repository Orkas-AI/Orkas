import { describe, it, expect, vi } from 'vitest';

/**
 * research_rerank tool contract + ranking tests. kb_embed is mocked with 3-dim
 * unit vectors (dot() uses min length) so tests never load the ONNX model and the
 * expected similarity order is deterministic: hit(1) > mid(0.6) > miss(0).
 */
vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async () => [1, 0, 0],
  embedTexts: async (texts: string[]) => texts.map((t) => {
    if (t === 'hit') return [1, 0, 0];
    if (t === 'mid') return [0.6, 0.8, 0];
    return [0, 1, 0]; // "miss" / anything else — orthogonal to the query
  }),
  closeEmbedder: () => {},
}));

import { createResearchRerankTool, rankBySimilarity, dot } from '../../../../src/main/model/core-agent/research-rerank-tool';

const tool = createResearchRerankTool();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (input: unknown) => tool.execute(input as any, {} as any);

describe('research_rerank tool', () => {
  it('ranks by semantic similarity, not input order', async () => {
    const res = await call({ query: 'on device privacy', passages: [
      { text: 'miss', id: 'm' }, { text: 'hit', id: 'h' }, { text: 'mid', id: 'd' },
    ] });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content);
    expect(data.ranked.map((r: { index: number }) => r.index)).toEqual([1, 2, 0]); // hit > mid > miss
    expect(data.ranked.map((r: { id: string }) => r.id)).toEqual(['h', 'd', 'm']);
    expect(data.ranked[0].score).toBeCloseTo(1, 6);
    expect(data.ranked[1].score).toBeCloseTo(0.6, 6);
    expect(data.total).toBe(3);
    expect(data.count).toBe(3);
  });

  it('respects top_k', async () => {
    const res = await call({ query: 'q', top_k: 2, passages: [
      { text: 'miss' }, { text: 'hit' }, { text: 'mid' },
    ] });
    const data = JSON.parse(res.content);
    expect(data.count).toBe(2);
    expect(data.ranked.map((r: { index: number }) => r.index)).toEqual([1, 2]);
  });

  it('does not echo passage text back (caller maps by index)', async () => {
    const res = await call({ query: 'q', passages: [{ text: 'hit', id: 'h' }] });
    const data = JSON.parse(res.content);
    expect(data.ranked[0]).not.toHaveProperty('text');
    expect(data.ranked[0]).toMatchObject({ index: 0, id: 'h' });
  });

  it('errors on empty query', async () => {
    const res = await call({ query: '   ', passages: [{ text: 'hit' }] });
    expect(res.isError).toBe(true);
  });

  it('errors on empty passages', async () => {
    expect((await call({ query: 'q', passages: [] })).isError).toBe(true);
    expect((await call({ query: 'q' })).isError).toBe(true);
  });

  it('filters invalid passages WITHOUT shifting the returned indices', async () => {
    // The contract is "map back to your passages by index": the surviving "hit"
    // passage sits at ORIGINAL index 2, and the two invalid entries before it
    // must not shift it (returning 0 here would misattribute the caller's text).
    const res = await call({ query: 'q', passages: [{ text: '' }, { foo: 1 }, { text: 'hit' }] });
    const data = JSON.parse(res.content);
    expect(data.input_total).toBe(3);
    expect(data.total).toBe(1); // only the "hit" passage was evaluated
    expect(data.ranked[0].index).toBe(2); // original position, not filtered position
    expect(data.truncated).toBeUndefined();
  });

  it('flags truncation beyond MAX_PASSAGES instead of dropping silently', async () => {
    const passages = Array.from({ length: 257 }, (_, i) => ({ text: i === 0 ? 'hit' : 'miss' }));
    const res = await call({ query: 'q', passages });
    const data = JSON.parse(res.content);
    expect(data.input_total).toBe(257);
    expect(data.total).toBe(256);   // evaluated set is capped
    expect(data.truncated).toBe(true);
    expect(data.ranked[0].index).toBe(0); // "hit" still ranks first with its original index
  });
});

describe('rankBySimilarity / dot (pure)', () => {
  it('dot product, min-length', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(dot([1, 2], [3, 4, 5])).toBe(11);
  });

  it('stable tie-break keeps input order among equal scores', () => {
    const ranked = rankBySimilarity([1, 0], [[1, 0], [1, 0], [0, 1]], [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(ranked.map((r) => r.index)).toEqual([0, 1, 2]); // a,b tie at 1 keep order; c at 0 last
  });

  it('passes through only known metadata and rounds score to 6dp', () => {
    const ranked = rankBySimilarity([1, 0, 0], [[0.3333333333, 0, 0]],
      [{ id: 'x', url: 'u', source: 's', title: 't', extra: 'drop' }]);
    expect(ranked[0]).toMatchObject({ index: 0, id: 'x', url: 'u', source: 's', title: 't' });
    expect(ranked[0].score).toBe(0.333333);
    expect((ranked[0] as Record<string, unknown>).extra).toBeUndefined();
  });
});
