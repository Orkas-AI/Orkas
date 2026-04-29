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
      path.join(tmpDir, 'u1', 'local', 'contexts_tmp'),
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
