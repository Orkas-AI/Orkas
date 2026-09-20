import { describe, expect, it } from 'vitest';
import { customModelImageSupport } from '../../../../src/main/model/core-agent/custom-model-image-support';
import { createRotatingProvider } from '../../../../src/main/model/core-agent/rotating-provider';
import type { CompletionParams, LLMProvider, Message } from '#core-agent';

const config = { baseUrl: 'https://example.invalid', supportsVision: true };
let sequence = 0;
const scope = () => ({ userId: `user-${sequence++}`, profileId: 'profile', modelId: 'model', apiKey: 'fixture-key', config });

describe('custom model image capability observations', () => {
  it.each([
    'This model does not support image inputs.',
    "Model 'text-alias' doesn't support images.",
    'Invalid content type. image_url is only supported by certain models.',
    'Images are not supported by this model.',
  ])('accepts an explicit HTTP capability rejection: %s', message => {
    const identity = scope();
    const state = customModelImageSupport(identity);
    state.observeRejection(new Error('wrapper', { cause: Object.assign(new Error(message), { status: 400 }) }));
    expect(customModelImageSupport(identity).unsupported).toBe(true);
  });

  it.each([
    [400, 'Invalid image_url: URL has expired'],
    [400, 'Unsupported image format'],
    [400, 'This model does not support images larger than 5 MB'],
    [400, 'This model does not support image inputs with this encoding'],
    [400, 'Unsupported parameter: image_url'],
    [400, 'Model does not support image/png encoding'],
    [400, 'Request rejected by safety policy. This model does not support images.'],
    [429, 'This model does not support images.'],
    [503, 'This model does not support images.'],
    [undefined, 'This model does not support images.'],
  ])('preserves vision for non-capability errors (%s, %s)', (status, message) => {
    const state = customModelImageSupport(scope());
    state.observeRejection(Object.assign(new Error(message), { status }));
    expect(state.unsupported).toBe(false);
  });

  it('isolates users, profiles, endpoints, models, credentials and configuration changes', () => {
    const identity = scope();
    customModelImageSupport(identity).observeRejection(Object.assign(new Error('This model does not support images.'), { status: 422 }));
    for (const delta of [
      { userId: 'another-user' }, { profileId: 'another-profile' }, { modelId: 'another-model' },
      { apiKey: 'another-key' }, { config: { ...config, baseUrl: 'https://another.invalid' } },
      { config: { ...config, supportsVision: false } },
    ]) expect(customModelImageSupport({ ...identity, ...delta }).unsupported).toBe(false);
    expect(customModelImageSupport(identity).unsupported).toBe(true);
  });

  it('bounds retained observations', () => {
    const identity = scope();
    customModelImageSupport(identity).observeRejection(Object.assign(new Error('This model does not support images.'), { status: 400 }));
    for (let i = 0; i < 256; i++) customModelImageSupport(scope());
    expect(customModelImageSupport(identity).unsupported).toBe(false);
  });

  it('projects historical direct and tool images for subsequent text calls without changing original history', async () => {
    const identity = scope();
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'earlier' }, { type: 'image', data: 'old-image', mediaType: 'image/png' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'read_files', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'read-1', content: 'receipt', images: [{ data: 'tool-image', mediaType: 'image/png' }] }] },
      { role: 'user', content: [{ type: 'text', text: 'current text-only message' }] },
    ];
    const original = structuredClone(history);
    const requests: CompletionParams[] = [];
    const provider: LLMProvider = { id: 'custom', name: 'Custom',
      async complete(params) {
        requests.push(params);
        if (requests.length === 1) throw Object.assign(new Error('This model does not support images.'), { status: 400 });
        return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'model' };
      },
      async *stream() { throw new Error('stream not used'); },
      async validateAuth() { return true; },
    };
    const create = () => createRotatingProvider({ providerId: 'custom', candidates: [{
      profileId: identity.profileId, providerId: 'custom', modelId: 'model',
      imageSupport: customModelImageSupport(identity), build: async () => provider,
    }] });
    await expect(create().complete({ messages: history })).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(1);
    expect((await create().complete({ messages: history })).content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).not.toMatch(/old-image|tool-image/);
    expect(JSON.stringify(requests[1].messages)).toContain('receipt');
    expect(JSON.stringify(requests[1].messages)).toContain('current text-only message');
    expect(history).toEqual(original);
  });
});
