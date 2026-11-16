import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

let tmpDir: string;
let prevWs: string | undefined;

// Allow readers while reproducing Windows' refusal to replace an open file.
async function holdWindowsManifest(file: string): Promise<{ unlock: () => void; release: () => Promise<void> }> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$stream = [IO.File]::Open($env:ORKAS_TEST_LOCK_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
    "try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $stream.Dispose() }",
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ORKAS_TEST_LOCK_FILE: file }, stdio: 'pipe', windowsHide: true,
  });
  let stdout = '', stderr = '';
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows manifest lock startup timed out')); }, 10_000);
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.trim() === 'locked') { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => {
      clearTimeout(timer);
      if (stdout.trim() !== 'locked') reject(new Error(`Windows manifest lock failed: ${stderr}`));
    });
  });
  const unlock = () => { if (!child.stdin.writableEnded) child.stdin.end(); };
  return { unlock, release: async () => {
    unlock();
    const timer = setTimeout(() => child.kill(), 5_000);
    try { await closed; } finally { clearTimeout(timer); }
    expect(child.exitCode).toBe(0);
    expect(stdout.trim()).toBe('locked');
    expect(stderr).toBe('');
  } };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-marketplace-installs-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('marketplace install manifest', () => {
  it.runIf(process.platform === 'win32').each(['agent', 'skill'] as const)(
    'publishes queued %s installs atomically after a Windows reader releases its file lock', async kind => {
      const installs = await import('../../../src/main/features/marketplace_installs');
      const add = kind === 'agent' ? installs.addAgentInstall : installs.addSkillInstall;
      const bucket = kind === 'agent' ? 'agents' : 'skills';
      const row = { id: 'existing', version: '1.0.0', published_at: 1, agent_json_url: '', bundle_url: '' };
      await add('u1', row);
      const file = path.join(tmpDir, 'u1/cloud/marketplace/installs.json');
      const before = fs.readFileSync(file, 'utf8');
      const lock = await holdWindowsManifest(file);
      const started = performance.now();
      const unlock = setTimeout(lock.unlock, 100);
      try {
        const pending = Promise.allSettled([
          add('u1', { ...row, version: '2.0.0' }), add('u1', { ...row, id: 'queued' }),
        ]);
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
        const results = await pending;
        expect(results.map(result => result.status === 'fulfilled' ? result.value : result.reason.code)).toEqual([true, true]);
        const current = await installs.readInstalls('u1');
        expect(current[bucket].map(item => [item.id, item.version])).toEqual([
          ['existing', '2.0.0'], ['queued', '1.0.0'],
        ]);
      } finally {
        console.info('Windows manifest publication duration', { kind, duration_ms: performance.now() - started });
        clearTimeout(unlock);
        await lock.release();
      }
    },
  );

  it.runIf(process.platform === 'win32')('preserves the old manifest after a persistent Windows lock and allows the next install', async () => {
    const installs = await import('../../../src/main/features/marketplace_installs');
    const row = { id: 'existing', version: '1.0.0', published_at: 1, agent_json_url: '' };
    await installs.addAgentInstall('u1', row);
    const file = path.join(tmpDir, 'u1/cloud/marketplace/installs.json');
    const before = fs.readFileSync(file, 'utf8');
    const lock = await holdWindowsManifest(file);
    try {
      await expect(installs.addAgentInstall('u1', { ...row, id: 'rejected' })).rejects.toMatchObject({ code: 'EPERM' });
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally { await lock.release(); }
    await installs.addAgentInstall('u1', { ...row, id: 'next' });
    expect((await installs.readInstalls('u1')).agents.map(item => item.id)).toEqual(['existing', 'next']);
  });

  it('records uninstall tombstones and clears them on reinstall', async () => {
    const installs = await import('../../../src/main/features/marketplace_installs');

    await installs.addAgentInstall('u1', {
      id: 'agent-a',
      version: '1.0.0',
      published_at: 1,
      agent_json_url: 'https://cdn.test/a.json',
    });

    await expect(installs.removeAgentInstall('u1', 'agent-a')).resolves.toBe(true);
    const removed = await installs.readInstalls('u1');
    expect(removed.agents).toEqual([]);
    expect(removed._deleted_at?.agents?.['agent-a']).toEqual(expect.any(Number));

    await installs.addAgentInstall('u1', {
      id: 'agent-a',
      version: '1.0.0',
      published_at: 1,
      agent_json_url: 'https://cdn.test/a.json',
    });
    const reinstalled = await installs.readInstalls('u1');
    expect(reinstalled.agents).toHaveLength(1);
    expect(reinstalled._deleted_at?.agents?.['agent-a']).toBeUndefined();
  });

  it('retains explicit uninstall intent beyond the file retention window', async () => {
    const dir = path.join(tmpDir, 'u1', 'cloud', 'marketplace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'installs.json'), JSON.stringify({
      version: 1,
      agents: [],
      skills: [],
      _deleted_at: {
        agents: {
          'agent-old': Date.now() - 31 * 24 * 60 * 60 * 1000,
          'agent-recent': Date.now(),
        },
      },
    }, null, 2), 'utf8');

    const installs = await import('../../../src/main/features/marketplace_installs');
    const manifest = await installs.readInstalls('u1');

    expect(manifest._deleted_at?.agents).toEqual({
      'agent-old': expect.any(Number),
      'agent-recent': expect.any(Number),
    });
  });

  it.each(['agent', 'skill'] as const)('records local-only %s uninstall and rejects stale background writes', async (kind) => {
    const installs = await import('../../../src/main/features/marketplace_installs');
    const add = kind === 'agent' ? installs.addAgentInstall : installs.addSkillInstall;
    const remove = kind === 'agent' ? installs.removeAgentInstall : installs.removeSkillInstall;
    const bucket = kind === 'agent' ? 'agents' : 'skills';
    const row = { id: 'item', version: '1.0.0', published_at: 1, agent_json_url: 'https://example.test/a', bundle_url: 'https://example.test/s' };
    await remove('u1', 'item');
    const removed = await installs.readInstalls('u1');
    const deletedAt = removed._deleted_at?.[bucket]?.item;
    expect(deletedAt).toEqual(expect.any(Number));
    for (const mode of ['update', 'seed'] as const) {
      expect(await add('u1', { ...row, updated_at: Date.now() + 1000 }, { mode })).toBe(false);
      expect(await installs.readInstalls('u1')).toEqual(removed);
    }
    await add('u1', row);
    const restored = await installs.readInstalls('u1');
    expect(restored[bucket]).toHaveLength(1);
    expect(restored[bucket][0].installed_at).toBeGreaterThan(deletedAt!);
    expect(restored._deleted_at?.[bucket]?.item).toBeUndefined();
  });

  it('does not let a stale bulk manifest write erase a concurrent uninstall', async () => {
    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.addAgentInstall('u1', { id: 'item', version: '1.0.0', published_at: 1, agent_json_url: '' });
    const stale = await installs.readInstalls('u1');
    await installs.removeAgentInstall('u1', 'item');
    const removed = await installs.readInstalls('u1');
    stale.agents[0].updated_at = Date.now() + 1000;
    await installs.writeInstalls('u1', stale);
    expect(await installs.readInstalls('u1')).toEqual(removed);
  });

  it('preserves a deliberate reinstall when an older bulk snapshot finishes later', async () => {
    const installs = await import('../../../src/main/features/marketplace_installs');
    const row = { id: 'item', version: '1.0.0', published_at: 1, agent_json_url: '' };
    await installs.addAgentInstall('u1', row);
    await installs.removeAgentInstall('u1', 'item');
    const stale = await installs.readInstalls('u1');
    await installs.addAgentInstall('u1', row);
    const reinstalled = await installs.readInstalls('u1');
    await installs.writeInstalls('u1', stale);
    expect(await installs.readInstalls('u1')).toEqual(reinstalled);
  });

  it('does not share mutable empty manifests between accounts', async () => {
    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.addAgentInstall('u1', { id: 'item', version: '1.0.0', published_at: 1, agent_json_url: '' });
    expect(await installs.readInstalls('u2')).toEqual({ version: 1, agents: [], skills: [] });
  });

  it('drops unsafe synced ids and rejects unsafe local manifest mutations', async () => {
    const dir = path.join(tmpDir, 'u1', 'cloud', 'marketplace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'installs.json'), JSON.stringify({
      version: 1,
      agents: [{
        id: '../../config',
        version: '1.0.0',
        published_at: 1,
        agent_json_url: 'https://cdn.test/a.json',
        installed_at: 1,
      }],
      skills: [{
        id: '../../../outside',
        version: '1.0.0',
        published_at: 1,
        bundle_url: 'https://cdn.test/s.zip',
        installed_at: 1,
      }],
      _deleted_at: {
        agents: { '../../config': Date.now() },
        skills: { 'safe-skill': Date.now() },
      },
    }), 'utf8');

    const installs = await import('../../../src/main/features/marketplace_installs');
    await expect(installs.readInstalls('u1')).resolves.toMatchObject({
      agents: [],
      skills: [],
      _deleted_at: { skills: { 'safe-skill': expect.any(Number) } },
    });
    await expect(installs.addSkillInstall('u1', {
      id: '../../config',
      version: '1.0.0',
      published_at: 1,
      bundle_url: 'https://cdn.test/s.zip',
    })).rejects.toThrow('invalid marketplace id');
    await expect(installs.removeAgentInstall('u1', '../agents')).rejects.toThrow(
      'invalid marketplace id',
    );
  });
});

describe('bulk snapshot and explicit install ordering', () => {
  it.each(['agent', 'skill'] as const)('preserves a concurrent new %s absent from the background snapshot', async (kind) => {
    const installs = await import('../../../src/main/features/marketplace_installs');
    const stale = await installs.readInstalls('u1');
    const add = kind === 'agent' ? installs.addAgentInstall : installs.addSkillInstall;
    await add('u1', { id: 'new-item', version: '2.0.0', published_at: 2, agent_json_url: '', bundle_url: '' });
    const installed = await installs.readInstalls('u1');
    await installs.writeInstalls('u1', stale);
    expect(await installs.readInstalls('u1')).toEqual(installed);
  });
  it.each(['agent', 'skill'] as const)('preserves the version and content of a newer explicit %s reinstall', async (kind) => {
    const installs = await import('../../../src/main/features/marketplace_installs');
    const add = kind === 'agent' ? installs.addAgentInstall : installs.addSkillInstall;
    const remove = kind === 'agent' ? installs.removeAgentInstall : installs.removeSkillInstall;
    const row = { id: 'item', version: '1.0.0', published_at: 1, agent_json_url: 'old', bundle_url: 'old' };
    await add('u1', row);
    const stale = await installs.readInstalls('u1');
    await remove('u1', 'item');
    await add('u1', { ...row, version: '2.0.0', published_at: 2, agent_json_url: 'new', bundle_url: 'new' });
    const installed = await installs.readInstalls('u1');
    await installs.writeInstalls('u1', stale);
    expect(await installs.readInstalls('u1')).toEqual(installed);
  });
});

// ID migration owns only the installation seen before its asynchronous work.
it.each([false, true])('removes a migrated snapshot ID only while its install clock is unchanged (reinstalled=%s)', async (reinstalled) => {
  const installs = await import('../../../src/main/features/marketplace_installs');
  const row = { id: 'old-id', version: '1.0.0', published_at: 1, agent_json_url: '' };
  await installs.addAgentInstall('u1', row);
  const snapshot = await installs.readInstalls('u1');
  const clock = snapshot.agents[0].installed_at;
  snapshot.agents[0].id = 'new-id';
  if (reinstalled) {
    await installs.removeAgentInstall('u1', 'old-id');
    await installs.addAgentInstall('u1', { ...row, version: '2.0.0' });
  }
  await installs.writeInstalls('u1', snapshot, { agents: { 'old-id': clock } });
  const current = await installs.readInstalls('u1');
  expect(current.agents.some((item) => item.id === 'new-id')).toBe(true);
  expect(current.agents.find((item) => item.id === 'old-id')?.version).toBe(reinstalled ? '2.0.0' : undefined);
});


// These fault-controlled filesystem outcomes execute the Windows publication
// branch on any host. Native Windows sharing/locking is checked separately above.
it.each(['agent', 'skill'] as const)('preserves complete bytes through transient Windows %s publication locks and queued installs', async kind => {
  const installs = await import('../../../src/main/features/marketplace_installs');
  const add = kind === 'agent' ? installs.addAgentInstall : installs.addSkillInstall;
  const bucket = kind === 'agent' ? 'agents' : 'skills';
  const row = { id: 'existing', version: '1.0.0', published_at: 1, agent_json_url: '', bundle_url: '' };
  await add('u1', row);
  const file = path.join(tmpDir, 'u1/cloud/marketplace/installs.json');
  const before = fs.readFileSync(file);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const rename = fs.promises.rename.bind(fs.promises);
  let blocked = 2;
  let timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 0);
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === file && blocked-- > 0) {
      expect(fs.readFileSync(file)).toEqual(before);
      throw Object.assign(new Error('fixture reader holds destination'), { code: 'EPERM' });
    }
    await rename(from, to);
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    const results = await Promise.allSettled([add('u1', { ...row, version: '2.0.0' }), add('u1', { ...row, id: 'queued' })]);
    expect(results.map(result => result.status === 'fulfilled' ? result.value : result.reason.code)).toEqual([true, true]);
    const published = await installs.readInstalls('u1');
    expect(published[bucket].map(item => [item.id, item.version])).toEqual([['existing', '2.0.0'], ['queued', '1.0.0']]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))[bucket]).toEqual(published[bucket]);
    expect(timerRan).toBe(true);
  } finally {
    clearTimeout(timer);
    Object.defineProperty(process, 'platform', platform);
    vi.restoreAllMocks(); syncBuiltinESMExports();
  }
});

it('retains the last complete manifest after a persistent Windows publication fault and permits explicit recovery', async () => {
  const installs = await import('../../../src/main/features/marketplace_installs');
  const row = { id: 'existing', version: '1.0.0', published_at: 1, agent_json_url: '' };
  await installs.addAgentInstall('u1', row);
  const file = path.join(tmpDir, 'u1/cloud/marketplace/installs.json');
  const before = fs.readFileSync(file);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const rename = fs.promises.rename.bind(fs.promises);
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === file) throw Object.assign(new Error('fixture persistent reader'), { code: 'EBUSY' });
    await rename(from, to);
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    await expect(installs.addAgentInstall('u1', { ...row, id: 'refused' })).rejects.toMatchObject({ code: 'EBUSY' });
    expect(fs.readFileSync(file)).toEqual(before);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    vi.restoreAllMocks(); syncBuiltinESMExports();
  }
  await installs.addAgentInstall('u1', { ...row, id: 'recovered' });
  expect((await installs.readInstalls('u1')).agents.map(item => item.id)).toEqual(['existing', 'recovered']);
});
