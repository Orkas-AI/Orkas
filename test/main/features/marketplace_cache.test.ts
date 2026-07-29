import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_UID = 'marketplace-cache-owner';
let tempDir = '';
let previousWorkspaceRoot: string | undefined;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-marketplace-cache-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tempDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('marketplace content cache', () => {
  it('uses version plus updated_at freshness and replaces stale agent files wholesale', async () => {
    const cache = await import('../../../src/main/features/marketplace_cache');
    const paths = await import('../../../src/main/paths');
    const freshness = { version: '1.0.0', published_at: 100, updated_at: 200 };

    await cache.writeAgentCache('agent-safe', { name: 'First' }, freshness);
    const agentDir = paths.marketplaceCacheAgentDir(TEST_UID, 'agent-safe');
    fs.writeFileSync(path.join(agentDir, 'stale.txt'), 'must disappear');
    await cache.writeAgentCache('agent-safe', { name: 'Second' }, freshness);

    await expect(cache.isCacheFresh('agent', 'agent-safe', freshness)).resolves.toBe(true);
    await expect(cache.isCacheFresh('agent', 'agent-safe', {
      ...freshness,
      updated_at: 201,
    })).resolves.toBe(false);
    await expect(cache.readAgentCache('agent-safe')).resolves.toEqual({ name: 'Second' });
    expect(fs.existsSync(path.join(agentDir, 'stale.txt'))).toBe(false);
  });

  it('never reads neighboring config files through a crafted id or cache symlink', async () => {
    const cache = await import('../../../src/main/features/marketplace_cache');
    const paths = await import('../../../src/main/paths');
    const configFile = path.join(paths.userLocalConfigDir(TEST_UID), 'private.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, 'must-not-cross-marketplace-cache', 'utf8');

    await cache.writeSkillCache('skill-safe', async (dir) => {
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Safe');
      try {
        fs.symlinkSync(configFile, path.join(dir, 'linked-secret.txt'));
      } catch {
        // Windows without symlink privileges still exercises the crafted-id boundary.
      }
    }, { version: '1.0.0', published_at: 100 });

    await expect(cache.readSkillCacheFile('../../../config', 'private.json')).resolves.toBeNull();
    await expect(cache.readSkillCacheFile('skill-safe', 'linked-secret.txt')).resolves.toBeNull();
    expect(await cache.listSkillCacheFiles('skill-safe')).toEqual([
      { path: 'SKILL.md', bytes: 6 },
    ]);
  });

  it('keeps queued listing writes bound to the initiating account', async () => {
    const cache = await import('../../../src/main/features/marketplace_cache');
    const users = await import('../../../src/main/features/users');

    const pending = cache.setListingsCache({
      agents: { items: [{ id: 'agent-a' }], ts: 100 },
    });
    users.activateUser('marketplace-cache-other');
    await pending;

    await expect(cache.getListingsCache()).resolves.toEqual({ version: 4, entries: {} });
    users.activateUser(TEST_UID);
    await expect(cache.getListingsCache()).resolves.toMatchObject({
      version: 4,
      entries: { agents: { items: [{ id: 'agent-a' }], ts: 100 } },
    });
  });

  it('sweeps expired and half-written entries without touching another account', async () => {
    const cache = await import('../../../src/main/features/marketplace_cache');
    const paths = await import('../../../src/main/paths');
    const users = await import('../../../src/main/features/users');
    const oldNow = Date.now() - (8 * 24 * 60 * 60 * 1_000);

    await cache.writeAgentCache('expired-agent', { name: 'Old' }, {
      version: '1.0.0',
      published_at: 100,
    });
    const expiredDir = paths.marketplaceCacheAgentDir(TEST_UID, 'expired-agent');
    const metaFile = path.join(expiredDir, '_cache.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, last_used_at: oldNow }));
    const halfWritten = paths.marketplaceCacheSkillDir(TEST_UID, 'half-written');
    fs.mkdirSync(halfWritten, { recursive: true });
    fs.writeFileSync(path.join(halfWritten, 'partial.bin'), 'partial');

    users.activateUser('marketplace-cache-other');
    await cache.writeAgentCache('other-agent', { name: 'Keep' }, {
      version: '1.0.0',
      published_at: 100,
    });
    const otherDir = paths.marketplaceCacheAgentDir('marketplace-cache-other', 'other-agent');
    users.activateUser(TEST_UID);

    await expect(cache.sweepIfNeeded()).resolves.toBeGreaterThan(0);
    expect(fs.existsSync(expiredDir)).toBe(false);
    expect(fs.existsSync(halfWritten)).toBe(false);
    expect(fs.existsSync(otherDir)).toBe(true);
  });
});
