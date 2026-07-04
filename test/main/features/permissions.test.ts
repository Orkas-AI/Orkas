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

function permissionsFile(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'config', 'permissions.json');
}

function legacyPermissionsFile(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'config', 'permissions.json');
}

describe('permissions › default state', () => {
  it('defaults to all_files_approval when no permissions.json exists', async () => {
    const perm = await import('../../../src/main/features/permissions');
    expect(perm.getLocalExecGranted()).toBe(true);
    expect(perm.getLocalExecMode()).toBe('all_files_approval');
    expect(perm.getLocalExecState()).toEqual({ mode: 'all_files_approval', granted: true });
    expect(perm.localAccessAllowsOutsideWorkspace()).toBe(true);
    expect(perm.localAccessRequiresSensitiveApproval()).toBe(true);
  });

  it('defaults to regular access when permissions.json is corrupt', async () => {
    fs.mkdirSync(path.dirname(permissionsFile()), { recursive: true });
    fs.writeFileSync(permissionsFile(), '{ this is not json');
    const perm = await import('../../../src/main/features/permissions');
    expect(perm.getLocalExecGranted()).toBe(true);
    expect(perm.getLocalExecMode()).toBe('all_files_approval');
  });

  it('defaults to regular access when localExec key is missing', async () => {
    fs.mkdirSync(path.dirname(permissionsFile()), { recursive: true });
    fs.writeFileSync(permissionsFile(), JSON.stringify({ other: 'thing' }));
    const perm = await import('../../../src/main/features/permissions');
    expect(perm.getLocalExecGranted()).toBe(true);
    expect(perm.getLocalExecMode()).toBe('all_files_approval');
  });
});

describe('permissions › legacy helpers', () => {
  it('grantLocalExec maps to all_files_auto and persists', async () => {
    const perm = await import('../../../src/main/features/permissions');
    const state = perm.grantLocalExec();
    expect(state.granted).toBe(true);
    expect(state.mode).toBe('all_files_auto');
    expect(typeof state.grantedAt).toBe('string');

    const parsed = JSON.parse(fs.readFileSync(permissionsFile(), 'utf8'));
    expect(parsed.localExec.mode).toBe('all_files_auto');
    expect(typeof parsed._field_updated_at.localExec).toBe('number');
  });

  it('revokeLocalExec maps to workspace_approval because off no longer exists', async () => {
    const perm = await import('../../../src/main/features/permissions');
    perm.grantLocalExec();
    const state = perm.revokeLocalExec();
    expect(state.granted).toBe(true);
    expect(state.mode).toBe('workspace_approval');
    expect(typeof state.revokedAt).toBe('string');
    expect(state.grantedAt).toBeUndefined();
  });

  it('leaves no .tmp file behind after writes', async () => {
    const perm = await import('../../../src/main/features/permissions');
    perm.grantLocalExec();
    const dir = path.dirname(permissionsFile());
    const stray = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    expect(stray).toEqual([]);
  });
});

describe('permissions › three-mode model', () => {
  it('legacy granted:true migrates to all_files_approval, not all_files_auto', async () => {
    fs.mkdirSync(path.dirname(permissionsFile()), { recursive: true });
    fs.writeFileSync(permissionsFile(), JSON.stringify({ localExec: { granted: true } }));
    const perm = await import('../../../src/main/features/permissions');
    expect(perm.getLocalExecMode()).toBe('all_files_approval');
    expect(perm.getLocalExecGranted()).toBe(true);
  });

  it('legacy granted:false migrates to workspace_approval', async () => {
    fs.mkdirSync(path.dirname(permissionsFile()), { recursive: true });
    fs.writeFileSync(permissionsFile(), JSON.stringify({ localExec: { granted: false } }));
    const perm = await import('../../../src/main/features/permissions');
    expect(perm.getLocalExecMode()).toBe('workspace_approval');
    expect(perm.getLocalExecGranted()).toBe(true);
  });

  it('legacy allow_all mode migrates to all_files_auto', async () => {
    fs.mkdirSync(path.dirname(permissionsFile()), { recursive: true });
    fs.writeFileSync(permissionsFile(), JSON.stringify({ localExec: { mode: 'allow_all' } }));
    const perm = await import('../../../src/main/features/permissions');
    expect(perm.getLocalExecMode()).toBe('all_files_auto');
  });

  it('legacy risk_prompt mode migrates to all_files_approval', async () => {
    fs.mkdirSync(path.dirname(permissionsFile()), { recursive: true });
    fs.writeFileSync(permissionsFile(), JSON.stringify({ localExec: { mode: 'risk_prompt' } }));
    const perm = await import('../../../src/main/features/permissions');
    expect(perm.getLocalExecMode()).toBe('all_files_approval');
  });

  it('migrates the old local-only permissions file into cloud config', async () => {
    fs.mkdirSync(path.dirname(legacyPermissionsFile()), { recursive: true });
    fs.writeFileSync(legacyPermissionsFile(), JSON.stringify({ localExec: { granted: false } }));

    const perm = await import('../../../src/main/features/permissions');
    expect(perm.getLocalExecMode()).toBe('workspace_approval');
    expect(fs.existsSync(permissionsFile())).toBe(true);
    expect(fs.existsSync(legacyPermissionsFile())).toBe(false);

    const parsed = JSON.parse(fs.readFileSync(permissionsFile(), 'utf8'));
    expect(parsed.localExec.mode).toBe('workspace_approval');
  });

  it('setLocalExecMode persists each new mode and derives helpers', async () => {
    const perm = await import('../../../src/main/features/permissions');

    let s = perm.setLocalExecMode('workspace_approval');
    expect(s.mode).toBe('workspace_approval');
    expect(s.granted).toBe(true);
    expect(perm.localAccessAllowsOutsideWorkspace()).toBe(false);
    expect(perm.localAccessRequiresSensitiveApproval()).toBe(true);

    s = perm.setLocalExecMode('all_files_approval');
    expect(s.mode).toBe('all_files_approval');
    expect(perm.localAccessAllowsOutsideWorkspace()).toBe(true);
    expect(perm.localAccessRequiresSensitiveApproval()).toBe(true);

    s = perm.setLocalExecMode('all_files_auto');
    expect(s.mode).toBe('all_files_auto');
    expect(perm.localAccessAllowsOutsideWorkspace()).toBe(true);
    expect(perm.localAccessRequiresSensitiveApproval()).toBe(false);

    const parsed = JSON.parse(fs.readFileSync(permissionsFile(), 'utf8'));
    expect(parsed.localExec.mode).toBe('all_files_auto');
  });

  it('rejects an invalid mode', async () => {
    const perm = await import('../../../src/main/features/permissions');
    expect(() => perm.setLocalExecMode('bogus' as never)).toThrow();
  });
});
