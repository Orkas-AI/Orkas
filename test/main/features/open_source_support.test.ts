import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithRetry } = vi.hoisted(() => ({ fetchWithRetry: vi.fn() }));
vi.mock('../../../src/main/util/retry', () => ({ fetchWithRetry }));
vi.mock('../../../src/main/features/marketplace', () => ({ apiBase: () => 'https://orkas.example/api' }));

import { recordOpenSourceSupport } from '../../../src/main/features/open_source_support';

beforeEach(() => {
  for (const key of ['ORKAS_E2E_USER_DATA_DIR', 'ORKAS_TELEMETRY_DISABLED', 'ORKAS_PACKAGED_LAUNCH_SMOKE_FILE']) {
    vi.stubEnv(key, undefined);
  }
  fetchWithRetry.mockReset();
  fetchWithRetry.mockResolvedValue(new Response(null));
});
afterEach(() => vi.unstubAllEnvs());

describe('OrkasOpen star reporting', () => {
  it('uses the host UID and standard client headers without forwarding renderer data', async () => {
    vi.stubEnv('ORKAS_APP_VERSION', '2026.11.27');
    await recordOpenSourceSupport({ surface: 'home', action: 'show', run_id: 'fixture', uid: 'renderer-supplied' }, '12345678');
    expect(fetchWithRetry).toHaveBeenCalledExactlyOnceWith(
      'open-source-support', 'https://orkas.example/api/analytics/open-github-star', {
        method: 'POST', headers: expect.objectContaining({ 'Content-Type': 'application/json', 'Orkas-Channel': 'open', 'Orkas-App-Version': expect.any(String), 'Orkas-Platform': expect.any(String) }),
        body: '{"surface":"home","action":"show","uid":"12345678"}', credentials: 'omit', redirect: 'error',
      }, expect.objectContaining({ retries: 0, timeoutMs: 5000 }),
    );
  });

  it.each(['', '../invalid', 'x'.repeat(51)])('records the interaction without an unavailable or invalid host UID (%s)', async (uid) => {
    await recordOpenSourceSupport({ surface: 'settings', action: 'open', uid: 'renderer-supplied' }, uid);
    expect(JSON.parse(fetchWithRetry.mock.calls[0][2].body)).toEqual({ surface: 'settings', action: 'open' });
  });

  it('suppresses invalid and test-generated events', async () => {
    await recordOpenSourceSupport({ surface: 'settings', action: 'dismiss' }, '12345678');
    await recordOpenSourceSupport({ surface: 'conversation', action: 'show' }, '12345678');
    vi.stubEnv('ORKAS_TELEMETRY_DISABLED', '1');
    await recordOpenSourceSupport({ surface: 'settings', action: 'open' }, '12345678');
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });
});
