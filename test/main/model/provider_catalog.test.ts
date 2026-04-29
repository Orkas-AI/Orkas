import { describe, it, expect } from 'vitest';
import {
  CATALOG,
  CURATED_MODELS,
  VISIBLE_PROVIDERS,
  FEATURED_API_PROVIDERS,
  EXTERNAL_API_PROVIDERS,
  OAUTH_ALIAS_FOR,
  EXTRA_LABELS,
  isVisibleProvider,
  providerLabel,
  providerDocsUrl,
  providerSubscriptionNote,
  sortProviderIds,
  curatedModelsFor,
  pickLatestGenerations,
} from '../../../src/main/model/provider_catalog';

describe('provider_catalog › CATALOG', () => {
  it('holds unique provider ids in display order', () => {
    const ids = CATALOG.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Global frontier labs first, then CN mainstream, then aggregators.
    expect(ids).toEqual([
      'anthropic',
      'openai-codex',
      'openai',
      'google',
      'zai',
      'moonshot',
      'kimi-coding',
      'minimax-portal',
      'minimax-portal-cn',
      'minimax-cn',
      'openrouter',
    ]);
  });

  it('has VISIBLE_PROVIDERS derived from CATALOG order', () => {
    expect([...VISIBLE_PROVIDERS]).toEqual(CATALOG.map((p) => p.id));
  });

  it('excludes oauthOnly entries from FEATURED_API_PROVIDERS (API-key docs list)', () => {
    const featuredIds = FEATURED_API_PROVIDERS.map((p) => p.id);
    expect(featuredIds).not.toContain('openai-codex');
    expect(featuredIds).toContain('openai');
    expect(featuredIds).toContain('zai');
    for (const p of FEATURED_API_PROVIDERS) {
      expect(p.docsUrl).toBeTruthy();
    }
  });

  it('tags Chinese providers with region=cn', () => {
    const cnIds = CATALOG.filter((p) => p.region === 'cn').map((p) => p.id);
    expect(cnIds).toEqual([
      'zai',
      'moonshot',
      'kimi-coding',
      'minimax-portal',
      'minimax-portal-cn',
      'minimax-cn',
    ]);
  });

  it('aliases minimax-cn → minimax-portal-cn (same CN endpoint, 不同 auth)', () => {
    // OpenAI 和 OpenAI Codex 仍是两张独立卡（OAUTH_ALIAS_FOR 不含 openai）。
    // MiniMax 的 API-key 与 OAuth 走同一 endpoint (api.minimaxi.com)，折到
    // 同一张卡更符合用户直觉。
    expect(OAUTH_ALIAS_FOR).toEqual({ 'minimax-cn': 'minimax-portal-cn' });
  });
});

describe('provider_catalog › CURATED_MODELS', () => {
  it('curates every visible non-oauth-only provider', () => {
    // Every visible provider should have a curated list — no silent fall-
    // through to pickLatestGenerations for providers we advertise.
    for (const p of CATALOG) {
      if (p.oauthOnly && p.id === 'openai-codex') {
        // openai-codex has a curated whitelist (ChatGPT subscription accepts
        // only 2 models — probed empirically).
        expect(CURATED_MODELS[p.id]?.length).toBeGreaterThan(0);
        continue;
      }
      expect(CURATED_MODELS[p.id]).toBeTruthy();
      expect(CURATED_MODELS[p.id]!.length).toBeGreaterThan(0);
    }
  });

  it('lists Chinese provider models', () => {
    expect(CURATED_MODELS.zai?.length).toBeGreaterThan(0);
    expect(CURATED_MODELS['kimi-coding']?.length).toBeGreaterThan(0);
    expect(CURATED_MODELS['minimax-cn']?.length).toBeGreaterThan(0);
    expect(CURATED_MODELS['moonshot']?.length).toBeGreaterThan(0);
  });

  it('moonshot catalog 只列当代主力 K2.6 / K2.5(legacy preview 已下架)', () => {
    const ids = (CURATED_MODELS['moonshot'] || []).map((m) => m.id);
    // 顺序锁:UI 下拉默认选首项,必须是当前推荐的 K2.6
    expect(ids).toEqual(['kimi-k2.6', 'kimi-k2.5']);
  });

  it('openrouter catalog includes DeepSeek / Qwen / GLM / Kimi / MiniMax', () => {
    const ids = (CURATED_MODELS.openrouter || []).map((m) => m.id);
    expect(ids.some((id) => id.startsWith('deepseek/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('qwen/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('z-ai/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('moonshotai/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('minimax/'))).toBe(true);
  });

  it('curatedModelsFor returns a shallow copy safe to mutate', () => {
    const a = curatedModelsFor('anthropic');
    const b = curatedModelsFor('anthropic');
    expect(a).not.toBe(b);
    a.pop();
    expect(curatedModelsFor('anthropic').length).toBe(b.length);
  });

  it('curatedModelsFor returns [] for unknown providers (triggers pi-ai fallback)', () => {
    expect(curatedModelsFor('no-such-provider-id')).toEqual([]);
  });
});

describe('provider_catalog › labels and docs', () => {
  it('providerLabel prefers CATALOG, then EXTRA_LABELS, then the raw id', () => {
    expect(providerLabel('zai')).toBe('Zhipu GLM');
    expect(providerLabel('minimax')).toBe(EXTRA_LABELS['minimax']);
    expect(providerLabel('totally-unknown-id')).toBe('totally-unknown-id');
  });

  it('providerDocsUrl is defined for every FEATURED_API_PROVIDERS entry', () => {
    for (const p of FEATURED_API_PROVIDERS) {
      expect(providerDocsUrl(p.id)).toBeTruthy();
    }
  });

  it('providerDocsUrl is undefined for oauthOnly providers', () => {
    expect(providerDocsUrl('openai-codex')).toBeUndefined();
  });

  it('providerDocsUrl is undefined for orphan providers', () => {
    expect(providerDocsUrl('huggingface')).toBeUndefined();
  });

  it('providerSubscriptionNote 在两条 Moonshot endpoint 上都给出明确前提', () => {
    // 用户反馈：开放平台按量付费和 Moonshot Coding Plan 订阅是两套独立账户，
    // 一张 key 不能两边通用。UI 必须在卡片/表单上把前提标清楚。
    const moonshotNote = providerSubscriptionNote('moonshot');
    const codingNote   = providerSubscriptionNote('kimi-coding');
    expect(moonshotNote).toMatch(/开放平台/);
    expect(moonshotNote).toMatch(/按量|付费/);
    expect(codingNote).toMatch(/Coding Plan/);
    expect(codingNote).toMatch(/订阅|月付/);
  });

  it('providerSubscriptionNote 对没前提要求的 provider 返 undefined', () => {
    expect(providerSubscriptionNote('anthropic')).toBeUndefined();
    expect(providerSubscriptionNote('openai')).toBeUndefined();
    expect(providerSubscriptionNote('totally-unknown')).toBeUndefined();
  });
});

describe('provider_catalog › EXTERNAL_API_PROVIDERS', () => {
  it('列出所有走 Orkas 自建适配层的 provider（pi-ai 不认识）', () => {
    // EXTERNAL_API_PROVIDERS 是 `listProviders` / `runner.ts::buildRunner` /
    // `auth.ts::testConnection` 的分发依据——名单必须和 CATALOG 里真实
    // 标记为"外部"的 provider 严格一致，否则会出现"能选但调用报
    // No model found for provider"。
    expect([...EXTERNAL_API_PROVIDERS]).toEqual(['moonshot']);
  });

  it('每个外部 provider 都在 CATALOG + CURATED_MODELS 有对应条目', () => {
    for (const id of EXTERNAL_API_PROVIDERS) {
      expect(CATALOG.find((p) => p.id === id)).toBeTruthy();
      expect(CURATED_MODELS[id]?.length).toBeGreaterThan(0);
    }
  });
});

describe('provider_catalog › isVisibleProvider / sortProviderIds', () => {
  it('isVisibleProvider mirrors CATALOG membership', () => {
    expect(isVisibleProvider('anthropic')).toBe(true);
    expect(isVisibleProvider('zai')).toBe(true);
    expect(isVisibleProvider('minimax')).toBe(false); // only minimax-cn is visible
  });

  it('sortProviderIds puts CATALOG ids first in CATALOG order, orphans last alphabetically', () => {
    const input = ['minimax', 'huggingface', 'openrouter', 'anthropic', 'zai'];
    expect(sortProviderIds(input)).toEqual([
      'anthropic',
      'zai',
      'openrouter',
      'huggingface',
      'minimax',
    ]);
  });
});

describe('provider_catalog › pickLatestGenerations (fallback)', () => {
  it('keeps the last N version bands newest-first', () => {
    const raw = [
      { id: 'foo-1.0', name: 'Foo 1.0' },
      { id: 'foo-2.0', name: 'Foo 2.0' },
      { id: 'foo-2.1', name: 'Foo 2.1' },
      { id: 'foo-2.1-mini', name: 'Foo 2.1 Mini' },
      { id: 'foo-3.0', name: 'Foo 3.0' },
    ];
    const picked = pickLatestGenerations(raw, 2);
    expect(picked.map((m) => m.id)).toEqual([
      'foo-3.0',
      'foo-2.1',
      'foo-2.1-mini',
    ]);
  });

  it('drops preview / dated / :free variants', () => {
    const raw = [
      { id: 'foo-2.0' },
      { id: 'foo-2.0-preview' },
      { id: 'foo-2.0-2025-01-15' },
      { id: 'vendor/foo-2.0:free' },
    ];
    const picked = pickLatestGenerations(raw, 1);
    expect(picked.map((m) => m.id)).toEqual(['foo-2.0']);
  });

  it('returns [] on empty / invalid input', () => {
    expect(pickLatestGenerations([], 2)).toEqual([]);
    expect(pickLatestGenerations(null as any, 2)).toEqual([]);
  });
});
