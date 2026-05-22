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
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('marketplace reconcile', () => {
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
});
