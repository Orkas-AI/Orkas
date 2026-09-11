import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiKey: 'fixture-api-key',
  fetch: vi.fn(),
}));
vi.mock('../../../src/main/features/connectors/_server_bridge', () => ({ accountApiBase: () => 'https://orkas.ai/api' }));
vi.mock('../../../src/main/features/auth', () => ({ getOrkasApiKey: () => mocks.apiKey }));
vi.mock('../../../src/main/util/abort', () => ({ fetchWithTimeout: mocks.fetch }));
vi.mock('../../../src/main/features/api_common', () => ({ withCommonHeaders: (h: unknown) => h }));

import {
  preflightConnectorCredits,
  usageMeteringForEntry,
} from '../../../src/main/features/connectors/usage-metering';

const entry: any = { id: 'gmail', usage_metering: { provider: 'composio' } };

describe('connector usage metering', () => {
  beforeEach(() => {
    mocks.apiKey = 'fixture-api-key';
    mocks.fetch.mockReset();
  });

  it('normalizes valid metering and rejects unsupported or invalid values', () => {
    expect(usageMeteringForEntry(entry)?.credits_milli_per_call).toBe(420);
    // During a rolling upgrade, an explicit server tariff remains authoritative.
    expect(usageMeteringForEntry({ usage_metering: { provider: 'composio', credits_milli_per_call: 250 } } as any)?.credits_milli_per_call).toBe(250);
    expect(usageMeteringForEntry({ usage_metering: { provider: 'other' } } as any)).toBeNull();
    expect(usageMeteringForEntry({ usage_metering: { provider: 'composio', credits_milli_per_call: -1 } } as any)).toBeNull();
    expect(usageMeteringForEntry({ usage_metering: { provider: 'composio', credits_milli_per_call: 9.9 } } as any)?.credits_milli_per_call).toBe(9);
  });

  it('requires a configured API Key and sends a bounded normalized preflight request', async () => {
    mocks.apiKey = '';
    await expect(preflightConnectorCredits(entry, 'tool_call')).rejects.toMatchObject({ code: 'orkas_api_key_required' });
    mocks.apiKey = 'fixture-api-key';
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, allowed: true }) });
    await expect(preflightConnectorCredits(entry, 'tool_call', Number.NaN)).resolves.toMatchObject({ allowed: true });
    const [url, options, timeout] = mocks.fetch.mock.calls[0];
    expect(url).toBe('https://orkas.ai/api/connectors/usage/preflight');
    expect(JSON.parse(options.body)).toMatchObject({ connector_id: 'gmail', stage: 'tool_call', calls: 1 });
    expect(options.headers.Authorization).toBe('Bearer fixture-api-key');
    expect(options.headers).not.toHaveProperty('session_id');
    expect(timeout).toBe(60_000);
  });

  it('preserves the official quota code alongside the legacy-visible server message', async () => {
    mocks.fetch.mockResolvedValue({
      ok: false,
      status: 402,
      text: async () => JSON.stringify({
        msg: 'Insufficient credits',
        error: {
          message: 'Insufficient credits',
          type: 'insufficient_quota',
          code: 'orkas_credits_quota_exceeded',
        },
      }),
    });
    await expect(preflightConnectorCredits(entry, 'connect')).rejects.toMatchObject({
      message: 'Insufficient credits',
      code: 'orkas_credits_quota_exceeded',
    });
  });

  it('does not synthesize an Orkas quota code from a message-only 402', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 402, text: async () => JSON.stringify({ error: { message: 'quota' } }) });
    try {
      await preflightConnectorCredits(entry, 'connect');
      throw new Error('expected preflight to fail');
    } catch (err) {
      expect(err).toMatchObject({ message: 'quota' });
      expect((err as { code?: unknown }).code).toBeUndefined();
    }
  });

  it('surfaces malformed HTTP failures without assigning billing ownership', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'not-json' });
    await expect(preflightConnectorCredits(entry, 'connect')).rejects.toThrow('Connector credit check failed');
    mocks.fetch.mockResolvedValue({ ok: false, status: 402, text: async () => 'not-json' });
    await expect(preflightConnectorCredits(entry, 'connect')).rejects.toThrow('Connector credit check failed');
    await expect(preflightConnectorCredits({ id: 'local' } as any, 'connect')).resolves.toBeNull();
  });
});
