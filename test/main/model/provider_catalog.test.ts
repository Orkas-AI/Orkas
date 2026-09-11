import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
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
  modelInputFromConfiguredCapabilities,
  modelInputImageLimit,
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
      'orkas-api',
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
      'custom',
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
  it('describes both Orkas official models with their product-facing names', () => {
    expect(providerLabel('orkas-api')).toBe('Orkas');
    expect(curatedModelsFor('orkas-api')).toEqual([
      expect.objectContaining({
        id: 'orkas-llm-1.5',
        name: 'Orkas-1.5',
        recommended: true,
        includedModels: ['DeepSeek V4', 'GPT-5.6 Luna', 'Claude-Sonnet-5', 'Gemini-3.6 Flash'],
      }),
      expect.objectContaining({
        id: 'orkas-llm-1.5-pro',
        name: 'Orkas-1.5 Pro',
        includedModels: ['GPT-5.6 Sol', 'Claude Opus 5', 'Kimi K3'],
      }),
    ]);
  });

  it('curates every visible non-oauth-only provider', () => {
    // Every visible provider should have a curated list — no silent fall-
    // through to pickLatestGenerations for providers we advertise.
    for (const p of CATALOG) {
      if (p.customOpenAICompatible) {
        expect(CURATED_MODELS[p.id]).toBeUndefined();
        continue;
      }
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

  it('moonshot catalog exposes only K3 and K2.7', () => {
    const ids = (CURATED_MODELS['moonshot'] || []).map((m) => m.id);
    expect(ids).toEqual(['kimi-k3', 'kimi-k2.7-code']);
  });

  it('kimi-coding catalog exposes only K3 and K2.7', () => {
    expect((CURATED_MODELS['kimi-coding'] || []).map((m) => m.id)).toEqual(['k3', 'k2p7']);
  });

  it('minimax catalog exposes M3 before the M2.7 generation', () => {
    const directIds = (CURATED_MODELS['minimax-cn'] || []).map((m) => m.id);
    expect(directIds).toEqual([
      'MiniMax-M3',
      'MiniMax-M2.7',
    ]);

    const globalPortalIds = (CURATED_MODELS['minimax-portal'] || []).map((m) => m.id);
    expect(globalPortalIds).toEqual(directIds);

    const portalIds = (CURATED_MODELS['minimax-portal-cn'] || []).map((m) => m.id);
    expect(portalIds).toEqual(directIds);
  });

  it('exposes GPT-6 and the current GPT-5.6 family for OpenAI and OpenAI Codex', () => {
    const expected = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
    expect((CURATED_MODELS.openai || []).map((m) => m.id)).toEqual(expected);
    expect((CURATED_MODELS['openai-codex'] || []).map((m) => m.id)).toEqual(expected);
  });

  it('natively resolves the GPT-5.6 family and retained 5.5/5.4 generations', () => {
    const expected = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'];
    for (const provider of ['openai', 'openai-codex'] as const) {
      for (const modelId of expected) {
        expect(getBuiltinModel(provider, modelId)).toBeDefined();
      }
    }
  });

  it('openrouter catalog includes DeepSeek / Qwen / GLM / Kimi / MiniMax', () => {
    const ids = (CURATED_MODELS.openrouter || []).map((m) => m.id);
    expect(ids.some((id) => id.startsWith('deepseek/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('qwen/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('z-ai/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('moonshotai/'))).toBe(true);
    expect(ids.some((id) => id.startsWith('minimax/'))).toBe(true);
    expect(ids).toContain('minimax/minimax-m3');
    expect(ids).toContain('minimax/minimax-m2.7');
  });

  it('openrouter Claude shortcuts keep every Claude 5 variant', () => {
    const claudeIds = (CURATED_MODELS.openrouter || [])
      .map((m) => m.id)
      .filter((id) => id.includes('/claude-'));
    expect(claudeIds).toEqual([
      'anthropic/claude-opus-5',
      'anthropic/claude-fable-5.1',
      'anthropic/claude-fable-5',
      'anthropic/claude-sonnet-5',
    ]);
  });

  it('openrouter GPT shortcuts keep every GPT-5.6 variant', () => {
    const ids = (CURATED_MODELS.openrouter || [])
      .map((m) => m.id)
      .filter((id) => id.startsWith('openai/gpt-'));
    expect(ids).toEqual([
      'openai/gpt-6-astra',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-luna',
    ]);
  });

  it('resolves the OpenRouter V4.1 Flash shortcut with vision before the SDK catalogs it', () => {
    const modelId = 'deepseek/deepseek-v4.1-flash';
    const catalog = {
      getPiModel(provider: string, id: string) {
        if (provider === 'openrouter' && id === modelId) return undefined;
        return (getBuiltinModel as (p: string, m: string) => any)(provider, id);
      },
    };
    expect(curatedModelsFor('openrouter')).toContainEqual(expect.objectContaining({
      id: modelId,
      name: 'DeepSeek V4.1 Flash',
    }));
    const resolved = resolveConfiguredPiModel(catalog, 'openrouter', modelId);
    expect(resolved).toMatchObject({
      requestedModelId: modelId,
      isConfiguredFallback: true,
      needsCustomModel: true,
      model: {
        id: modelId,
        name: 'DeepSeek V4.1 Flash',
        provider: 'openrouter',
        api: 'openai-completions',
        baseUrl: 'https://openrouter.ai/api/v1',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_048_576,
        maxTokens: 384_000,
        compat: { thinkingFormat: 'openrouter', requiresReasoningContentOnAssistantMessages: true },
      },
    });
    expect(modelInputImageLimit('openrouter', modelId, resolved?.model)).toBe(20);
  });

  it('curatedModelsFor returns a shallow copy safe to mutate', () => {
    const a = curatedModelsFor('anthropic');
    const b = curatedModelsFor('anthropic');
    expect(a).not.toBe(b);
    a.pop();
    expect(curatedModelsFor('anthropic').length).toBe(b.length);
  });

  it('resolves the OpenRouter V4.1 Flash shortcut with vision before the SDK catalogs it', () => {
    const modelId = 'deepseek/deepseek-v4.1-flash';
    const catalog = {
      getPiModel(provider: string, id: string) {
        if (provider === 'openrouter' && id === modelId) return undefined;
        return (getBuiltinModel as (p: string, m: string) => any)(provider, id);
      },
    };
    expect(curatedModelsFor('openrouter')).toContainEqual(expect.objectContaining({
      id: modelId,
      name: 'DeepSeek V4.1 Flash',
    }));
    const resolved = resolveConfiguredPiModel(catalog, 'openrouter', modelId);
    expect(resolved).toMatchObject({
      requestedModelId: modelId,
      isConfiguredFallback: true,
      needsCustomModel: true,
      model: {
        id: modelId,
        name: 'DeepSeek V4.1 Flash',
        provider: 'openrouter',
        api: 'openai-completions',
        baseUrl: 'https://openrouter.ai/api/v1',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_048_576,
        maxTokens: 384_000,
        compat: { thinkingFormat: 'openrouter', requiresReasoningContentOnAssistantMessages: true },
      },
    });
    expect(modelInputImageLimit('openrouter', modelId, resolved?.model)).toBe(20);
  });

  it('curatedModelsFor returns [] for unknown providers (triggers pi-ai fallback)', () => {
    expect(curatedModelsFor('no-such-provider-id')).toEqual([]);
  });

  it.each([
    { input: ['text'] as const, configured: {}, expected: ['text'] },
    { input: ['text', 'image'] as const, configured: {}, expected: ['text', 'image'] },
    { input: ['text'] as const, configured: { supportsVision: true }, expected: ['text', 'image'] },
    { input: ['text', 'image'] as const, configured: { supportsVision: false }, expected: ['text'] },
    { input: ['text'] as const, configured: { maxInputImages: 12 }, expected: ['text', 'image'] },
    { input: ['text', 'image'] as const, configured: { maxInputImages: 0 }, expected: ['text'] },
    { input: ['text'] as const, configured: { supportsVision: true, maxInputImages: 12 }, expected: ['text', 'image'] },
    { input: ['text', 'image'] as const, configured: { supportsVision: false, maxInputImages: 0 }, expected: ['text'] },
  ])('applies configured vision capabilities: $configured', ({ input, configured, expected }) => {
    expect(modelInputFromConfiguredCapabilities([...input], configured)).toEqual(expected);
  });

  it('uses the product image limit for a multimodal model without a provider limit', () => {
    expect(modelInputImageLimit('unknown-provider', 'vision-next', {
      id: 'vision-next',
      input: ['text', 'image'],
    } as any)).toBe(20);
  });

  it('accepts the capability-field matrix and rejects conflicts or invalid field types', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const storage = await import('../../../src/main/storage');
    const uid = 'configuredcapabilitymatrix';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    const cases: Array<{
      id: string;
      supportsVision?: unknown;
      maxInputImages?: unknown;
      accepted: boolean;
    }> = [
      { id: 'omitted-omitted', accepted: true },
      { id: 'omitted-zero', maxInputImages: 0, accepted: true },
      { id: 'omitted-positive', maxInputImages: 12, accepted: true },
      { id: 'true-omitted', supportsVision: true, accepted: true },
      { id: 'true-zero', supportsVision: true, maxInputImages: 0, accepted: false },
      { id: 'true-positive', supportsVision: true, maxInputImages: 12, accepted: true },
      { id: 'false-omitted', supportsVision: false, accepted: true },
      { id: 'false-zero', supportsVision: false, maxInputImages: 0, accepted: true },
      { id: 'false-positive', supportsVision: false, maxInputImages: 12, accepted: false },
      { id: 'invalid-omitted', supportsVision: 'yes', accepted: false },
      { id: 'invalid-zero', supportsVision: 'yes', maxInputImages: 0, accepted: false },
      { id: 'invalid-positive', supportsVision: 'yes', maxInputImages: 12, accepted: false },
      { id: 'invalid-invalid', supportsVision: 'yes', maxInputImages: '12', accepted: false },
      { id: 'omitted-invalid', maxInputImages: '12', accepted: false },
      { id: 'true-invalid', supportsVision: true, maxInputImages: '12', accepted: false },
      { id: 'false-invalid', supportsVision: false, maxInputImages: '12', accepted: false },
      { id: 'negative-limit', maxInputImages: -1, accepted: false },
      { id: 'fractional-limit', maxInputImages: 1.5, accepted: false },
      { id: 'boolean-limit', maxInputImages: true, accepted: false },
      { id: 'null-limit', maxInputImages: null, accepted: false },
      { id: 'object-limit', maxInputImages: { count: 12 }, accepted: false },
    ];
    const providers = Object.fromEntries(cases.map((entry) => [entry.id, [{
      id: `${entry.id}-model`,
      ...('supportsVision' in entry ? { supportsVision: entry.supportsVision } : {}),
      ...('maxInputImages' in entry ? { maxInputImages: entry.maxInputImages } : {}),
    }]]));
    storage.writeJsonSync(file, {
      version: 1,
      active: { immediate: { model_catalog: { providers } } },
    });
    try {
      for (const entry of cases) {
        const models = curatedModelsFor(entry.id);
        if (entry.accepted) {
          expect(models, entry.id).toHaveLength(1);
        } else {
          expect(models, entry.id).toEqual([]);
        }
      }
      expect(curatedModelsFor('false-zero')).toEqual([{
        id: 'false-zero-model',
        name: 'false-zero-model',
        supportsVision: false,
        maxInputImages: 0,
      }]);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
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
    // 当前外部适配层还包含公开 Orkas API（OpenAI-compatible chat）。
    expect([...EXTERNAL_API_PROVIDERS]).toEqual([
      'orkas-api',
      'moonshot',
      'deepseek',
      'doubao',
      'custom',
    ]);
  });

  it('每个外部 provider 都在 CATALOG + CURATED_MODELS 有对应条目', () => {
    for (const id of EXTERNAL_API_PROVIDERS) {
      const entry = CATALOG.find((p) => p.id === id);
      expect(entry).toBeTruthy();
      if (entry?.customOpenAICompatible) {
        expect(CURATED_MODELS[id]).toBeUndefined();
      } else {
        expect(CURATED_MODELS[id]?.length).toBeGreaterThan(0);
      }
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
