import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;

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
