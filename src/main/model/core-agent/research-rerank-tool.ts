/**
 * `research_rerank` tool — semantic relevance reranking for the deep-research
 * agent, owned by it (TOOL_CATALOG `ownerAgent`).
 *
 * The deep-research `compress` skill (Python, stdlib) filters passages by LEXICAL
 * keyword overlap — fast and deterministic, but semantically blind: a passage
 * that is on-topic but shares no query words ("the model runs locally on your
 * laptop" vs a query about "on-device inference") scores zero and is dropped. A
 * Python skill subprocess cannot reach the embedding engine, so this second,
 * SEMANTIC pass lives here as a core-agent tool: it embeds the query and each
 * passage with the app's local `kb_embed` (fastembed bge-small-zh, zero new
 * dependency) and ranks by embedding similarity.
 *
 * Two-stage funnel: cheap lexical `compress` narrows the candidates, this tool
 * reranks the survivors by meaning. Returns rank + score keyed by the passage's
 * input index (and passthrough id/source/url/title), NOT the passage text — the
 * caller already holds the text and maps back by index.
 *
 * kb_embed returns unit-normalized vectors, so cosine similarity == dot product.
 * Pure ranking helpers are exported for unit testing without loading the model.
 */

import type { AgentTool, ToolResult } from '#core-agent';
import { embedQuery, embedTexts } from '../../features/kb_embed';
import { createLogger } from '../../logger';

const log = createLogger('research-rerank-tool');

// Bound the embedding work per call; the caller should pre-narrow with compress.
const MAX_PASSAGES = 256;
const _META_KEYS = ['id', 'source', 'url', 'title'] as const;

export interface RankedItem {
  index: number;
  score: number;
  id?: string;
  source?: string;
  url?: string;
  title?: string;
}

export function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function _meta(p: Record<string, unknown>): Partial<RankedItem> {
  const out: Partial<RankedItem> = {};
  for (const k of _META_KEYS) {
    if (typeof p[k] === 'string' && p[k]) (out as Record<string, unknown>)[k] = p[k];
  }
  return out;
}

/**
 * Rank passages by similarity of their vector to the query vector. Stable: ties
 * break on the original input index, so the output order is deterministic. When
 * topK > 0 only the top K are returned.
 */
export function rankBySimilarity(
  queryVec: number[],
  passageVecs: number[][],
  passages: Array<Record<string, unknown>>,
  topK?: number,
): RankedItem[] {
  const scored = passageVecs.map((v, i) => ({ i, score: dot(queryVec, v) }));
  scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
  const kept = topK && topK > 0 ? scored.slice(0, topK) : scored;
  return kept.map(({ i, score }) => ({
    index: i,
    ..._meta(passages[i] || {}),
    score: Math.round(score * 1e6) / 1e6,
  }));
}

export function createResearchRerankTool(): AgentTool {
  return {
    name: 'research_rerank',
    description:
      'Rerank candidate research passages by SEMANTIC relevance to a sub-question, using local embeddings. '
      + 'Use it as the second stage after the deep-research compress skill: compress filters by keyword overlap (and drops a relevant passage that happens to share no query words), then this tool reorders the survivors by MEANING, so on-topic passages with different wording still surface. '
      + 'Pass the sub-question as `query` and the candidate `passages` (each at least a `text`, plus optional id/source/url/title). '
      + 'Returns `ranked` as `{index, score, ...passthrough}` sorted most-relevant first — `index` refers to your ORIGINAL passages array (invalid entries are skipped without shifting indices). '
      + 'At most 256 passages are evaluated per call; the response sets `truncated: true` when the input exceeded that (pre-narrow with compress). Read-only, local, no extra cost.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The sub-question to rank passages against.' },
        passages: {
          type: 'array',
          description: 'Candidate passages to rank (pre-narrow large sets with the compress skill first).',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The passage text to embed and score.' },
              id: { type: 'string', description: 'Optional stable id echoed back in the ranking.' },
              source: { type: 'string', description: 'Optional source id (echoed back).' },
              url: { type: 'string', description: 'Optional source url (echoed back).' },
              title: { type: 'string', description: 'Optional source title (echoed back).' },
            },
            required: ['text'],
          },
        },
        top_k: { type: 'number', description: 'Keep only the top K most relevant (default: return all, ranked).' },
      },
      required: ['query', 'passages'],
    },
    async execute(input): Promise<ToolResult> {
      const query = String((input as { query?: unknown }).query ?? '').trim();
      if (!query) return { content: 'query is required', isError: true };

      const rawList = (input as { passages?: unknown }).passages;
      const raw = Array.isArray(rawList) ? (rawList as Array<Record<string, unknown>>) : [];
      // Keep each passage's ORIGINAL input index: the contract is "map back to
      // your passages by index", so filtering an invalid entry (or truncating at
      // MAX_PASSAGES) must not shift the indices the caller receives.
      const valid = raw
        .map((p, origIndex) => ({ p, origIndex }))
        .filter(({ p }) => p && typeof p.text === 'string' && (p.text as string).trim());
      const kept = valid.slice(0, MAX_PASSAGES);
      const passages = kept.map(({ p }) => p);
      const origIndices = kept.map(({ origIndex }) => origIndex);
      const truncated = valid.length > kept.length;
      if (!passages.length) {
        return { content: 'passages must be a non-empty array of objects each with a non-empty `text`', isError: true };
      }
      const tkRaw = (input as { top_k?: unknown }).top_k;
      const topK = typeof tkRaw === 'number' && tkRaw > 0 ? Math.floor(tkRaw) : undefined;

      try {
        const [queryVec, passageVecs] = await Promise.all([
          embedQuery(query),
          embedTexts(passages.map((p) => p.text as string)),
        ]);
        const ranked = rankBySimilarity(queryVec, passageVecs, passages, topK)
          .map((item) => ({ ...item, index: origIndices[item.index] }));
        return {
          content: JSON.stringify({
            query,
            input_total: raw.length,
            total: passages.length,
            count: ranked.length,
            ...(truncated ? { truncated: true } : {}),
            ranked,
          }),
        };
      } catch (err) {
        log.warn(`rerank failed: ${(err as Error).message}`);
        return { content: `E_RERANK_FAILED: ${(err as Error).message}`, isError: true };
      }
    },
  };
}
