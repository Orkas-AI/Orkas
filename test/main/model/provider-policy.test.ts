import { beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ deepseek: true }));
vi.mock('../../../src/main/features/client_config', () => ({
  isDeepSeekModelConfigEnabled: () => flags.deepseek,
}));

import {
  assertModelProviderAllowed,
  isDeepSeekModelId,
  isDeepSeekProviderId,
  isModelProviderAllowed,
} from '../../../src/main/model/provider_policy';

describe('provider policy', () => {
  beforeEach(() => { flags.deepseek = true; });

  it('normalizes provider ids and recognizes model families', () => {
    expect(isDeepSeekProviderId(' DeepSeek ')).toBe(true);
    expect(isDeepSeekProviderId('deepseek-other')).toBe(false);
    expect(isDeepSeekModelId('vendor/deepseek-r1')).toBe(true);
    expect(isDeepSeekModelId('gpt')).toBe(false);
  });

  it('blocks disabled provider aliases without blocking unrelated providers', () => {
    flags.deepseek = false;
    expect(isModelProviderAllowed('openai', 'deepseek-r1')).toBe(false);
    expect(() => assertModelProviderAllowed(' DeepSeek ')).toThrow('DeepSeek is disabled');
    expect(isModelProviderAllowed('openai', 'gpt')).toBe(true);
    flags.deepseek = true;
    expect(isModelProviderAllowed('openai', 'deepseek-r1')).toBe(true);
    expect(() => assertModelProviderAllowed('deepseek')).not.toThrow();
  });
});
