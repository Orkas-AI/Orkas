/**
 * `web_search` override — last-write-wins replacement for core-agent's
 * built-in keyless web_search.
 *
 * Resolution order on every call:
 *   1. If the user configured ANY paid search API key (`searchProfiles`),
 *      route the query through the first usable adapter (Tavily / Serper /
 *      Brave / Baidu AI Search). On success → return; on failure → fall
 *      through to step 2 with a noted error.
 *   2. Otherwise, delegate to the keyless Brave/Bing HTML scraper exposed
 *      by core-agent as `runBuiltinWebSearch` — same behavior as before
 *      this override existed.
 *
 * Why override instead of letting core-agent run its tool? Two reasons:
 *   - We want the paid API to take precedence (user paid for it; don't
 *     burn brave-bing rate limits when they have a key).
 *   - We want to cleanly disable native model-side `web_search` (see
 *     `native-search-tools.ts`) when the user has a paid search profile,
 *     so the LLM doesn't have two competing search surfaces.
 *
 * Tool name MUST stay exactly `web_search` so AgentRunner's tool map
 * overwrites core-agent's builtin (last-write-wins).
 */

import type { AgentTool } from '#core-agent';
import { pickActiveSearchProfile } from '../../features/search_auth';
import { runSearchAdapter, SEARCH_PROVIDER_LABEL } from './search-adapters';
import { createLogger } from '../../logger';

// core-agent is ESM; main is CJS. Static import would yank pi-ai into the
// CJS load graph and crash with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Same
// dynamic-import + lazy-cache pattern used by runner.ts / external-providers.ts.
type CA = typeof import('#core-agent');
let _caPromise: Promise<CA> | null = null;
function ca(): Promise<CA> {
  if (!_caPromise) _caPromise = import('#core-agent') as Promise<CA>;
  return _caPromise;
}

const log = createLogger('search-tools');

const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;

function formatPaidResults(query: string, providerLabel: string, results: { title: string; url: string; snippet: string }[]): string {
  if (!results.length) {
    return `No search results for: "${query}" (via ${providerLabel})`;
  }
  const lines = [`Search results for: "${query}" (via ${providerLabel})\n`];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   URL: ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push('');
  });
  lines.push('Use the web_fetch tool to read the full content of any result URL.');
  return lines.join('\n');
}

export async function createWebSearchOverrideTool(): Promise<AgentTool> {
  const mod = await ca();
  return mod.defineTool({
    name: 'web_search',
    description:
      'Search the web for information. Returns a list of search results with titles, URLs, and snippets. ' +
      'Use this when you need to find current information, news, documentation, or any web content. ' +
      'After searching, use web_fetch to read the full content of relevant result URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        count: { type: 'number', description: `Number of results to return (default: ${DEFAULT_COUNT}, max: ${MAX_COUNT}).` },
      },
      required: ['query'],
    },
    async execute(input) {
      const query = String((input as any)?.query || '').trim();
      const requested = Number((input as any)?.count) || DEFAULT_COUNT;
      const count = Math.min(Math.max(1, requested), MAX_COUNT);
      if (!query) return { content: 'Error: query is required', isError: true };

      const profile = pickActiveSearchProfile();
      if (profile) {
        const label = SEARCH_PROVIDER_LABEL[profile.provider] || profile.provider;
        log.info('web_search via paid API', { provider: profile.provider, query_len: query.length, count });
        try {
          const res = await runSearchAdapter(profile, query, count);
          log.info('web_search paid API ok', { provider: profile.provider, results: res.results.length });
          const text = formatPaidResults(query, label, res.results);
          return res.results.length ? { content: text } : { content: text, isError: true };
        } catch (err) {
          const msg = (err as Error).message || String(err);
          log.warn(`paid search failed (${profile.provider}); falling back to built-in: ${msg}`);
          // Fall through to the keyless built-in — better degraded answer
          // than a hard error when the user typed a real query.
          const fallback = await mod.runBuiltinWebSearch(query, count);
          if (fallback.isError) {
            return {
              content: `Paid search via ${label} failed: ${msg}\nKeyless fallback also failed: ${fallback.content}`,
              isError: true,
            };
          }
          return {
            content: `(paid search via ${label} failed: ${msg} — falling back to keyless built-in)\n\n${fallback.content}`,
          };
        }
      }

      log.info('web_search via builtin keyless (no paid profile configured)', { query_len: query.length, count });
      return mod.runBuiltinWebSearch(query, count);
    },
  });
}
