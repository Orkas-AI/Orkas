import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
let previousRoot: string | undefined;
const uid = 'authParityRecovery';
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-auth-parity-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../src/main/features/users')).activateUser(uid);
});
afterEach(() => {
  vi.doUnmock('node:fs');
  vi.doUnmock('#core-agent');
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function writeStore(store: unknown) {
  const { userAuthProfilesFile } = await import('../../../src/main/paths');
  const { encryptLocalSecret } = await import('../../../src/main/util/local-secret-store');
  const file = userAuthProfilesFile(uid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encryptLocalSecret({ namespace: 'auth.profiles', ownerId: uid, recordId: 'auth-profiles.json' }, JSON.stringify(store)));
  return file;
}

describe('auth retained recovery boundaries', () => {
  it('reports expired OAuth only after refresh fails, then clears it after successful refresh', async () => {
    const refreshToken = vi.fn().mockRejectedValueOnce(new Error('expired grant'))
      .mockResolvedValueOnce({ access: 'fixture-new-access', refresh: 'fixture-new-refresh', expires: Date.now() + 60_000 });
    const oauth = await import('../../../src/core-agent/src/auth/oauth-compat');
    oauth.registerOAuthProvider({ id: 'openai-codex', name: 'Codex', login: vi.fn(), refreshToken, getApiKey: (credentials) => credentials.access });
    await writeStore({ version: 6, profiles: {
      'openai-codex:default': { type: 'oauth', provider: 'openai-codex', label: 'default', access: 'fixture-old', refresh: 'fixture-refresh', expires: 1, createdAt: 1, lastUsed: 0 },
    }, entries: [{ entryId: 'fixture-entry', provider: 'openai-codex', profileId: 'openai-codex:default', model: 'gpt-5.5', createdAt: 1, lastUsed: 0 }] });
    const auth = await import('../../../src/main/features/auth');
    expect(auth.getConfiguredModelOAuthExpiredMessage()).toBeNull();
    expect(await auth.pickChatEntryGroup()).toEqual([]);
    expect(auth.getConfiguredModelOAuthExpiredMessage()).toBeTruthy();
    expect(await auth.pickChatEntryGroup()).toEqual([expect.objectContaining({ apiKey: 'fixture-new-access' })]);
    expect(auth.getConfiguredModelOAuthExpiredMessage()).toBeNull();
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });

  it('publishes selection and model change together in one write', async () => {
    const { userAuthProfilesFile } = await import('../../../src/main/paths');
    const file = userAuthProfilesFile(uid);
    let publishes = 0;
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return { ...actual, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (String(to) === file) publishes++;
        return actual.renameSync(from, to);
      } };
    });
    const auth = await import('../../../src/main/features/auth');
    const target = await auth.addApiKeyEntry('openai', 'gpt-5.6-sol', 'fixture-key-one');
    await auth.addApiKeyEntry('anthropic', 'claude-opus-5', 'fixture-key-two');
    publishes = 0;
    const selected = await auth.selectEntry(target.entryId, 'gpt-5.6-terra');
    expect(publishes).toBe(1);
    expect(selected.entries[0]).toMatchObject({ entryId: target.entryId, model: 'gpt-5.6-terra' });
  });

  it('does not mutate a custom endpoint model through Composer selection', async () => {
    const auth = await import('../../../src/main/features/auth');
    const entry = await auth.addCustomModelEntry({ baseUrl: 'https://fixture.example/v1', model: 'fixed-model', apiKey: 'fixture-key' });
    await expect(auth.selectEntry(entry.entryId, 'other-model')).rejects.toThrow('fixed');
    expect((await auth.listEntries()).entries[0].model).toBe('fixed-model');
  });

  it.each(['saveSearchProfiles', 'saveImageProfiles', 'saveVideoProfiles', 'saveTtsProfiles', 'configureAllOrkasApiServices'] as const)
    ('preserves an invalid existing schema during %s', async (operation) => {
      const file = await writeStore({ version: 6, unexpected: 'preserve' });
      const original = fs.readFileSync(file, 'utf8');
      const auth = await import('../../../src/main/features/auth');
      expect(() => operation === 'configureAllOrkasApiServices'
        ? auth[operation]('fixture-new-key') : auth[operation]([])).toThrow('schema invalid');
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    });

  it('keeps legacy custom speech profiles that did not record a provider', async () => {
    await writeStore({ version: 6, profiles: {}, entries: [], ttsProfiles: [{ id: 'legacy-speech', baseUrl: 'https://fixture.example/v1', model: 'speech', apiKey: 'fixture-key' }] });
    const auth = await import('../../../src/main/features/auth');
    expect(auth.loadTtsProfiles()).toEqual([expect.objectContaining({ id: 'legacy-speech', provider: 'custom' })]);
  });

  it('does not fail a healthy model choice when last-used persistence fails', async () => {
    const auth = await import('../../../src/main/features/auth');
    const entry = await auth.addApiKeyEntry('openai', 'gpt-5.5', 'fixture-key');
    const { userAuthProfilesFile } = await import('../../../src/main/paths');
    const file = userAuthProfilesFile(uid);
    fs.writeFileSync(file, 'fixture-corrupt-store');
    expect(() => auth.bumpEntryLastUsed(entry.entryId)).not.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('fixture-corrupt-store');
  });

  it('redacts SDK connection errors before returning them to the renderer', async () => {
    const key = 'fixture-opaque-secret-123456';
    vi.doMock('#core-agent', async (importOriginal) => ({
      ...await importOriginal<typeof import('#core-agent')>(),
      createPiProvider: () => ({ complete: async () => { throw new Error(`Rejected ${key} at https://private.fixture.example/v1?signature=secret`); } }),
    }));
    const auth = await import('../../../src/main/features/auth');
    const profile = await auth.addApiKey('openai', key);
    const result = await auth.testConnection('openai', 'gpt-5.5', profile.profileId);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Rejected');
    expect(result.error).not.toContain(key);
    expect(result.error).not.toContain('signature=secret');
  });
});
