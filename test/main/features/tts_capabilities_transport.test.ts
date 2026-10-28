import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ error: null as Error | null, warn: vi.fn() }));
vi.mock('../../../src/main/features/tts_auth', async original => ({
  ...await original<typeof import('../../../src/main/features/tts_auth')>(),
  listUsableTtsProfiles: () => { if (state.error) throw state.error; return [{ id: 'key-profile', provider: 'orkas-api', baseUrl: 'https://fixture.invalid', apiKey: 'fixture-key', model: 'fixture-model', voice: 'fixture-voice' }]; },
}));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ warn: state.warn }) }));
import { getTtsAvailabilityDetails, listTtsCapabilities } from '../../../src/main/features/tts_capabilities';
let priorBase: string | undefined;
beforeEach(() => { priorBase = process.env.ORKAS_TTS_BASE_URL; delete process.env.ORKAS_TTS_BASE_URL; state.error = null; state.warn.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); if (priorBase === undefined) delete process.env.ORKAS_TTS_BASE_URL; else process.env.ORKAS_TTS_BASE_URL = priorBase; });
describe('public speech capability profile boundary', () => {
  it('keeps private profile storage failures out of capability diagnostics', async () => {
    state.error = new Error('read /Users/test/profile.json token=fixture-storage-secret');
    expect(await listTtsCapabilities()).toEqual([]);
    expect(getTtsAvailabilityDetails().available).toBe(false);
    expect(state.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(state.warn.mock.calls)).not.toContain('fixture-storage-secret');
    expect(JSON.stringify(state.warn.mock.calls)).not.toContain('/Users/test/profile.json');
  });
  it('keeps the saved API-key voice catalog local without a managed-session request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect(await listTtsCapabilities()).toMatchObject([{ routeRef: 'key-profile', provider: 'orkas-api', catalogStatus: 'configured-only', voices: [{ providerVoiceId: 'fixture-voice' }] }]);
    expect(getTtsAvailabilityDetails()).toMatchObject({ available: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});
