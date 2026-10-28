import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ loaded: vi.fn() }));
beforeEach(() => {
  vi.resetModules();
  mock.loaded.mockReset();
  // Reinstall factories so each scenario begins with a cold SDK graph.
  vi.doMock('openai/resources', () => { mock.loaded('openai resources'); return {}; });
  vi.doMock('openai/client', () => { mock.loaded('openai client'); return {}; });
  vi.doMock('@anthropic-ai/sdk/resources', () => { mock.loaded('anthropic resources'); return {}; });
  vi.doMock('@anthropic-ai/sdk/client', () => { mock.loaded('anthropic client'); return {}; });
  vi.doMock('@earendil-works/pi-ai/api/openai-responses', () => { mock.loaded('openai API'); return {}; });
  vi.doMock('@earendil-works/pi-ai/api/anthropic-messages', () => { mock.loaded('anthropic API'); return {}; });
  vi.doMock('@earendil-works/pi-ai/api/openai-codex-responses', () => { mock.loaded('codex API'); return {}; });
});

describe('cooperative SDK preparation', () => {
  it('does not load the OpenAI SDK for the native-fetch Codex transport', async () => {
    const { preloadModelApi } = await import('../../../../src/main/model/core-agent/api-preload');
    expect(await preloadModelApi('openai-codex-responses')).toBe(true);
    expect(mock.loaded.mock.calls.flat()).toEqual(['codex API']);
  });
  it.each([['openai-responses', 'openai'], ['anthropic-messages', 'anthropic']])(
    'prepares %s in separate event-loop turns without loading another SDK', async (api, sdk) => {
      const { preloadModelApi } = await import('../../../../src/main/model/core-agent/api-preload');
      let foregroundTurns = 0;
      mock.loaded.mockImplementation(() => { setTimeout(() => foregroundTurns++, 0); });
      expect(await preloadModelApi(api)).toBe(true);
      expect(mock.loaded.mock.calls.flat()).toEqual([`${sdk} resources`, `${sdk} client`, `${sdk} API`]);
      expect(foregroundTurns).toBeGreaterThanOrEqual(2);
    },
  );
  it.each([0, 1, 2])('does not start another import after foreground activity at batch %s', async (allowedBatches) => {
    const { preloadModelApi } = await import('../../../../src/main/model/core-agent/api-preload');
    expect(await preloadModelApi('openai-responses', () => mock.loaded.mock.calls.length < allowedBatches)).toBe(false);
    expect(mock.loaded).toHaveBeenCalledTimes(allowedBatches);
    expect(mock.loaded.mock.calls.flat()).not.toContain('openai API');
  });
  it.each(['unknown-api', 'google-generative-ai'])('leaves %s on the ordinary demand-loading path', async (api) => {
    const { preloadModelApi } = await import('../../../../src/main/model/core-agent/api-preload');
    expect(await preloadModelApi(api)).toBe(false);
    expect(mock.loaded).not.toHaveBeenCalled();
  });
});
