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
  it('sends only the surface and action to the guarded analytics route', async () => {
    await recordOpenSourceSupport({ surface: 'home', action: 'show', run_id: 'fixture', uid: 'fixture' });
    expect(fetchWithRetry).toHaveBeenCalledExactlyOnceWith(
      'open-source-support', 'https://orkas.example/api/analytics/open-github-star', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Orkas-Channel': 'open' },
        body: '{"surface":"home","action":"show"}', credentials: 'omit', redirect: 'error',
      }, expect.objectContaining({ retries: 0, timeoutMs: 5000 }),
    );
  });

  it('suppresses invalid and test-generated events', async () => {
    await recordOpenSourceSupport({ surface: 'settings', action: 'dismiss' });
    await recordOpenSourceSupport({ surface: 'conversation', action: 'show' });
    vi.stubEnv('ORKAS_TELEMETRY_DISABLED', '1');
    await recordOpenSourceSupport({ surface: 'settings', action: 'open' });
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });
});
