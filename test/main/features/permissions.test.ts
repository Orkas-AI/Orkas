import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-perm-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Permissions file moved to `<uid>/local/config/permissions.json`.
function permissionsFile(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'config', 'permissions.json');
}

describe('permissions › default state', () => {
  it('defaults to granted when no permissions.json exists', async () => {
    const perm = await import('../../../src/main/features/permissions');
    expect(perm.getLocalExecGranted()).toBe(true);
    expect(perm.getLocalExecState()).toEqual({ granted: true });
  });

  it('defaults to granted when permissions.json is corrupt', async () => {
    fs.mkdirSync(path.dirname(permissionsFile()), { recursive: true });
    fs.writeFileSync(permissionsFile(), '{ this is not json');
    const perm = await import('../../../src/main/features/permissions');
    expect(perm.getLocalExecGranted()).toBe(true);
  });

  it('defaults to granted when localExec key is missing', async () => {
    fs.mkdirSync(path.dirname(permissionsFile()), { recursive: true });
    fs.writeFileSync(permissionsFile(), JSON.stringify({ other: 'thing' }));
    const perm = await import('../../../src/main/features/permissions');
    expect(perm.getLocalExecGranted()).toBe(true);
  });

  it('defaults to granted when granted field is non-boolean (defensive parse)', async () => {
    fs.mkdirSync(path.dirname(permissionsFile()), { recursive: true });
    fs.writeFileSync(
      permissionsFile(),
      JSON.stringify({ localExec: { granted: 'yes' } }),
    );
    const perm = await import('../../../src/main/features/permissions');
    expect(perm.getLocalExecGranted()).toBe(true);
  });
});

describe('permissions › grantLocalExec', () => {
  it('flips the flag and populates grantedAt', async () => {
    const perm = await import('../../../src/main/features/permissions');
    const state = perm.grantLocalExec();
    expect(state.granted).toBe(true);
    expect(typeof state.grantedAt).toBe('string');
    expect(state.grantedAt!.length).toBeGreaterThan(0);
  });

  it('is visible to a subsequent read', async () => {
    const perm = await import('../../../src/main/features/permissions');
    perm.grantLocalExec();
    expect(perm.getLocalExecGranted()).toBe(true);
  });

  it('persists to disk under data/config/permissions.json', async () => {
    const perm = await import('../../../src/main/features/permissions');
    perm.grantLocalExec();
    expect(fs.existsSync(permissionsFile())).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(permissionsFile(), 'utf8'));
    expect(parsed.localExec.granted).toBe(true);
  });

  it('leaves no .tmp file behind (atomic write)', async () => {
    const perm = await import('../../../src/main/features/permissions');
    perm.grantLocalExec();
    const dir = path.dirname(permissionsFile());
    const stray = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    expect(stray).toEqual([]);
  });
});

describe('permissions › revokeLocalExec', () => {
  it('clears the flag and populates revokedAt', async () => {
    const perm = await import('../../../src/main/features/permissions');
    perm.grantLocalExec();
    const state = perm.revokeLocalExec();
    expect(state.granted).toBe(false);
    expect(typeof state.revokedAt).toBe('string');
  });

  it('clears grantedAt so intent is "latest wins"', async () => {
    const perm = await import('../../../src/main/features/permissions');
    perm.grantLocalExec();
    const state = perm.revokeLocalExec();
    expect(state.grantedAt).toBeUndefined();
  });

  it('subsequent reads see the revoke', async () => {
    const perm = await import('../../../src/main/features/permissions');
    perm.grantLocalExec();
    perm.revokeLocalExec();
    expect(perm.getLocalExecGranted()).toBe(false);
  });
});

describe('permissions › grant→revoke→grant cycle', () => {
  it('overwrites revokedAt with fresh grantedAt on re-grant', async () => {
    const perm = await import('../../../src/main/features/permissions');
    perm.grantLocalExec();
    perm.revokeLocalExec();
    const state = perm.grantLocalExec();
    expect(state.granted).toBe(true);
    expect(typeof state.grantedAt).toBe('string');
    expect(state.revokedAt).toBeUndefined();
  });
});
