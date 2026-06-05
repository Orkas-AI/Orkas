import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// `features/users` owns the active-uid lifecycle: first boot generates a
// uid, writes users.json, and `activateUser` mkdir's the full
// `<uid>/{cloud,local}/*` layout and pins `CORE_AGENT_AUTH_DIR`.

let tmpDir: string;
let prevWs: string | undefined;
let prevAuth: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-users-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevAuth = process.env.CORE_AGENT_AUTH_DIR;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  delete process.env.CORE_AGENT_AUTH_DIR;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevAuth === undefined) delete process.env.CORE_AGENT_AUTH_DIR;
  else process.env.CORE_AGENT_AUTH_DIR = prevAuth;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('features/users › getActiveUserId', () => {
  it('throws before activateUser has run', async () => {
    const users = await import('../../../src/main/features/users');
    expect(users.hasActiveUser()).toBe(false);
    expect(() => users.getActiveUserId()).toThrow(/no active user/);
  });
});

describe('features/users › activateUser', () => {
  it('mkdirs the full <uid>/{cloud,local}/* skeleton', async () => {
    const users = await import('../../../src/main/features/users');
    users.activateUser('u1');

    for (const d of [
      path.join(tmpDir, 'u1', 'cloud', 'chats'),
      path.join(tmpDir, 'u1', 'cloud', 'sessions'),
      path.join(tmpDir, 'u1', 'cloud', 'chat_attachments'),
      path.join(tmpDir, 'u1', 'cloud', 'contexts'),
      path.join(tmpDir, 'u1', 'cloud', 'memory'),
      path.join(tmpDir, 'u1', 'cloud', 'agents'),
      path.join(tmpDir, 'u1', 'cloud', 'skills'),
      // 顶层 cloud/meta/ 已废弃,per-agent meta 落 agents/<aid>/meta/(详见
      // docs/plans/agent-as-directory.md)
      path.join(tmpDir, 'u1', 'cloud', 'config'),
      path.join(tmpDir, 'u1', 'local', 'config'),
      path.join(tmpDir, 'u1', 'local', 'search'),
      path.join(tmpDir, 'u1', 'local', 'test'),
    ]) {
      expect(fs.existsSync(d), `expected ${d}`).toBe(true);
    }
  });

  it('pins CORE_AGENT_AUTH_DIR to <uid>/local/config/', async () => {
    const users = await import('../../../src/main/features/users');
    users.activateUser('u1');
    expect(process.env.CORE_AGENT_AUTH_DIR)
      .toBe(path.join(tmpDir, 'u1', 'local', 'config'));
  });

  it('re-pins CORE_AGENT_AUTH_DIR on uid switch', async () => {
    const users = await import('../../../src/main/features/users');
    users.activateUser('u1');
    users.activateUser('u2');
    expect(users.getActiveUserId()).toBe('u2');
    expect(process.env.CORE_AGENT_AUTH_DIR)
      .toBe(path.join(tmpDir, 'u2', 'local', 'config'));
  });

  it('writes users.json with current_user_id on first activation', async () => {
    const users = await import('../../../src/main/features/users');
    users.activateUser('u1');
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'users.json'), 'utf-8'));
    expect(reg.current_user_id).toBe('u1');
    expect(reg.users.map((u: { user_id: string }) => u.user_id)).toContain('u1');
  });

  it('switching uid updates current_user_id and appends to users list', async () => {
    const users = await import('../../../src/main/features/users');
    users.activateUser('u1');
    users.activateUser('u2');
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'users.json'), 'utf-8'));
    expect(reg.current_user_id).toBe('u2');
    expect(reg.users.map((u: { user_id: string }) => u.user_id).sort()).toEqual(['u1', 'u2']);
  });

  it('rejects invalid uid (path-traversal / special chars)', async () => {
    const users = await import('../../../src/main/features/users');
    expect(() => users.activateUser('../evil')).toThrow(/invalid user id/);
    expect(() => users.activateUser('')).toThrow(/invalid user id/);
  });
});

describe('features/users › initActiveUser', () => {
  it('first boot: generates a uid and writes users.json', async () => {
    const users = await import('../../../src/main/features/users');
    const rec = users.initActiveUser();
    expect(/^\d{8}$/.test(rec.user_id)).toBe(true);
    expect(users.getActiveUserId()).toBe(rec.user_id);
    expect(fs.existsSync(path.join(tmpDir, 'users.json'))).toBe(true);
  });

  it('hosted first boot: uses the anonymous uid when requested', async () => {
    const users = await import('../../../src/main/features/users');
    const rec = users.initActiveUser({ defaultLocalId: users.ANONYMOUS_LOCAL_ID });
    expect(rec.user_id).toBe('anonymous');
    expect(users.getActiveUserId()).toBe('anonymous');
    expect(fs.existsSync(path.join(tmpDir, 'anonymous', 'local', 'config'))).toBe(true);
  });

  it('subsequent boot: reuses current_user_id from users.json', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'users.json'),
      JSON.stringify({
        current_user_id: 'u1',
        users: [{ user_id: 'u1', created_at: '2026-01-01T00:00:00' }],
      }),
      'utf-8',
    );
    const users = await import('../../../src/main/features/users');
    const rec = users.initActiveUser();
    expect(rec.user_id).toBe('u1');
    expect(rec.created_at).toBe('2026-01-01T00:00:00');
  });
});

describe('features/users › account uid', () => {
  it('uses the account uid itself as the profile id', async () => {
    const users = await import('../../../src/main/features/users');
    expect(users.accountUserIdToLocalId('A0653F11-9F05-4A8B-89CE-0026D809EAFC'))
      .toBe('A0653F11-9F05-4A8B-89CE-0026D809EAFC');
  });

  it('renames anonymous to account uid on first login when target is missing', async () => {
    const users = await import('../../../src/main/features/users');
    users.initActiveUser({ defaultLocalId: users.ANONYMOUS_LOCAL_ID });
    fs.writeFileSync(path.join(tmpDir, 'anonymous', 'local', 'config', 'marker.txt'), 'kept');

    const rec = users.switchToAccountLocalId('A0653F11-9F05-4A8B-89CE-0026D809EAFC');

    expect(rec.user_id).toBe('A0653F11-9F05-4A8B-89CE-0026D809EAFC');
    expect(fs.existsSync(path.join(tmpDir, 'anonymous'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, rec.user_id, 'local', 'config', 'marker.txt'), 'utf8')).toBe('kept');
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'users.json'), 'utf-8'));
    expect(reg.current_user_id).toBe(rec.user_id);
    expect(reg.users.map((u: { user_id: string }) => u.user_id)).toEqual([rec.user_id]);
  });

  it('rekeys auth-profiles when anonymous is renamed to the account uid', async () => {
    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    users.initActiveUser({ defaultLocalId: users.ANONYMOUS_LOCAL_ID });
    const file = paths.userAuthProfilesFile(users.ANONYMOUS_LOCAL_ID);
    fs.writeFileSync(file, localSecrets.encryptLocalSecret({
      namespace: 'auth.profiles',
      ownerId: users.ANONYMOUS_LOCAL_ID,
      recordId: 'auth-profiles.json',
    }, JSON.stringify({
      version: 4,
      profiles: {
        'openai:default': {
          type: 'api_key',
          provider: 'openai',
          label: 'default',
          key: 'sk-anon-owner-xxxxxxxx',
          createdAt: 1,
          lastUsed: 0,
        },
      },
      entries: [],
      searchProfiles: [],
      imageProfiles: [],
    })), 'utf8');

    const rec = users.switchToAccountLocalId('A0653F11-9F05-4A8B-89CE-0026D809EAFC');

    const raw = fs.readFileSync(paths.userAuthProfilesFile(rec.user_id), 'utf8');
    const json = localSecrets.decryptLocalSecret({
      namespace: 'auth.profiles',
      ownerId: 'A0653F11-9F05-4A8B-89CE-0026D809EAFC',
      recordId: 'auth-profiles.json',
    }, raw);
    expect(json).toContain('sk-anon-owner-xxxxxxxx');
  });

  it('creates a fresh anonymous directory after logout', async () => {
    const users = await import('../../../src/main/features/users');
    users.initActiveUser({ defaultLocalId: users.ANONYMOUS_LOCAL_ID });
    users.switchToAccountLocalId('A0653F11-9F05-4A8B-89CE-0026D809EAFC');
    fs.mkdirSync(path.join(tmpDir, 'anonymous', 'cloud', 'chats'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'anonymous', 'cloud', 'chats', 'leftover.jsonl'), 'stale');

    const rec = users.switchToAnonymousLocalId();

    expect(rec.user_id).toBe('anonymous');
    expect(fs.existsSync(path.join(tmpDir, 'anonymous', 'local', 'config'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'anonymous', 'cloud', 'chats', 'leftover.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'A0653F11-9F05-4A8B-89CE-0026D809EAFC'))).toBe(true);
  });

  it('does not wipe anonymous data when already anonymous', async () => {
    const users = await import('../../../src/main/features/users');
    users.initActiveUser({ defaultLocalId: users.ANONYMOUS_LOCAL_ID });
    fs.writeFileSync(path.join(tmpDir, 'anonymous', 'local', 'config', 'draft.txt'), 'kept');

    users.switchToAnonymousLocalId();

    expect(fs.readFileSync(path.join(tmpDir, 'anonymous', 'local', 'config', 'draft.txt'), 'utf8')).toBe('kept');
  });

  it('migrates a dashless account directory back to the real account uid', async () => {
    const users = await import('../../../src/main/features/users');
    fs.writeFileSync(
      path.join(tmpDir, 'users.json'),
      JSON.stringify({
        current_user_id: 'A0653F119F054A8B89CE0026D809EAFC',
        users: [{ user_id: 'A0653F119F054A8B89CE0026D809EAFC', created_at: '2026-01-01T00:00:00' }],
      }),
      'utf-8',
    );
    fs.mkdirSync(path.join(tmpDir, 'A0653F119F054A8B89CE0026D809EAFC', 'local', 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'A0653F119F054A8B89CE0026D809EAFC', 'local', 'config', 'account.json'),
      JSON.stringify({ user_id: 'A0653F11-9F05-4A8B-89CE-0026D809EAFC' }),
      'utf-8',
    );

    const res = users.migrateLegacyLoggedInLocalIdToAccountLocalId();

    expect(res.migrated).toBe(true);
    expect(res.from).toBe('A0653F119F054A8B89CE0026D809EAFC');
    expect(res.to).toBe('A0653F11-9F05-4A8B-89CE-0026D809EAFC');
    expect(fs.existsSync(path.join(tmpDir, 'A0653F119F054A8B89CE0026D809EAFC'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'A0653F11-9F05-4A8B-89CE-0026D809EAFC', 'local', 'config', 'account.json'))).toBe(true);
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'users.json'), 'utf-8'));
    expect(reg.current_user_id).toBe('A0653F11-9F05-4A8B-89CE-0026D809EAFC');
    expect(reg.users).toEqual([{ user_id: 'A0653F11-9F05-4A8B-89CE-0026D809EAFC', created_at: '2026-01-01T00:00:00' }]);
  });

  it('migrates a legacy logged-in 8-digit directory to account uid at startup', async () => {
    const users = await import('../../../src/main/features/users');
    const localSecrets = await import('../../../src/main/util/local-secret-store');
    fs.writeFileSync(
      path.join(tmpDir, 'users.json'),
      JSON.stringify({
        current_user_id: '12345678',
        users: [{ user_id: '12345678', created_at: '2026-01-01T00:00:00' }],
      }),
      'utf-8',
    );
    fs.mkdirSync(path.join(tmpDir, '12345678', 'local', 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '12345678', 'local', 'config', 'account.json'),
      JSON.stringify({ user_id: 'A0653F11-9F05-4A8B-89CE-0026D809EAFC' }),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(tmpDir, '12345678', 'local', 'config', 'auth-profiles.json'),
      localSecrets.encryptLocalSecret({
        namespace: 'auth.profiles',
        ownerId: '12345678',
        recordId: 'auth-profiles.json',
      }, JSON.stringify({
        version: 4,
        profiles: {
          'openai:default': {
            type: 'api_key',
            provider: 'openai',
            label: 'default',
            key: 'sk-legacy-local-owner-xxxxxxxx',
            createdAt: 1,
            lastUsed: 0,
          },
        },
        entries: [],
        searchProfiles: [],
        imageProfiles: [],
      })),
      'utf-8',
    );

    const res = users.migrateLegacyLoggedInLocalIdToAccountLocalId();

    expect(res.migrated).toBe(true);
    expect(res.from).toBe('12345678');
    expect(res.to).toBe('A0653F11-9F05-4A8B-89CE-0026D809EAFC');
    expect(fs.existsSync(path.join(tmpDir, '12345678'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'A0653F11-9F05-4A8B-89CE-0026D809EAFC', 'local', 'config', 'account.json'))).toBe(true);
    const reg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'users.json'), 'utf-8'));
    expect(reg.current_user_id).toBe('A0653F11-9F05-4A8B-89CE-0026D809EAFC');
    expect(reg.users).toEqual([{ user_id: 'A0653F11-9F05-4A8B-89CE-0026D809EAFC', created_at: '2026-01-01T00:00:00' }]);
    const raw = fs.readFileSync(path.join(tmpDir, 'A0653F11-9F05-4A8B-89CE-0026D809EAFC', 'local', 'config', 'auth-profiles.json'), 'utf8');
    const json = localSecrets.decryptLocalSecret({
      namespace: 'auth.profiles',
      ownerId: 'A0653F11-9F05-4A8B-89CE-0026D809EAFC',
      recordId: 'auth-profiles.json',
    }, raw);
    expect(json).toContain('sk-legacy-local-owner-xxxxxxxx');
  });
});
