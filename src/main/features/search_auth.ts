/**
 * Search-tool API key management.
 *
 * Reads/writes `searchProfiles` in `<uid>/local/config/auth-profiles.json`
 * (see `features/auth.ts`). One row per `(provider, apiKey)` pair, in
 * priority order — the first row wins; rest are fallbacks.
 *
 * Supported search providers (one-shot adapters in `model/core-agent/search-tools.ts`):
 *   - tavily            (https://tavily.com)
 *   - serper            (https://serper.dev)
 *   - brave-search      (https://brave.com/search/api/)
 *   - baidu-ai-search   (https://cloud.baidu.com/doc/qianfan-api/s/em82g4tlk)
 *
 * Bing Search API v7 is intentionally NOT supported here — Microsoft
 * retired it on 2025-08-11; the successor "Grounding with Bing Search" is
 * an Azure AI Foundry-bound platform integration, not a "drop in a key"
 * REST API.
 */

import {
  loadSearchProfiles,
  saveSearchProfiles,
  type SearchProfile,
} from './auth';
import { createLogger } from '../logger';
import { searchAdaptersByProvider, runSearchAdapter } from '../model/core-agent/search-adapters';
import { logErrorSummary } from '../util/log-redact';

const log = createLogger('search-auth');

let _idCounter = 0;
function nextSearchProfileId(): string {
  _idCounter = (_idCounter + 1) % 100000;
  return `s-${Date.now().toString(36)}-${_idCounter}`;
}

function sanitizeLabel(input: string): string {
  return String(input || '').trim().slice(0, 40) || 'default';
}

export function listSearchProfiles(): SearchProfile[] {
  return loadSearchProfiles();
}

/**
 * Pick the first usable search profile for tool dispatch. Returns null when
 * the user has no search profiles configured (caller should fall back to
 * the keyless built-in web_search).
 */
export function pickActiveSearchProfile(): SearchProfile | null {
  return listSearchProfiles()[0] || null;
}

/** Quick boolean for `native-search-tools.ts` to short-circuit native
 *  search injection when the user has any paid search API configured. */
export function hasAnySearchProfile(): boolean {
  return listSearchProfiles().length > 0;
}

export interface AddSearchProfileInput {
  provider: string;
  apiKey: string;
  label?: string;
  extras?: Record<string, string>;
}

export function addSearchProfile(input: AddSearchProfileInput): { ok: true; id: string } | { ok: false; error: string } {
  const provider = String(input.provider || '').trim();
  const apiKey = String(input.apiKey || '').trim();
  if (!provider) return { ok: false, error: 'provider required' };
  if (!apiKey) return { ok: false, error: 'apiKey required' };
  if (!searchAdaptersByProvider[provider]) {
    return { ok: false, error: `unknown search provider "${provider}"` };
  }
  const list = loadSearchProfiles();
  const existing = list.find((profile) => (
    profile.provider === provider && profile.apiKey === apiKey
  ));
  if (existing) return { ok: true, id: existing.id };
  const profile: SearchProfile = {
    id: nextSearchProfileId(),
    provider,
    apiKey,
    label: sanitizeLabel(input.label || 'default'),
    createdAt: Date.now(),
    extras: input.extras && Object.keys(input.extras).length ? { ...input.extras } : undefined,
  };
  list.unshift(profile);
  saveSearchProfiles(list);
  log.info('search profile added', { id: profile.id, provider });
  return { ok: true, id: profile.id };
}

export function removeSearchProfile(id: string): { ok: boolean } {
  const list = loadSearchProfiles();
  const next = list.filter((p) => p.id !== id);
  if (next.length === list.length) return { ok: false };
  saveSearchProfiles(next);
  log.info('search profile removed', { id });
  return { ok: true };
}

export function reorderSearchProfiles(orderedIds: string[]): { ok: boolean } {
  const list = loadSearchProfiles();
  const idx = new Map(orderedIds.map((id, i) => [id, i]));
  const next = [...list].sort((a, b) => {
    const ra = idx.has(a.id) ? (idx.get(a.id) as number) : 1000;
    const rb = idx.has(b.id) ? (idx.get(b.id) as number) : 1000;
    return ra - rb;
  });
  saveSearchProfiles(next);
  return { ok: true };
}

export interface TestSearchProfileResult {
  ok: boolean;
  durationMs: number;
  error?: string;
  resultCount?: number;
}

function userFacingSearchProbeError(err: unknown): string {
  const value = err as { name?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
  const message = String(value?.message || err || '');
  const explicitStatus = Number(value?.status || value?.statusCode);
  const statusMatch = message.match(/\b(401|402|403|408|429)\b/);
  const status = Number.isFinite(explicitStatus) && explicitStatus > 0
    ? explicitStatus
    : Number(statusMatch?.[1] || 0);
  if (status === 401 || status === 403) return 'search credentials rejected';
  if (status === 402) return 'search credits unavailable';
  if (status === 429) return 'search rate limited';
  if (status === 408 || value?.name === 'AbortError' || /timed?\s*out/i.test(message)) {
    return 'search request timed out';
  }
  return 'search request failed';
}

export async function testSearchProfile(id: string): Promise<TestSearchProfileResult> {
  const list = loadSearchProfiles();
  const target = list.find((p) => p.id === id);
  if (!target) return { ok: false, durationMs: 0, error: 'profile not found' };
  const t0 = Date.now();
  try {
    const res = await runSearchAdapter(target, 'Orkas connectivity probe', 1);
    return { ok: true, durationMs: Date.now() - t0, resultCount: res.results.length };
  } catch (err) {
    log.warn('search profile test failed', {
      id,
      provider: target.provider,
      error: logErrorSummary(err),
    });
    return {
      ok: false,
      durationMs: Date.now() - t0,
      error: userFacingSearchProbeError(err),
    };
  }
}
