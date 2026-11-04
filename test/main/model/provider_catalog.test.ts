import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { PUBLIC_PROVIDER_MODELS } from '../../../src/main/model/public_model_catalog';
import {
  CATALOG,
  CURATED_MODELS,
  VISIBLE_PROVIDERS,
  FEATURED_API_PROVIDERS,
  EXTERNAL_API_PROVIDERS,
  OAUTH_ALIAS_FOR,
  EXTRA_LABELS,
  isVisibleProvider,
  isKnownModelProvider,
  isUserAddableProvider,
  providerLabel,
  providerDocsUrl,
  providerSubscriptionNote,
  sortProviderIds,
  curatedModelsFor,
  configuredOpenAICompatibleProviders,
  getConfiguredOpenAICompatibleProvider,
  isExternalApiProvider,
  modelInputFromConfiguredCapabilities,
  modelInputImageLimit,
  resolveConfiguredPiModel,
  isSelectableModel,
  resolveModelUpgrade,
  pickLatestGenerations,
  modelCatalogEntryFromModel,
  findImageGenCapability,
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
        includedModels: ['DeepSeek V4.1 Flash', 'GPT-6 Luna', 'Claude-Sonnet-5', 'Gemini-3.8 Flash'],
      }),
      expect.objectContaining({
        id: 'orkas-llm-1.5-pro',
        name: 'Orkas-1.5 Pro',
        includedModels: ['GPT-6.1 Sol', 'Claude Opus 5.5', 'Kimi K3'],
      }),
    ]);
  });

  it.each([
    ['openai-codex', 'gpt-6.1-terra', 'openai-codex-responses', 500_000, 64_000],
    ['openai', 'gpt-6.1-terra', 'openai-responses', 272_000, 64_000],
    ['openrouter', 'openai/gpt-6.1-terra', 'openai-completions', 1_050_000, 128_000],
  ] as const)('selects native %s Terra with its own identity, pricing and capabilities', (providerId, modelId, api, contextWindow, maxTokens) => {
    const native = (getBuiltinModel as any)(providerId, modelId);
    expect(native).toBeDefined();
    const original = structuredClone(native);
    const catalog = { getPiModel: getBuiltinModel as any };
    expect(curatedModelsFor(providerId).map(model => model.id)).toContain(modelId);
    expect(isSelectableModel(providerId, modelId)).toBe(true);
    expect(resolveModelUpgrade(providerId, modelId)).toMatchObject({
      modelId, upgraded: false,
    });
    const resolved = resolveConfiguredPiModel(catalog, providerId, modelId);
    expect(resolved).toMatchObject({
      isConfiguredFallback: false, needsCustomModel: true, templateModelId: modelId,
      model: { id: modelId, api, provider: providerId,
        contextWindow, maxTokens, input: ['text', 'image'],
        cost: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
        thinkingLevelMap: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
      },
    });
    expect(modelInputImageLimit(providerId, modelId, resolved!.model)).toBe(20);
    expect(resolved!.model.compat).toEqual(native.compat);
    if (providerId === 'openai-codex') {
      expect(resolved!.model.compat).toMatchObject({ supportsOpenAIGrammarTools: true, supportsToolSearch: true, supportsAdditionalTools: true });
    }
    expect(native).toEqual(original);
  });

  it.each(['off', 'low', 'high'] as const)('sends the real Terra id, tools and vision through the existing Codex SDK at %s', async reasoning => {
    const resolved = resolveConfiguredPiModel({ getPiModel: getBuiltinModel as any }, 'openai-codex', 'gpt-6.1-terra');
    expect(resolved).not.toBeNull();
    const { createPiProvider } = await import('#core-agent');
    const token = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url');
    let payload: any;
    const provider = createPiProvider({ provider: 'openai-codex', customModel: resolved!.model,
      apiKey: `fixture.${token}.fixture`,
      onPayload(value) { payload = value; throw new Error('captured-before-transport'); },
    });
    await expect(provider.complete({ model: 'gpt-6.1-terra', reasoning,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the image.' },
        { type: 'image', data: 'AQID', mediaType: 'image/png' }] }],
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: {
        type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
      } }], onRequestFailure() {},
    })).rejects.toThrow('captured-before-transport');
    expect(payload).toMatchObject({ model: 'gpt-6.1-terra', stream: true,
      reasoning: { effort: reasoning === 'off' ? 'none' : reasoning } });
    expect(JSON.stringify(payload.input)).toContain('input_image');
    expect(JSON.stringify(payload.input)).toContain('data:image/png;base64,AQID');
    expect(JSON.stringify(payload.input)).toContain('read_file');
  });

  it.each([
    ['openai', 'gpt-6.1-terra', 'off'], ['openai', 'gpt-6.1-terra', 'low'], ['openai', 'gpt-6.1-terra', 'high'],
    ['openrouter', 'openai/gpt-6.1-terra', 'off'], ['openrouter', 'openai/gpt-6.1-terra', 'low'], ['openrouter', 'openai/gpt-6.1-terra', 'high'],
  ] as const)('preserves %s / %s / %s tool and image requests without transport', async (providerId, modelId, reasoning) => {
    const resolved = resolveConfiguredPiModel({ getPiModel: getBuiltinModel as any }, providerId, modelId);
    expect(resolved).not.toBeNull();
    const { createPiProvider } = await import('#core-agent');
    const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('transport-must-not-run'));
    try {
      for (const method of ['complete', 'stream'] as const) {
        let payload: any;
        const provider = createPiProvider({ provider: providerId, customModel: resolved!.model, apiKey: 'sk-fixture-only',
          onPayload(value) { payload = value; throw new Error('captured-before-transport'); },
        });
        const params = { model: modelId, reasoning, maxTokens: 512,
          messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Inspect the image.' },
            { type: 'image' as const, data: 'AQID', mediaType: 'image/png' }] }],
          tools: [{ name: 'read_file', description: 'Read a file', inputSchema: {
            type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'],
          } }], onRequestFailure() {},
        };
        if (method === 'complete') {
          await expect(provider.complete(params)).rejects.toThrow('captured-before-transport');
        } else {
          const events = [];
          for await (const event of provider.stream(params)) events.push(event);
          expect(events.filter(event => event.type === 'error')).toHaveLength(1);
          expect(events.find(event => event.type === 'error')?.error.message).toContain('captured-before-transport');
          expect(events.some(event => event.type === 'message_end')).toBe(false);
        }
        expect(payload).toMatchObject({ model: modelId, stream: true,
          reasoning: { effort: reasoning === 'off' ? 'none' : providerId === 'openai' ? 'medium' : reasoning } });
        expect(payload.max_output_tokens ?? payload.max_tokens ?? payload.max_completion_tokens).toBe(512);
        if (providerId === 'openai') {
          // API-key Responses pins the prefix effort and sends the selected
          // effort in a later configuration update. A non-sk fixture would
          // exercise the SDK's ChatGPT sign-in branch instead.
          if (reasoning !== 'off') {
            expect(payload.input.findLast((item: any) => item.type === 'configuration_update' && item.reasoning))
              .toMatchObject({ reasoning: { effort: reasoning } });
          }
          expect(payload.input).toContainEqual(expect.objectContaining({ type: 'additional_tools', tools: expect.arrayContaining([
            expect.objectContaining({ type: 'function', name: 'read_file', parameters: expect.objectContaining({ required: ['path'] }) }),
          ]) }));
          expect(JSON.stringify(payload.input)).toContain('input_image');
          expect(JSON.stringify(payload.input)).toContain('data:image/png;base64,AQID');
        } else {
          expect(payload.tools).toContainEqual(expect.objectContaining({ type: 'function', function: expect.objectContaining({ name: 'read_file' }) }));
          expect(payload.messages[0].content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } });
        }
      }
      expect(transport).not.toHaveBeenCalled();
    } finally {
      transport.mockRestore();
    }
  });

  it('uses the confirmed Seedream 5.0 Flash default for direct Doubao images', () => {
    expect(findImageGenCapability('doubao')).toMatchObject({
      model: 'doubao-seedream-5-0-flash-260915',
      api: 'doubao',
      supportsEdit: true,
    });
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

  it('offers two recent Kimi Coding generations with native SDK metadata and retains legacy identity', () => {
    const rows = CURATED_MODELS['kimi-coding'] || [];
    expect(rows.filter(m => !('hiddenFromPicker' in m && m.hiddenFromPicker)).map(m => m.id))
      .toEqual(['k3', 'k3-256k', 'kimi-for-coding']);
    expect(rows.find(m => m.id === 'k2p7')).toMatchObject({ hiddenFromPicker: true });
    for (const row of rows.filter(m => m.id !== 'k2p7')) {
      const resolved = resolveConfiguredPiModel({ getPiModel: getBuiltinModel as any }, 'kimi-coding', row.id);
      expect(resolved).toMatchObject({ templateModelId: row.id, isConfiguredFallback: false,
        model: { id: row.id, api: 'openai-completions', baseUrl: 'https://api.kimi.com/coding/v1', compat: { requiresReasoningContentOnAssistantMessages: true } } });
    }
    expect(isSelectableModel('kimi-coding', 'k2p7')).toBe(true);
    expect(resolveModelUpgrade('kimi-coding', 'k2p7')).toMatchObject({ modelId: 'k2p7', upgraded: false });
  });

  it('resolves kimi-coding K3 as a native pi-ai model', async () => {
    const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
    const catalog = {
      getPiModel(provider: string, modelId: string) {
        return (getBuiltinModel as (p: string, m: string) => any)(provider, modelId);
      },
    };
    const resolved = resolveConfiguredPiModel(catalog, 'kimi-coding', 'k3');
    expect(resolved).toMatchObject({
      requestedModelId: 'k3',
      templateModelId: 'k3',
      isConfiguredFallback: false,
      needsCustomModel: true,
      model: {
        api: 'openai-completions',
        baseUrl: 'https://api.kimi.com/coding/v1',
        reasoning: true,
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        compat: {
          requiresReasoningContentOnAssistantMessages: true,
          supportsReasoningEffort: true,
        },
      },
    });
  });

  it('minimax catalog exposes M3 before the M2.7 generation', () => {
    const directIds = (CURATED_MODELS['minimax-cn'] || []).map((m) => m.id);
    expect(directIds).toEqual([
      'MiniMax-M3.1-Flash',
      'MiniMax-M3',
      'MiniMax-M2.7',
    ]);

    const globalPortalIds = (CURATED_MODELS['minimax-portal'] || []).map((m) => m.id);
    expect(globalPortalIds).toEqual(directIds);

    const portalIds = (CURATED_MODELS['minimax-portal-cn'] || []).map((m) => m.id);
    expect(portalIds).toEqual(directIds);
    for (const provider of ['minimax-cn', 'minimax-portal', 'minimax-portal-cn']) {
      expect(curatedModelsFor(provider).filter(m => !m.hiddenFromPicker).map(m => m.id))
        .toEqual(['MiniMax-M3.1-Flash', 'MiniMax-M3']);
      expect(resolveModelUpgrade(provider, 'MiniMax-M2.7').modelId).toBe('MiniMax-M2.7');
      expect(isSelectableModel(provider, 'MiniMax-M2.7')).toBe(true);
    }
  });

  it.each(['minimax-cn', 'minimax-portal', 'minimax-portal-cn'])('retains Flash fallback controls on older SDK catalogs through %s', async (providerId) => {
    const catalog = { getPiModel: (provider: string, id: string) => id === 'MiniMax-M3.1-Flash'
      ? undefined : (getBuiltinModel as any)(provider, id) };
    const original = structuredClone(catalog.getPiModel(providerId === 'minimax-portal' ? 'minimax' : 'minimax-cn', 'MiniMax-M3'));
    const resolved = resolveConfiguredPiModel(catalog, providerId, 'MiniMax-M3.1-Flash');
    expect(resolved).not.toBeNull();
    expect(resolved!.model).toMatchObject({ id: 'MiniMax-M3.1-Flash', api: 'anthropic-messages',
      baseUrl: providerId === 'minimax-portal' ? 'https://api.minimax.io/anthropic' : 'https://api.minimaxi.com/anthropic',
      contextWindow: 1_000_000, maxTokens: 131072, reasoning: true, input: ['text', 'image'],
      cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
    });
    expect(resolved!.model.cost).not.toHaveProperty('tiers');
    const { createPiProvider } = await import('#core-agent');
    for (const reasoning of [undefined, 'off', 'low', 'high'] as const) {
      let payload: any;
      const provider = createPiProvider({ provider: providerId, apiKey: 'fixture-only', customModel: resolved!.model,
        onPayload(value) { payload = value; throw new Error('captured-before-transport'); } });
      await expect(provider.complete({ model: 'MiniMax-M3.1-Flash', reasoning, temperature: 0.25,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Answer' }] }], onRequestFailure() {},
      })).rejects.toThrow('captured-before-transport');
      expect(payload.model).toBe('MiniMax-M3.1-Flash');
      expect(payload.thinking?.type).not.toBe('disabled');
      expect(payload).not.toHaveProperty('temperature');
      expect(payload).not.toHaveProperty('service_tier');
      if (reasoning && reasoning !== 'off') {
        expect(payload.thinking).toMatchObject({ type: 'adaptive' });
        expect(payload.thinking).not.toHaveProperty('budget_tokens');
        expect(payload.output_config.effort).toBe(reasoning);
      }
    }
    expect(catalog.getPiModel(providerId === 'minimax-portal' ? 'minimax' : 'minimax-cn', 'MiniMax-M3')).toEqual(original);
  });

  it.each(['minimax-cn', 'minimax-portal', 'minimax-portal-cn'])('keeps Flash request controls when %s gains native SDK metadata', async (providerId) => {
    const sdkProvider = providerId === 'minimax-portal' ? 'minimax' : 'minimax-cn';
    const native = (getBuiltinModel as any)(sdkProvider, 'MiniMax-M3.1-Flash');
    expect(native).toBeDefined();
    const original = structuredClone(native);
    const resolved = resolveConfiguredPiModel({ getPiModel: (provider, id) =>
      provider === sdkProvider && id === native.id ? native : undefined }, providerId, native.id)!;
    expect(resolved).toMatchObject({ isConfiguredFallback: false, needsCustomModel: true,
      model: { contextWindow: 1_000_000, maxTokens: 131072, cost: native.cost } });
    const { createPiProvider } = await import('#core-agent');
    for (const reasoning of ['off', 'minimal', 'low', 'high'] as const) {
      let payload: any;
      const provider = createPiProvider({ provider: providerId, apiKey: 'fixture-only', customModel: resolved.model,
        onPayload(value) { payload = value; throw new Error('captured-before-transport'); } });
      await expect(provider.complete({ model: native.id, reasoning, temperature: 0.25,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Answer' }] }], onRequestFailure() {},
      })).rejects.toThrow('captured-before-transport');
      expect(payload).not.toHaveProperty('temperature');
      expect(payload.thinking?.type).not.toBe('disabled');
      if (reasoning !== 'off') expect(payload.output_config.effort).toBe(reasoning === 'minimal' ? 'low' : reasoning);
    }
    expect(native).toEqual(original);
  });

  // A reservation is subtracted from the window before the input budget is worked
  // out, so an SDK ceiling near the window leaves a long conversation almost no
  // input: minimax-m3's 512K of 524K capped input at 10,076 tokens, below the
  // overhead of an ordinary first request. Reservations come from the table's own
  // rows: 131072 for wide windows (MiMo, Kimi K3, M3.1 Flash, direct GLM-5.2),
  // 32768 for 256K ones (Doubao Turbo, direct Kimi K2.7 Code).
  describe('output reservation against the context window', () => {
    // Known rows above the limit but well short of the window, left to a separate
    // decision. Each must still exceed it, so the list cannot go stale.
    const ABOVE_HALF_WINDOW = new Set([
      'minimax-cn/MiniMax-M3', 'minimax-portal/MiniMax-M3', 'minimax-portal-cn/MiniMax-M3',
      'minimax-cn/MiniMax-M2.7', 'minimax-portal/MiniMax-M2.7', 'minimax-portal-cn/MiniMax-M2.7',
      'openrouter/minimax/minimax-m2.7', 'openrouter/z-ai/glm-5.1',
    ]);
    const catalog = { getPiModel: (provider: string, id: string) => (getBuiltinModel as any)(provider, id) };
    const rows = Object.entries(PUBLIC_PROVIDER_MODELS).flatMap(([provider, models]) => models.map((entry) => {
      const resolved = resolveConfiguredPiModel(catalog, provider, entry.id)?.model;
      return { row: `${provider}/${entry.id}`, window: resolved?.contextWindow ?? entry.contextWindow, output: resolved?.maxTokens ?? entry.maxTokens };
    })).filter((row): row is { row: string; window: number; output: number } => !!row.window && !!row.output);

    it('leaves at least half of every catalog window for input', () => {
      // Guard against the check going vacuous if resolution stops finding rows.
      expect(rows.length).toBeGreaterThan(50);
      const overHalf = rows.filter(({ window, output }) => output / window > 0.5).map(({ row }) => row);
      expect(overHalf.filter((row) => !ABOVE_HALF_WINDOW.has(row))).toEqual([]);
    });

    it('keeps the exception list limited to rows that still need it', () => {
      const overHalf = new Set(rows.filter(({ window, output }) => output / window > 0.5).map(({ row }) => row));
      expect([...ABOVE_HALF_WINDOW].filter((row) => !overHalf.has(row))).toEqual([]);
    });
  });

  it.each([
    ['google/gemini-4-argon', 65536],
    ['xiaomi/mimo-v2.5', 65536],
    ['xiaomi/mimo-v2.5-pro', 131072],
    ['minimax/minimax-m3', 131072],
    ['z-ai/glm-5.2', 131072],
    ['x-ai/grok-4.5', 131072],
    ['x-ai/grok-4.20', 131072],
    ['moonshotai/kimi-k2.7-code', 32768],
    ['qwen/qwen3-coder-next', 32768],
  ] as const)('preserves input capacity for %s when the SDK raises its output ceiling', (id, reservation) => {
    const native = { ...(getBuiltinModel as any)('openrouter', id), contextWindow: 1_050_000, maxTokens: 945_000 };
    const resolved = resolveConfiguredPiModel({ getPiModel: () => native }, 'openrouter', id)!;
    expect(resolved.model.contextWindow).toBe(1_050_000);
    expect(resolved.model.maxTokens).toBe(reservation);
    expect(resolved.needsCustomModel).toBe(true);
    expect(modelCatalogEntryFromModel(resolved.model)).toEqual({ contextWindow: 1_050_000, maxOutputTokens: reservation });
    expect(native.maxTokens).toBe(945_000);
  });

  it('exposes GLM 5.3 and 5.2 as native runnable Z.AI models', () => {
    const ids = (CURATED_MODELS.zai || []).map((m) => m.id);
    expect(ids).toEqual([
      'glm-5.3',
      'glm-5.2',
    ]);

    const catalog = {
      getPiModel(provider: string, modelId: string) {
        return (getBuiltinModel as (p: string, m: string) => any)(provider, modelId);
      },
    };
    for (const modelId of ids) {
      expect(resolveConfiguredPiModel(catalog, 'zai', modelId), modelId).toMatchObject({
        requestedModelId: modelId,
        templateModelId: modelId,
        isConfiguredFallback: false,
        needsCustomModel: false,
        model: {
          id: modelId,
          provider: 'zai',
          api: 'openai-completions',
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          reasoning: true,
          input: ['text'],
        },
      });
    }
  });

  it.each([
    ['anthropic', 'claude-haiku-5-5'],
    ['openrouter', 'anthropic/claude-haiku-5.5'],
  ])('offers %s Haiku 5.5 with native adaptive thinking and accurate capacity', (provider, modelId) => {
    expect(isSelectableModel(provider, modelId)).toBe(true);
    const resolved = resolveConfiguredPiModel({ getPiModel: getBuiltinModel as any }, provider, modelId);
    expect(resolved).toMatchObject({
      isConfiguredFallback: false,
      templateModelId: modelId,
      model: {
        id: modelId,
        api: 'anthropic-messages',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        compat: { forceAdaptiveThinking: true, supportsTemperature: false },
        thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
        cost: { input: 0.1, output: 0.5, tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5 }] },
      },
    });
    expect(modelInputImageLimit(provider, modelId, resolved?.model)).toBe(20);
    expect(resolveModelUpgrade(provider, modelId).upgraded).toBe(false);
  });

  it('natively resolves every curated Claude and Gemini model', () => {
    for (const provider of ['anthropic', 'google']) {
      const modelIds = CURATED_MODELS[provider].map((model) => model.id);
      expect(modelIds.length).toBeGreaterThan(0);
      for (const modelId of modelIds) {
        const resolved = resolveConfiguredPiModel({ getPiModel: getBuiltinModel as any }, provider, modelId);
        expect(resolved).toMatchObject({
          requestedModelId: modelId,
          templateModelId: modelId,
          isConfiguredFallback: false,
          model: {
            id: modelId,
            provider,
            api: provider === 'anthropic' ? 'anthropic-messages' : 'google-generative-ai',
            input: ['text', 'image'],
          },
        });
      }
    }
  });

  it('natively resolves GPT-6 tiers and every retained GPT-5.6 tier', () => {
    const expected = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
    expect((CURATED_MODELS.openai || []).map((m) => m.id)).toEqual([
      ...expected,
    ]);
    expect((CURATED_MODELS['openai-codex'] || []).map((m) => m.id)).toEqual([
      ...expected,
    ]);

    for (const provider of ['openai', 'openai-codex'] as const) {
      for (const modelId of expected) {
        expect(getBuiltinModel(provider, modelId)).toBeDefined();
      }
    }

    expect(getBuiltinModel('openai', 'gpt-6-astra')).toMatchObject({
      id: 'gpt-6-astra',
      provider: 'openai',
      api: 'openai-responses',
      reasoning: true,
      input: ['text', 'image'],
      maxTokens: 128_000,
      thinkingLevelMap: { off: null, minimal: null, low: 'low', max: 'max' },
      compat: { supportsExplicitPromptCacheMode: true },
    });
    expect(getBuiltinModel('openai-codex', 'gpt-6-astra')).toMatchObject({
      id: 'gpt-6-astra',
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      reasoning: true,
      input: ['text', 'image'],
      maxTokens: 128_000,
    });
    for (const id of ['gpt-6-sol', 'gpt-6-luna']) {
      expect(getBuiltinModel('openai', id)).toMatchObject({
        id, api: 'openai-responses', contextWindow: 272_000, maxTokens: 128_000,
      });
      expect(getBuiltinModel('openai-codex', id)).toMatchObject({
        id, api: 'openai-codex-responses', contextWindow: 272_000, maxTokens: 128_000,
      });
    }
  });

  it('inherits each GPT provider window from pi-ai while retaining output reservations', () => {
    const catalog = { getPiModel: getBuiltinModel as any };
    const ids = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
    for (const provider of ['openai', 'openai-codex', 'openrouter']) {
      for (const id of ids) {
        const modelId = provider === 'openrouter' ? `openai/${id}` : id;
        const sdk = (getBuiltinModel as any)(provider, modelId);
        const resolved = resolveConfiguredPiModel(catalog, provider, modelId);
        expect(resolved?.model.contextWindow, `${provider}/${id}`).toBe(sdk.contextWindow);
        expect(resolved?.model.maxTokens).toBe(
          provider === 'openrouter' ? sdk.maxTokens : id === 'gpt-6-astra' ? 128_000 : 64_000,
        );
        expect(resolved?.needsCustomModel).toBe(true);
      }
    }
  });

  it('inherits the SDK template window when a GPT id is newer than the SDK', () => {
    for (const provider of ['openai', 'openai-codex', 'openrouter']) {
      const id = provider === 'openrouter' ? 'openai/gpt-5.6-sol' : 'gpt-5.6-sol';
      const templateId = provider === 'openrouter' ? 'openai/gpt-5.5' : 'gpt-5.5';
      // Model an older catalog independently of which retired templates the
      // current SDK still ships (Codex removed GPT-5.5 in pi-ai 1.4).
      const sourceId = provider === 'openrouter' ? 'openai/gpt-5.6-sol' : 'gpt-5.6-sol';
      const template = { ...(getBuiltinModel as any)(provider, sourceId), id: templateId, contextWindow: 456_789 };
      const catalog = { getPiModel: (_provider: string, modelId: string) => modelId === templateId ? template : undefined };
      expect(resolveConfiguredPiModel(catalog, provider, id)).toMatchObject({
        templateModelId: templateId,
        isConfiguredFallback: true,
        model: { id, contextWindow: 456_789 },
      });
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
      'anthropic/claude-opus-5.5',
      'anthropic/claude-opus-5',
      'anthropic/claude-fable-5.1',
      'anthropic/claude-fable-5',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-haiku-5.5',
    ]);
  });

  it('openrouter GPT shortcuts keep every GPT-5.6 variant', () => {
    const ids = (CURATED_MODELS.openrouter || [])
      .map((m) => m.id)
      .filter((id) => id.startsWith('openai/gpt-'));
    const nativeIds = [
      'openai/gpt-6-astra',
      'openai/gpt-6.1-sol',
      'openai/gpt-6-sol',
      'openai/gpt-6-luna',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-luna',
    ];
    expect(ids).toEqual([...nativeIds.slice(0, 2), 'openai/gpt-6.1-terra', ...nativeIds.slice(2)]);

    for (const modelId of nativeIds) {
      expect(getBuiltinModel('openrouter', modelId)).toBeDefined();
    }
    expect(getBuiltinModel('openrouter', 'openai/gpt-6-astra')).toMatchObject({
      id: 'openai/gpt-6-astra',
      provider: 'openrouter',
      api: 'openai-completions',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
  });

  it('maps retired ids while preserving listed generation variants', () => {
    expect(resolveModelUpgrade('kimi-coding', 'k2p6')).toMatchObject({
      modelId: 'k2p7',
      previousModelId: 'k2p6',
      upgraded: true,
    });
    expect(resolveModelUpgrade('moonshot', 'kimi-k2.5').modelId).toBe('kimi-k2.7-code');
    expect(resolveModelUpgrade('google', 'gemini-3-pro-preview').modelId).toBe('gemini-3.8-flash');
    expect(resolveModelUpgrade('google', 'gemini-3.1-pro-preview').modelId).toBe('gemini-3.1-pro-preview');
    expect(resolveModelUpgrade('google', 'gemini-3.5-flash').modelId).toBe('gemini-3.8-flash');
    expect(resolveModelUpgrade('google', 'gemini-3.6-flash').modelId).toBe('gemini-3.8-flash');
    expect(resolveModelUpgrade('google', 'gemini-3.7-flash').upgraded).toBe(false);
    expect(resolveModelUpgrade('google', 'gemini-3.1-flash-lite').modelId).toBe('gemini-3.5-flash-lite');
    expect(resolveModelUpgrade('doubao', 'doubao-seed-2-0-lite-260215').modelId).toBe('doubao-seed-2-0-lite-260428');
    expect(resolveModelUpgrade('zai', 'glm-5.1')).toMatchObject({
      modelId: 'glm-5.2',
      previousModelId: 'glm-5.1',
      upgraded: true,
    });
    expect(resolveModelUpgrade('openrouter', 'qwen/qwen3-max').modelId).toBe('qwen/qwen3.8-max-0902');
    expect(resolveModelUpgrade('openrouter', 'qwen/qwen3-coder').modelId).toBe('qwen/qwen3.8-max-0902');
    expect(resolveModelUpgrade('openrouter', 'qwen/qwen3.7-max').modelId).toBe('qwen/qwen3.8-max-0902');
    expect(resolveModelUpgrade('openrouter', 'qwen/qwen3.7-flash').modelId).toBe('qwen/qwen3.8-flash');
    expect(resolveModelUpgrade('openrouter', 'moonshotai/kimi-k2.6').modelId).toBe('moonshotai/kimi-k3');
    expect(resolveModelUpgrade('openrouter', 'anthropic/claude-opus-4.8').modelId).toBe('anthropic/claude-opus-5');
    expect(resolveModelUpgrade('openrouter', 'anthropic/claude-sonnet-5').modelId).toBe('anthropic/claude-sonnet-5');
    expect(resolveModelUpgrade('openrouter', 'anthropic/claude-fable-5').upgraded).toBe(false);
    expect(resolveModelUpgrade('openrouter', 'google/gemini-3.6-flash').modelId).toBe('google/gemini-3.8-flash');
    expect(resolveModelUpgrade('openrouter', 'google/gemini-3.7-flash').upgraded).toBe(false);
    expect(resolveModelUpgrade('openrouter', 'openai/gpt-5.5').modelId).toBe('openai/gpt-5.6-sol');
    expect(resolveModelUpgrade('openrouter', 'openai/gpt-5.4').modelId).toBe('openai/gpt-5.6-sol');
    expect(resolveModelUpgrade('openrouter', 'openai/gpt-6-astra').upgraded).toBe(false);
    expect(resolveModelUpgrade('openrouter', 'openai/gpt-5.6-luna').modelId).toBe('openai/gpt-5.6-luna');
    expect(resolveModelUpgrade('openrouter', 'google/gemini-3.1-pro-preview').modelId).toBe('google/gemini-3.1-pro-preview');
    expect(resolveModelUpgrade('openrouter', 'deepseek/deepseek-v4-flash').modelId).toBe('deepseek/deepseek-v4-flash-0731');
    expect(resolveModelUpgrade('openrouter', 'qwen/qwen3-coder-next').modelId).toBe('qwen/qwen3-coder-next');
    expect(resolveModelUpgrade('anthropic', 'claude-opus-4-7')).toMatchObject({
      modelId: 'claude-opus-5',
      upgraded: true,
    });
    expect(resolveModelUpgrade('anthropic', 'claude-sonnet-5').modelId).toBe('claude-sonnet-5');
    expect(resolveModelUpgrade('anthropic', 'claude-fable-5').upgraded).toBe(false);
    expect(resolveModelUpgrade('openai', 'gpt-5.5').modelId).toBe('gpt-5.6-sol');
    expect(resolveModelUpgrade('openai', 'gpt-5.4').modelId).toBe('gpt-5.6-sol');
    expect(resolveModelUpgrade('openai-codex', 'gpt-5.5').modelId).toBe('gpt-5.6-sol');
    expect(resolveModelUpgrade('openai-codex', 'gpt-5.4').modelId).toBe('gpt-5.6-sol');
    expect(resolveModelUpgrade('openai', 'gpt-6-astra').upgraded).toBe(false);
    expect(resolveModelUpgrade('openai-codex', 'gpt-6-astra').upgraded).toBe(false);
    expect(resolveModelUpgrade('openai-codex', 'gpt-5.6-luna').modelId).toBe('gpt-5.6-luna');
  });

  it('keeps strict provider whitelists while accepting validated OpenRouter ids', () => {
    expect(isSelectableModel('openai', 'gpt-5.5')).toBe(true);
    expect(isSelectableModel('openai', 'gpt-not-listed')).toBe(false);
    expect(isSelectableModel('huggingface', 'some-runtime-model')).toBe(false);
    expect(isSelectableModel('custom', 'acme/reasoner-v2')).toBe(true);
    expect(isSelectableModel('custom', 'bad\u0000model')).toBe(false);
    expect(isSelectableModel('openrouter', 'x-ai/grok-4.5')).toBe(true);
    expect(isSelectableModel('openrouter', 'future-lab/frontier-1:free')).toBe(true);
    expect(isSelectableModel('openrouter', '~openai/gpt-latest')).toBe(true);
    expect(isSelectableModel('openrouter', 'bad model')).toBe(false);
    expect(isSelectableModel('openrouter', 'bad\u0000model')).toBe(false);
    // Explicit retired-id aliases remain valid because they resolve to a
    // current catalog entry before the whitelist check.
    expect(isSelectableModel('kimi-coding', 'k2p6')).toBe(true);
  });

  it('enforces the OpenRouter custom model ID length and whitespace boundaries', () => {
    const maxLengthId = `vendor/${'m'.repeat(193)}`;
    expect(maxLengthId).toHaveLength(200);
    expect(isSelectableModel('openrouter', maxLengthId)).toBe(true);
    expect(isSelectableModel('openrouter', `${maxLengthId}x`)).toBe(false);
    expect(isSelectableModel('openrouter', 'vendor/model\tlatest')).toBe(false);
    expect(isSelectableModel('openrouter', 'vendor/model\nlatest')).toBe(false);
    expect(isSelectableModel('openrouter', '  vendor/model:free  ')).toBe(true);
  });

  it('resolves new user-entered OpenRouter ids through the relay protocol', () => {
    const catalog = {
      getPiModel(provider: string, modelId: string) {
        return (getBuiltinModel as (p: string, m: string) => any)(provider, modelId);
      },
    };
    const resolved = resolveConfiguredPiModel(catalog, 'openrouter', 'future-lab/frontier-1');
    expect(resolved).toMatchObject({
      requestedModelId: 'future-lab/frontier-1',
      templateModelId: 'openrouter/auto',
      isConfiguredFallback: true,
      needsCustomModel: true,
      model: {
        id: 'future-lab/frontier-1',
        api: 'openai-completions',
        baseUrl: 'https://openrouter.ai/api/v1',
        input: ['text'],
      },
    });
  });

  it('uses declared metadata when the bundled SDK catalog lacks an advertised shortcut', () => {
    const catalog = {
      getPiModel(provider: string, modelId: string) {
        if (provider === 'openrouter' && modelId === 'deepseek/deepseek-v4-flash-0731') {
          return undefined;
        }
        return (getBuiltinModel as (p: string, m: string) => any)(provider, modelId);
      },
    };
    const resolved = resolveConfiguredPiModel(catalog, 'openrouter', 'deepseek/deepseek-v4-flash-0731');
    expect(resolved).toMatchObject({
      templateModelId: 'deepseek/deepseek-v4-flash',
      isConfiguredFallback: true,
      needsCustomModel: true,
      model: {
        id: 'deepseek/deepseek-v4-flash-0731',
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
    });
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
        contextWindow: 1_000_000,
        maxTokens: 128_000,
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

describe('configured provider trust boundary',()=>{it('accepts safe Server-configured providers and rejects unsafe or reserved definitions', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const storage = await import('../../../src/main/storage');
    const uid = 'configuredopenaiproviders';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    storage.writeJsonSync(file, {
      version: 1,
      active: {
        immediate: {
          model_catalog: {
            providers: {
              acme: [
                { id: 'acme-vision', name: 'Acme Vision', supportsVision: true, maxInputImages: 12 },
                { id: 'acme-default', name: 'Acme Default' },
                { id: 'acme-text', name: 'Acme Text', supportsVision: false },
              ],
              unsafe: [{ id: 'unsafe-model', name: 'Unsafe Model' }],
              conflict: [{ id: 'conflict-model', supportsVision: false, maxInputImages: 3 }],
            },
            openai_compatible_providers: {
              acme: {
                label: 'Acme AI',
                baseUrl: 'https://api.acme.example/v1/',
                docsUrl: 'https://docs.acme.example/keys',
              },
              unsafe: { label: 'Unsafe', baseUrl: 'http://127.0.0.1:9000/v1' },
              conflict: { label: 'Conflict', baseUrl: 'https://api.conflict.example/v1' },
              openai: { label: 'Imposter', baseUrl: 'https://evil.example/v1' },
            },
          },
        },
      },
    });
    try {
      expect(configuredOpenAICompatibleProviders()).toEqual([{
        id: 'acme',
        label: 'Acme AI',
        baseUrl: 'https://api.acme.example/v1',
        docsUrl: 'https://docs.acme.example/keys',
      }]);
      expect(getConfiguredOpenAICompatibleProvider('acme')).toMatchObject({ label: 'Acme AI' });
      expect(getConfiguredOpenAICompatibleProvider('unsafe')).toBeNull();
      expect(getConfiguredOpenAICompatibleProvider('conflict')).toBeNull();
      expect(getConfiguredOpenAICompatibleProvider('openai')).toBeNull();
      expect(isVisibleProvider('acme')).toBe(true);
      expect(isKnownModelProvider('acme')).toBe(true);
      expect(isUserAddableProvider('acme')).toBe(true);
      expect(isExternalApiProvider('acme')).toBe(true);
      expect(providerLabel('acme')).toBe('Acme AI');
      expect(providerDocsUrl('acme')).toBe('https://docs.acme.example/keys');
      expect(isSelectableModel('acme', 'acme-vision')).toBe(true);
      expect(isSelectableModel('acme', 'not-configured')).toBe(false);
      expect(curatedModelsFor('acme')).toEqual([
        { id: 'acme-vision', name: 'Acme Vision', supportsVision: true, maxInputImages: 12 },
        { id: 'acme-default', name: 'Acme Default' },
        { id: 'acme-text', name: 'Acme Text', supportsVision: false },
      ]);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });});

describe('current public model upgrade aliases', () => {
  it.each([
    ['openai', 'gpt-5.4', 'gpt-5.6-sol'],
    ['openai-codex', 'gpt-5.4', 'gpt-5.6-sol'],
    ['google', 'gemini-3.6-flash', 'gemini-3.8-flash'],
    ['doubao', 'doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-pro-260915'],
    ['openrouter', 'qwen/qwen3.7-max', 'qwen/qwen3.8-max-0902'],
  ])('upgrades %s %s only into an available public catalog row', (provider, oldId, expected) => {
    expect(resolveModelUpgrade(provider, oldId)).toMatchObject({ modelId: expected, upgraded: true });
  });
});

describe('configured provider capability declaration',()=>{
it('accepts the complete capability-field matrix and rejects conflicts or invalid field types', async () => {
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
    const models = Object.fromEntries(cases.map((entry) => [entry.id, [{
      id: `${entry.id}-model`,
      ...(entry.supportsVision !== undefined ? { supportsVision: entry.supportsVision } : {}),
      ...('maxInputImages' in entry ? { maxInputImages: entry.maxInputImages } : {}),
    }]]));
    const definitions = Object.fromEntries(cases.map((entry) => [entry.id, {
      label: entry.id,
      baseUrl: `https://api.${entry.id}.example/v1`,
    }]));
    storage.writeJsonSync(file, {
      version: 1,
      active: {
        immediate: {
          model_catalog: {
            providers: models,
            openai_compatible_providers: definitions,
          },
        },
      },
    });
    try {
      expect(configuredOpenAICompatibleProviders().map((provider) => provider.id)).toEqual(
        cases.filter((entry) => entry.accepted).map((entry) => entry.id),
      );
      for (const entry of cases) {
        const provider = getConfiguredOpenAICompatibleProvider(entry.id);
        if (entry.accepted) {
          expect(provider, entry.id).not.toBeNull();
        } else {
          expect(provider, entry.id).toBeNull();
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
});
