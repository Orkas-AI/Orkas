import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profiles: [] as Array<Record<string, any>>,
  runSearchAdapter: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../src/main/features/auth', () => ({
  loadSearchProfiles: () => mocks.profiles.map((profile) => ({ ...profile })),
  saveSearchProfiles: (profiles: Array<Record<string, any>>) => {
    mocks.profiles = profiles.map((profile) => ({ ...profile }));
  },
}));
vi.mock('../../../src/main/model/core-agent/search-adapters', () => ({
  searchAdaptersByProvider: {
    tavily: vi.fn(),
    serper: vi.fn(),
  },
  runSearchAdapter: mocks.runSearchAdapter,
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mocks.warn,
  }),
}));

beforeEach(() => {
  mocks.profiles = [];
  mocks.runSearchAdapter.mockReset();
  mocks.warn.mockReset();
  vi.resetModules();
});

describe('search credential profiles', () => {
  it('does not create duplicate fallback rows for the same provider and key', async () => {
    const searchAuth = await import('../../../src/main/features/search_auth');

    const first = searchAuth.addSearchProfile({
      provider: 'tavily',
      apiKey: 'tvly-duplicate-key',
      label: 'primary',
    });
    const second = searchAuth.addSearchProfile({
      provider: 'tavily',
      apiKey: 'tvly-duplicate-key',
      label: 'duplicate',
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(mocks.profiles).toHaveLength(1);
  });

  it('returns and logs a stable redacted failure when a provider echoes secrets or paths', async () => {
    const searchAuth = await import('../../../src/main/features/search_auth');
    const added = searchAuth.addSearchProfile({
      provider: 'serper',
      apiKey: 'sk-super-secret-search-key',
    });
    if (!added.ok) throw new Error('profile precondition failed');
    mocks.runSearchAdapter.mockRejectedValueOnce(
      new Error('Serper 401: key=sk-super-secret-search-key path=/Users/test/private'),
    );

    const result = await searchAuth.testSearchProfile(added.id);

    expect(result).toMatchObject({
      ok: false,
      error: 'search credentials rejected',
    });
    expect(JSON.stringify(result)).not.toContain('super-secret');
    expect(JSON.stringify(result)).not.toContain('/Users/test');
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('super-secret');
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('/Users/test');
  });
});
