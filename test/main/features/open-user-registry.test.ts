import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previousRoot: string | undefined;
let previousAuth: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-open-registry-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  previousAuth = process.env.CORE_AGENT_AUTH_DIR;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  delete process.env.CORE_AGENT_AUTH_DIR;
  vi.resetModules();
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  if (previousAuth === undefined) delete process.env.CORE_AGENT_AUTH_DIR;
  else process.env.CORE_AGENT_AUTH_DIR = previousAuth;
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

function seedLegacy(uid: string) {
  const registry = JSON.stringify({
    current_user_id: uid, dev_current_user_id: uid,
    users: [{ user_id: uid, created_at: '2026-01-01T00:00:00' }],
  });
  fs.writeFileSync(path.join(root, 'users.json'), registry);
  const config = path.join(root, uid, 'local', 'config');
  fs.mkdirSync(config, { recursive: true });
  return { registry, config };
}

async function boot() {
  const users = await import('../../../src/main/features/users');
  return users.initActiveUser({ openSource: true });
}

function openRegistry() {
  return JSON.parse(fs.readFileSync(path.join(root, 'open-users.json'), 'utf8'));
}

describe('open-source user directory selection', () => {
  it.each(['login-record', 'hosted-encryption', 'anonymous'])(
    'isolates %s data and allows offline Key setup without changing hosted files', async (kind) => {
      const oldUid = kind === 'anonymous' ? 'anonymous' : 'commercial-user';
      const { registry, config } = seedLegacy(oldUid);
      if (kind === 'login-record') {
        fs.writeFileSync(path.join(config, 'account.json'), JSON.stringify({ user_id: oldUid }));
      }
      // A hosted encrypted file is enough evidence even after account.json was removed.
      const oldAuth = 'ORKLSEC1:hosted-fixture';
      if (kind === 'hosted-encryption') fs.writeFileSync(path.join(config, 'auth-profiles.json'), oldAuth);
      const before = fs.readdirSync(config);
      const fetchMock = vi.fn(async () => { throw new Error('offline'); });
      vi.stubGlobal('fetch', fetchMock);

      const rec = await boot();
      expect(rec.user_id).toMatch(/^[a-f0-9]{32}$/);
      expect(rec.user_id).not.toBe(oldUid);
      expect(openRegistry().open_current_user_id).toBe(rec.user_id);
      expect(process.env.CORE_AGENT_AUTH_DIR).toBe(path.join(root, rec.user_id, 'local', 'config'));

      const auth = await import('../../../src/main/features/auth');
      expect(auth.saveOrkasApiCredential(auth.prepareOrkasApiCredential('open-test-key-xxxxxxxx')))
        .toMatchObject({ configured: true });
      expect(auth.getOrkasApiKey()).toBe('open-test-key-xxxxxxxx');
      expect(fs.readFileSync(path.join(root, 'users.json'), 'utf8')).toBe(registry);
      expect(fs.readdirSync(config)).toEqual(before);
      if (kind === 'hosted-encryption') {
        expect(fs.readFileSync(path.join(config, 'auth-profiles.json'), 'utf8')).toBe(oldAuth);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['12345678', '0123456789abcdef0123456789abcdef'])(
    'reuses legacy open user %s in place and can still decrypt its credentials', async (uid) => {
      const { registry, config } = seedLegacy(uid);
      const secrets = await import('../../../src/main/util/local-secret-store');
      const plaintext = JSON.stringify({
        version: 6, profiles: {
          'openai:default': { type: 'api_key', provider: 'openai', key: 'legacy-test-key', label: 'default' },
        }, entries: [], searchProfiles: [], imageProfiles: [], videoProfiles: [], ttsProfiles: [],
      });
      const encrypted = secrets.encryptLocalSecret({
        namespace: 'auth.profiles', ownerId: uid, recordId: 'auth-profiles.json',
      }, plaintext);
      fs.writeFileSync(path.join(config, 'auth-profiles.json'), encrypted);
      fs.writeFileSync(path.join(config, 'retained-marker'), 'keep');

      expect((await boot()).user_id).toBe(uid);
      expect(openRegistry().open_current_user_id).toBe(uid);
      expect(fs.readFileSync(path.join(root, 'users.json'), 'utf8')).toBe(registry);
      expect(fs.readFileSync(path.join(config, 'retained-marker'), 'utf8')).toBe('keep');
      expect(secrets.decryptLocalSecret({
        namespace: 'auth.profiles', ownerId: uid, recordId: 'auth-profiles.json',
      }, fs.readFileSync(path.join(config, 'auth-profiles.json'), 'utf8'))).toBe(plaintext);
    },
  );

  it('retains its own user after an old commercial app rewrites the shared registry', async () => {
    const { config } = seedLegacy('commercial-first');
    fs.writeFileSync(path.join(config, 'account.json'), '{}');
    const first = await boot();
    const next = seedLegacy('commercial-next').registry;
    vi.resetModules();

    expect((await boot()).user_id).toBe(first.user_id);
    expect(fs.readFileSync(path.join(root, 'users.json'), 'utf8')).toBe(next);
    expect(openRegistry().users).toHaveLength(1);
  });

  it('creates only its own registry on a clean install and keeps the same user on restart', async () => {
    const first = await boot();
    expect(fs.existsSync(path.join(root, 'users.json'))).toBe(false);
    vi.resetModules();
    expect((await boot()).user_id).toBe(first.user_id);
  });

  it('uses the saved open pointer directly without repeating legacy ownership detection', async () => {
    seedLegacy('legacy-open');
    const first = await boot();
    // Once migration is complete, an unrelated account file must not select a
    // different data directory. Credential validation remains with its own reader.
    fs.writeFileSync(path.join(root, first.user_id, 'local', 'config', 'account.json'), '{}');
    vi.resetModules();
    expect((await boot()).user_id).toBe(first.user_id);
  });

  it('persists later local user changes only through the open pointer', async () => {
    const { registry, config } = seedLegacy('commercial-user');
    fs.writeFileSync(path.join(config, 'account.json'), '{}');
    await boot();
    const users = await import('../../../src/main/features/users');
    users.activateUser('another-open-user');
    expect(openRegistry().open_current_user_id).toBe('another-open-user');
    expect(fs.readFileSync(path.join(root, 'users.json'), 'utf8')).toBe(registry);
    vi.resetModules();
    expect((await boot()).user_id).toBe('another-open-user');
  });

  it.each(['{broken', JSON.stringify({ open_current_user_id: '../outside', users: [] })])(
    'preserves an invalid open registry and refuses to fall back to another user', async (raw) => {
      const { registry } = seedLegacy('legacy-user');
      fs.writeFileSync(path.join(root, 'open-users.json'), raw);
      await expect(boot()).rejects.toThrow(/open-source user registry/);
      expect(fs.readFileSync(path.join(root, 'open-users.json'), 'utf8')).toBe(raw);
      expect(fs.readFileSync(path.join(root, 'users.json'), 'utf8')).toBe(registry);
      const users = await import('../../../src/main/features/users');
      expect(users.hasActiveUser()).toBe(false);
    },
  );
});
