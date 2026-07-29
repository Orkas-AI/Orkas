import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profiles: [] as Array<{
    id: string;
    provider: string;
    model?: string;
    apiKey: string;
    label: string;
    createdAt: number;
  }>,
  callOpenAIImage: vi.fn(),
  callGeminiImage: vi.fn(),
  callDoubaoImage: vi.fn(),
}));

vi.mock('../../../src/main/features/auth', () => ({
  loadImageProfiles: () => mocks.profiles.map((profile) => ({ ...profile })),
  saveImageProfiles: (profiles: typeof mocks.profiles) => {
    mocks.profiles = profiles.map((profile) => ({ ...profile }));
  },
}));

vi.mock('../../../src/main/model/provider_catalog', () => ({
  findImageGenCapability: (provider: string) => ({
    openai: { model: 'gpt-image-2', api: 'openai', supportsEdit: true },
    google: { model: 'gemini-3.1-flash-image-preview', api: 'gemini', supportsEdit: true },
    doubao: { model: 'doubao-seedream-5-0-lite-260128', api: 'doubao', supportsEdit: true },
  })[provider] || null,
}));

vi.mock('../../../src/main/features/image_gen', () => ({
  IMAGE_MODELS_BY_PROVIDER: {
    openai: [{ id: 'gpt-image-2', name: 'GPT Image 2' }],
    google: [{ id: 'gemini-3.1-flash-image-preview', name: 'Nano Banana 2' }],
    doubao: [
      { id: 'doubao-seedream-5-0-lite-260128', name: 'Seedream 5.0 Lite' },
      { id: 'doubao-seedream-5-0-pro-260628', name: 'Seedream 5.0 Pro' },
    ],
  },
  isImageProviderModelAllowed: (provider: string, model: string) => ({
    openai: ['gpt-image-2'],
    google: ['gemini-3.1-flash-image-preview'],
    doubao: ['doubao-seedream-5-0-lite-260128', 'doubao-seedream-5-0-pro-260628'],
  })[provider]?.includes(model) === true,
  callOpenAIImage: mocks.callOpenAIImage,
  callGeminiImage: mocks.callGeminiImage,
  callDoubaoImage: mocks.callDoubaoImage,
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  addImageProfile,
  flattenImageProviderOptions,
  listImageProfiles,
  removeImageProfile,
  reorderImageProfiles,
  testImageProfile,
} from '../../../src/main/features/image_auth';

beforeEach(() => {
  mocks.profiles = [];
  mocks.callOpenAIImage.mockReset().mockResolvedValue({});
  mocks.callGeminiImage.mockReset().mockResolvedValue({});
  mocks.callDoubaoImage.mockReset().mockResolvedValue({});
});

describe('image auth profiles', () => {
  it.each([
    ['openai', 'gpt-image-2', 'callOpenAIImage'],
    ['google', 'gemini-3.1-flash-image-preview', 'callGeminiImage'],
    ['doubao', 'doubao-seedream-5-0-pro-260628', 'callDoubaoImage'],
  ] as const)('dispatches a %s profile probe to its matching adapter', async (provider, model, callName) => {
    const added = addImageProfile({ provider, model, apiKey: `${provider}-secret`, label: provider });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    await expect(testImageProfile(added.id)).resolves.toMatchObject({
      ok: true,
      provider,
      model,
    });
    expect(mocks[callName]).toHaveBeenCalledTimes(1);
  });

  it('returns a stable safe error when a provider includes secrets in its failure body', async () => {
    const added = addImageProfile({
      provider: 'openai',
      model: 'gpt-image-2',
      apiKey: 'sk-local-secret',
      label: 'primary',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    mocks.callOpenAIImage.mockRejectedValueOnce(new Error(
      'OpenAI image API 401: {"apiKey":"sk-returned-secret","email":"owner@example.test"}',
    ));

    const result = await testImageProfile(added.id);

    expect(result).toMatchObject({ ok: false, error: 'image credentials rejected' });
    expect(result.error).not.toContain('sk-returned-secret');
    expect(result.error).not.toContain('owner@example.test');
  });

  it.each([
    [Object.assign(new Error('payment required'), { status: 402 }), 'image credits unavailable'],
    [new Error('provider returned 429'), 'image provider rate limited'],
    [Object.assign(new Error('request aborted'), { name: 'AbortError' }), 'image provider request timed out'],
    [new Error('socket closed unexpectedly'), 'image provider request failed'],
  ])('classifies probe failures without exposing provider internals', async (providerError, expectedError) => {
    const added = addImageProfile({
      provider: 'openai',
      model: 'gpt-image-2',
      apiKey: 'sk-local-secret',
      label: 'primary',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    mocks.callOpenAIImage.mockRejectedValueOnce(providerError);

    await expect(testImageProfile(added.id)).resolves.toMatchObject({
      ok: false,
      error: expectedError,
    });
  });

  it('keeps profile validation, ordering, and labels deterministic', () => {
    expect(addImageProfile({
      provider: 'doubao',
      model: 'retired-model',
      apiKey: 'secret',
    })).toEqual({
      ok: false,
      error: 'unsupported image model "doubao/retired-model"',
    });

    const first = addImageProfile({
      provider: 'openai',
      model: 'gpt-image-2',
      apiKey: 'first',
      label: `  ${'x'.repeat(60)}  `,
    });
    const second = addImageProfile({
      provider: 'google',
      model: 'gemini-3.1-flash-image-preview',
      apiKey: 'second',
      label: 'second',
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    reorderImageProfiles([first.id, second.id]);
    expect(listImageProfiles().map((profile) => profile.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(listImageProfiles()[0]?.label).toHaveLength(40);

    expect(removeImageProfile(second.id)).toEqual({ ok: true });
    expect(listImageProfiles().map((profile) => profile.id)).toEqual([first.id]);
  });

  it('expands multi-model providers and keeps concrete model ids in the picker', () => {
    expect(flattenImageProviderOptions([
      { id: 'openai', label: 'OpenAI' },
      { id: 'doubao', label: 'DouBao' },
    ])).toEqual([
      expect.objectContaining({
        id: 'openai',
        provider: 'openai',
        model: 'gpt-image-2',
      }),
      expect.objectContaining({
        id: 'doubao:doubao-seedream-5-0-lite-260128',
        provider: 'doubao',
        model: 'doubao-seedream-5-0-lite-260128',
      }),
      expect.objectContaining({
        id: 'doubao:doubao-seedream-5-0-pro-260628',
        provider: 'doubao',
        model: 'doubao-seedream-5-0-pro-260628',
      }),
    ]);
  });
});
