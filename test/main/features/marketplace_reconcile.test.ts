import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const postJsonMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/main/features/marketplace', () => ({
  postJson: postJsonMock,
  extractBundleSafely: vi.fn(),
}));

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-marketplace-reconcile-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  postJsonMock.mockReset();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('marketplace reconcile', () => {
  function writeLocalSkill(id: string, meta: Record<string, unknown>): string {
    const dir = path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: local-skill\n---\n', 'utf8');
    fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify(meta, null, 2), 'utf8');
    return dir;
  }

  function writeManifest(data: Record<string, unknown>): void {
    const dir = path.join(tmpDir, 'u1', 'cloud', 'marketplace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'installs.json'), JSON.stringify(data, null, 2), 'utf8');
  }

  it('marks an installed item stale when updated_at changes even if version and published_at do not', async () => {
    postJsonMock.mockImplementation(async (p: string) => {
      if (p === '/marketplace/agents/list') {
        return {
          list: [{
            id: 'agent1',
            version: '1.0.0',
            published_at: 100,
            updated_at: 200,
          }],
          total: 1,
        };
      }
      if (p === '/marketplace/skills/list') return { list: [], total: 0 };
      throw new Error(`unexpected path ${p}`);
    });

    const installs = await import('../../../src/main/features/marketplace_installs');
    await installs.addAgentInstall('u1', {
      id: 'agent1',
      version: '1.0.0',
      published_at: 100,
      agent_json_url: 'https://example.test/agent.json',
      create_uid: '0',
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.checkServerUpdatesForInstalls('u1');

    expect(result).toEqual({ updated_agents: 1, updated_skills: 0 });
    const manifest = await installs.readInstalls('u1');
    expect(manifest.agents[0]).toMatchObject({
      id: 'agent1',
      version: '1.0.0',
      published_at: 100,
      updated_at: 200,
      agent_json_url: 'https://example.test/agent.json',
    });
  });

  it('restores a local-only new skill install into the cloud manifest', async () => {
    writeLocalSkill('skill-local', {
      version: '1.0.0',
      published_at: 100,
      updated_at: 100,
      bundle_url: 'https://example.test/skill.zip',
      installed_at: 300,
      create_uid: '0',
      status: 'approved',
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.reconcileInstalls('u1') as any;

    expect(result.restored_skills).toBe(1);
    const installs = await import('../../../src/main/features/marketplace_installs');
    const manifest = await installs.readInstalls('u1');
    expect(manifest.skills).toEqual([
      expect.objectContaining({
        id: 'skill-local',
        bundle_url: 'https://example.test/skill.zip',
        installed_at: 300,
        status: 'approved',
      }),
    ]);
  });

  it('prunes a local-only skill when a newer manifest tombstone exists', async () => {
    const dir = writeLocalSkill('skill-deleted', {
      version: '1.0.0',
      published_at: 100,
      bundle_url: 'https://example.test/skill.zip',
      installed_at: 300,
    });
    writeManifest({
      version: 1,
      agents: [],
      skills: [],
      _deleted_at: { skills: { 'skill-deleted': 400 } },
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.reconcileInstalls('u1') as any;

    expect(result.pruned_skills).toBe(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('patches local install metadata from the manifest without re-downloading content', async () => {
    writeLocalSkill('skill-meta', {
      version: '1.0.0',
      published_at: 100,
      updated_at: 100,
      bundle_url: 'https://example.test/skill.zip',
      installed_at: 300,
      create_uid: '0',
    });
    writeManifest({
      version: 1,
      agents: [],
      skills: [{
        id: 'skill-meta',
        version: '1.0.0',
        published_at: 100,
        updated_at: 100,
        bundle_url: 'https://example.test/skill.zip',
        installed_at: 300,
        create_uid: '0',
        status: 'approved',
      }],
    });

    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const result = await reconcile.reconcileInstalls('u1') as any;

    expect(result.patched_skills).toBe(1);
    const meta = JSON.parse(fs.readFileSync(path.join(tmpDir, 'u1', 'local', 'marketplace', 'skills', 'skill-meta', '_install.json'), 'utf8'));
    expect(meta.status).toBe('approved');
  });
});
