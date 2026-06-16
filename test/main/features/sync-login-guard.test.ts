import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const syncEngineCtor = vi.hoisted(() => vi.fn());

vi.mock('../../../src/main/features/sync/engine', () => ({
  SyncEngine: syncEngineCtor,
}));

let tmpDir: string;
let prevWs: string | undefined;
let prevAuth: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-sync-login-guard-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevAuth = process.env.CORE_AGENT_AUTH_DIR;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  delete process.env.CORE_AGENT_AUTH_DIR;
  vi.resetModules();
  syncEngineCtor.mockReset();
  syncEngineCtor.mockImplementation(() => ({
    onStatus: vi.fn(() => () => {}),
    onUsage: vi.fn(() => () => {}),
    onDataChanged: vi.fn(() => () => {}),
    syncNow: vi.fn(async () => {}),
    refreshUsage: vi.fn(async () => {}),
    teardown: vi.fn(),
  }));
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevAuth === undefined) delete process.env.CORE_AGENT_AUTH_DIR;
  else process.env.CORE_AGENT_AUTH_DIR = prevAuth;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('sync login guard', () => {
  it('does not start an engine when the requested account uid is no longer active', async () => {
    const users = await import('../../../src/main/features/users');
    const tokenStore = await import('../../../src/main/features/account/token_store');
    const localIndex = await import('../../../src/main/features/sync/local_index');
    const sync = await import('../../../src/main/features/sync');

    users.activateUser('account-user-1');
    tokenStore.setSession({ user_id: 'account-user-1', session_id: 'sid-secret' });
    localIndex.setStateEnabled('account-user-1', true);

    users.switchToAnonymousLocalId();
    await sync.init('account-user-1', 'account-user-1');

    expect(syncEngineCtor).not.toHaveBeenCalled();
    expect(sync.isRunning()).toBe(false);
  });
});
