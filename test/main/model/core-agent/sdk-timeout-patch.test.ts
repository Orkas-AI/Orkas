import { describe, expect, it } from 'vitest';

import { installSdkTimeoutPatch, sdkClientOptionsForOrkas } from '../../../../src/main/model/core-agent/sdk-timeout-patch';

describe('sdk request defaults', () => {
  it('keeps long provider calls but gives retry ownership to Orkas', () => {
    expect(sdkClientOptionsForOrkas({ apiKey: 'test-key' })).toEqual({
      apiKey: 'test-key',
      timeout: 3_600_000,
      maxRetries: 0,
    });
  });

  it('preserves an explicit caller override', () => {
    expect(sdkClientOptionsForOrkas({
      timeout: 90_000,
      maxRetries: 1,
    })).toMatchObject({
      timeout: 90_000,
      maxRetries: 1,
    });
  });

  it('applies Orkas timeout and retry ownership to the installed SDK constructors', () => {
    const modules = ['@anthropic-ai/sdk', 'openai'].map((name) => require(name));
    const descriptors = modules.map((mod) => Object.getOwnPropertyDescriptors(mod));
    try {
      installSdkTimeoutPatch();
      for (const mod of modules) {
        const client = new mod.default({ apiKey: 'test-key' });
        expect(client.timeout).toBe(3_600_000);
        expect(client.maxRetries).toBe(0);
      }
    } finally {
      modules.forEach((mod, index) => Object.defineProperties(mod, descriptors[index]));
    }
  });
});
