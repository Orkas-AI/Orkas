import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithRetry } = vi.hoisted(() => ({ fetchWithRetry: vi.fn() }));
vi.mock('../../../src/main/util/retry', () => ({ fetchWithRetry }));
vi.mock('../../../src/main/features/marketplace', () => ({ apiBase: () => 'https://orkas.example/api' }));

import { recordOpenSourceSupport } from '../../../src/main/features/open_source_support';
import { reportOpenLifecycle } from '../../../src/main/features/open_lifecycle';

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
      'open-source-support', 'https://orkas.example/api/analytics/open-app-lifecycle', {
        method: 'POST', headers: expect.objectContaining({ 'Content-Type': 'application/json', 'Orkas-Channel': 'open', 'Orkas-App-Version': expect.any(String), 'Orkas-Platform': expect.any(String) }),
        body: '{"event":"github_star","surface":"home","action":"show","uid":"12345678"}', credentials: 'omit', redirect: 'error',
      }, expect.objectContaining({ retries: 0, timeoutMs: 5000 }),
    );
  });

  it.each(['', '../invalid', 'x'.repeat(51)])('records the interaction without an unavailable or invalid host UID (%s)', async (uid) => {
    await recordOpenSourceSupport({ surface: 'settings', action: 'open', uid: 'renderer-supplied' }, uid);
    expect(JSON.parse(fetchWithRetry.mock.calls[0][2].body)).toEqual({ event: 'github_star', surface: 'settings', action: 'open' });
  });

  it('shares one route with enter and leave while preserving their request bodies', async () => {
    await reportOpenLifecycle('12345678', { event: 'enter', trigger: 'cold_start' });
    await recordOpenSourceSupport({ surface: 'home', action: 'show' }, '12345678');
    await reportOpenLifecycle('12345678', { event: 'leave', trigger: 'quit' });
    const submissions = fetchWithRetry.mock.calls.map(([, url, options]) => [url, JSON.parse(options.body)]);
    expect(submissions).toEqual([
      ['https://orkas.example/api/analytics/open-app-lifecycle', { event: 'enter', trigger: 'cold_start', uid: '12345678' }],
      ['https://orkas.example/api/analytics/open-app-lifecycle', { event: 'github_star', surface: 'home', action: 'show', uid: '12345678' }],
      ['https://orkas.example/api/analytics/open-app-lifecycle', { event: 'leave', trigger: 'quit', uid: '12345678' }],
    ]);
  });

  it('suppresses invalid and test-generated events', async () => {
    await recordOpenSourceSupport({ surface: 'settings', action: 'dismiss' }, '12345678');
    await recordOpenSourceSupport({ surface: 'conversation', action: 'show' }, '12345678');
    vi.stubEnv('ORKAS_TELEMETRY_DISABLED', '1');
    await recordOpenSourceSupport({ surface: 'settings', action: 'open' }, '12345678');
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });
});
