import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: mocks.debug,
    info: mocks.info,
    warn: mocks.warn,
    error: mocks.error,
  }),
}));

import { installFetchDiag } from '../../../../src/main/model/core-agent/fetch-diag';

let originalFetch: typeof globalThis.fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  mocks.debug.mockReset();
  mocks.info.mockReset();
  mocks.warn.mockReset();
  mocks.error.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('provider fetch diagnostics', () => {
  it('installs only once and leaves non-provider fetch behavior untouched', async () => {
    const response = new Response('ok', { status: 200 });
    const fetchStub = vi.fn(async () => response);
    globalThis.fetch = fetchStub;

    installFetchDiag();
    const installed = globalThis.fetch;
    installFetchDiag();
    const actual = await globalThis.fetch(
      'https://example.test/download?next=https://api.openai.com/v1&token=secret',
    );

    expect(globalThis.fetch).toBe(installed);
    expect(actual).toBe(response);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(mocks.info).toHaveBeenCalledWith('installed', { mode: 'open_always' });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('logs only the safe action for successful provider requests', async () => {
    const fetchStub = vi.fn(async () => new Response('ok', { status: 200 }));
    globalThis.fetch = fetchStub;
    installFetchDiag();

    await globalThis.fetch(
      new Request('https://api.openai.com/v1/chat/completions?api_key=top-secret'),
    );

    expect(mocks.info).toHaveBeenLastCalledWith('provider fetch ok', {
      url: 'https://api.openai.com/v1/chat/completions',
      status: 200,
      ms: expect.any(Number),
    });
    expect(JSON.stringify(mocks.info.mock.calls)).not.toContain('top-secret');
  });

  it('matches exact model provider hosts without diagnosing look-alike or unrelated Google traffic', async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 204 }));
    globalThis.fetch = fetchStub;
    installFetchDiag();

    await globalThis.fetch('https://openai.com.evil.test/collect');
    await globalThis.fetch('https://www.googleapis.com/calendar/v3/events');
    await globalThis.fetch('https://generativelanguage.googleapis.com/v1beta/models');
    await globalThis.fetch('https://bedrock-runtime.us-east-1.amazonaws.com/model/invoke');

    const loggedUrls = mocks.info.mock.calls
      .filter(([message]) => message === 'provider fetch ok')
      .map(([, detail]) => detail.url);
    expect(loggedUrls).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models',
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/invoke',
    ]);
  });

  it('does not retain provider-controlled status text on non-OK responses', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, {
      status: 401,
      statusText: 'denied api-key=provider-echoed-secret',
    }));
    installFetchDiag();

    const response = await globalThis.fetch('https://api.anthropic.com/v1/messages');

    expect(response.status).toBe(401);
    expect(mocks.warn).toHaveBeenCalledWith('provider fetch non-ok', {
      url: 'https://api.anthropic.com/v1/messages',
      status: 401,
      ms: expect.any(Number),
    });
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('provider-echoed-secret');
  });

  it('rethrows the original nested network failure while logging only bounded summaries', async () => {
    const deepest = Object.assign(new Error('socket included local/path and secret-token'), {
      code: 'ECONNRESET',
    });
    const cause = Object.assign(new Error('request failed with private-host'), {
      code: 'UND_ERR_SOCKET',
      cause: deepest,
    });
    const failure = new TypeError('fetch failed', { cause });
    globalThis.fetch = vi.fn(async () => { throw failure; });
    installFetchDiag();

    await expect(globalThis.fetch('https://api.moonshot.cn/v1/chat/completions'))
      .rejects.toBe(failure);

    expect(mocks.warn).toHaveBeenCalledWith('provider fetch threw', {
      url: 'https://api.moonshot.cn/v1/chat/completions',
      ms: expect.any(Number),
      error: expect.objectContaining({ name: 'TypeError', message_hash: expect.any(String) }),
      cause: expect.objectContaining({ code: 'UND_ERR_SOCKET', message_hash: expect.any(String) }),
      cause_cause: expect.objectContaining({ code: 'ECONNRESET', message_hash: expect.any(String) }),
    });
    const logged = JSON.stringify(mocks.warn.mock.calls);
    expect(logged).not.toContain('private-host');
    expect(logged).not.toContain('secret-token');
    expect(logged).not.toContain('local/path');
  });
});
