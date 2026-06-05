import * as fs from 'node:fs';
import * as path from 'node:path';
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
  resolveConfiguredPiModel,
  pickLatestGenerations,
} from '../../../src/main/model/provider_catalog';

describe('provider_catalog › CATALOG', () => {
  it('holds unique provider ids in display order', () => {
    const ids = CATALOG.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // DeepSeek 直连先（pi-ai 不带，自建适配），然后全球前沿（OpenAI Codex /
    // OpenAI / Google / Anthropic），CN 主流（Zhipu / Moonshot / Kimi-Coding /
    // MiniMax × 3 / Doubao），最后聚合器（OpenRouter）。
    expect(ids).toEqual([
      'deepseek',
      'openai-codex',
      'openai',
      'google',
      'anthropic',
      'zai',
      'moonshot',
      'kimi-coding',
      'minimax-portal',
      'minimax-portal-cn',
      'minimax-cn',
      'doubao',
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
      'doubao',
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

  it('openrouter Claude catalog is limited to Opus 4.8 and 4.7', () => {
    const claudeIds = (CURATED_MODELS.openrouter || [])
      .map((m) => m.id)
      .filter((id) => id.includes('/claude-'));
    expect(claudeIds).toEqual([
      'anthropic/claude-opus-4.8',
      'anthropic/claude-opus-4.7',
    ]);
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

  it('curatedModelsFor can be overridden by Server remote-config cache', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const storage = await import('../../../src/main/storage');
    const uid = 'modelcfgtest';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    storage.writeJsonSync(file, {
      version: 1,
      active: {
        immediate: {
          model_catalog: {
            providers: {
              openai: [{ id: 'gpt-test-next', name: 'GPT Test Next' }],
            },
          },
        },
      },
    });
    try {
      expect(curatedModelsFor('openai')).toEqual([
        { id: 'gpt-test-next', name: 'GPT Test Next' },
      ]);
      expect(curatedModelsFor('anthropic').length).toBeGreaterThan(0);
      expect(CURATED_MODELS.openai?.[0]?.id).not.toBe('gpt-test-next');
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('curatedModelsFor reflects a Server model upgrade and removal', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const storage = await import('../../../src/main/storage');
    const uid = 'modelcfgupgrade';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    storage.writeJsonSync(file, {
      version: 1,
      active: {
        immediate: {
          model_catalog: {
            providers: {
              anthropic: [
                { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
                { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
              ],
            },
          },
        },
      },
    });
    try {
      expect(curatedModelsFor('anthropic').map((m) => m.id)).toEqual([
        'claude-opus-4-8',
        'claude-opus-4-7',
      ]);
      expect(curatedModelsFor('anthropic').map((m) => m.id)).not.toContain('claude-opus-4-6');
      expect(curatedModelsFor('anthropic').map((m) => m.id)).not.toContain('claude-sonnet-4-6');
      expect(curatedModelsFor('openai').length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('resolves configured model ids by cloning a same-family pi-ai template', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const storage = await import('../../../src/main/storage');
    const uid = 'modelcfgfallback';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    storage.writeJsonSync(file, {
      version: 1,
      active: {
        immediate: {
          model_catalog: {
            providers: {
              anthropic: [
                { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
                { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
              ],
            },
          },
        },
      },
    });
    const template = {
      id: 'claude-opus-4-7',
      name: 'Claude Opus 4.7',
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      reasoning: true,
      input: ['text'],
      cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
      contextWindow: 200000,
      maxTokens: 32000,
    };
    const catalog = {
      getPiModel(provider: string, model: string) {
        return provider === 'anthropic' && model === 'claude-opus-4-7'
          ? template as any
          : undefined;
      },
    };
    try {
      const resolved = resolveConfiguredPiModel(catalog, 'anthropic', 'claude-opus-4-8');
      expect(resolved?.needsCustomModel).toBe(true);
      expect(resolved?.isConfiguredFallback).toBe(true);
      expect(resolved?.templateModelId).toBe('claude-opus-4-7');
      expect(resolved?.model.id).toBe('claude-opus-4-8');
      expect(resolved?.model.name).toBe('Claude Opus 4.8');
      expect(resolved?.model.api).toBe(template.api);

      const exactCatalog = {
        getPiModel(provider: string, model: string) {
          return provider === 'anthropic' && model === 'claude-opus-4-8'
            ? { ...template, id: 'claude-opus-4-8', name: 'Claude Opus 4.8' } as any
            : undefined;
        },
      };
      const exact = resolveConfiguredPiModel(exactCatalog, 'anthropic', 'claude-opus-4-8');
      expect(exact?.needsCustomModel).toBe(false);
      expect(exact?.isConfiguredFallback).toBe(false);
      expect(exact?.templateModelId).toBe('claude-opus-4-8');

      const wrongFamilyCatalog = {
        getPiModel(provider: string, model: string) {
          return provider === 'anthropic' && model === 'claude-haiku-4-8'
            ? { ...template, id: 'claude-haiku-4-8', name: 'Claude Haiku 4.8' } as any
            : undefined;
        },
      };
      expect(resolveConfiguredPiModel(wrongFamilyCatalog, 'anthropic', 'claude-opus-4-8')).toBeNull();
      expect(resolveConfiguredPiModel(catalog, 'anthropic', 'claude-opus-4-9')).toBeNull();
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
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
    // catalog 把前提存成 i18n key（renderer 端 t() 翻译），这里验 key 命名
    // 语义自带"paygo / subscription"区分，避免上线时两条混淆。
    expect(providerSubscriptionNote('moonshot')).toBe('provider.moonshot.note_paygo');
    expect(providerSubscriptionNote('kimi-coding')).toBe('provider.kimi_coding.note_subscription');
  });

  it('providerSubscriptionNote 对没前提要求的 provider 返 undefined / 空串', () => {
    // anthropic / openai 没声明 subscriptionNote → undefined；
    // doubao 在 catalog 里显式写了空串占位 → 空串。两种都视为"无前提"。
    expect(providerSubscriptionNote('anthropic')).toBeUndefined();
    expect(providerSubscriptionNote('openai')).toBeUndefined();
    expect(providerSubscriptionNote('totally-unknown')).toBeUndefined();
    expect(providerSubscriptionNote('doubao') || undefined).toBeUndefined();
  });
});

describe('provider_catalog › EXTERNAL_API_PROVIDERS', () => {
  it('列出所有走 Orkas 自建适配层的 provider（pi-ai 不认识）', () => {
    // EXTERNAL_API_PROVIDERS 是 `listProviders` / `runner.ts::buildRunner` /
    // `auth.ts::testConnection` 的分发依据——名单必须和 CATALOG 里真实
    // 标记为"外部"的 provider 严格一致，否则会出现"能选但调用报
    // No model found for provider"。
    // 当前外部适配层支持：moonshot（OpenAI 兼容 endpoint）+ deepseek（pi-ai
    // 0.68.1 不带）+ doubao（火山方舟）。
    expect([...EXTERNAL_API_PROVIDERS]).toEqual(['moonshot', 'deepseek', 'doubao']);
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
