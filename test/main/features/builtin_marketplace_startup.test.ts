import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const postJsonMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/main/features/marketplace', () => ({
  postJson: postJsonMock,
}));

let tmpDir: string;
let prevWs: string | undefined;
let prevBuiltin: string | undefined;

const TEST_AGENT_ID = '222222222222';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-builtin-marketplace-startup-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevBuiltin = process.env.ORKAS_BUILTIN_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  process.env.ORKAS_BUILTIN_ROOT = path.join(tmpDir, 'builtin');
  postJsonMock.mockReset();
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevBuiltin === undefined) delete process.env.ORKAS_BUILTIN_ROOT;
  else process.env.ORKAS_BUILTIN_ROOT = prevBuiltin;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

function writeBuiltinAgent(id: string, agentJson: Record<string, unknown>): void {
  const root = path.join(tmpDir, 'builtin', 'marketplace', 'agents', id);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'agent.json'), JSON.stringify({ agent_id: id, ...agentJson }, null, 2), 'utf8');
}

describe('builtin marketplace startup seed', () => {
  it('runs for the active local user without requiring account verification', async () => {
    writeBuiltinAgent(TEST_AGENT_ID, {
      version: '1.0.0',
      updated_at: '2026-07-08T00:00:00.000Z',
      name: 'VideoStudio',
      description: 'Creates videos',
      category: 'creation',
    });

    const users = await import('../../../src/main/features/users');
    const paths = await import('../../../src/main/paths');
    const startup = await import('../../../src/main/features/builtin_marketplace_startup');
    users.activateUser('u1');

    const changed: unknown[] = [];
    await expect(startup.seedBuiltinMarketplaceForActiveUser({
      reason: 'test',
      onChanged: (result) => changed.push(result),
    })).resolves.toMatchObject({
      seeded_agents: 1,
      manifest_agents: 1,
    });

    expect(fs.existsSync(path.join(paths.userMarketplaceAgentDir('u1', TEST_AGENT_ID), 'agent.json'))).toBe(true);
    expect(changed).toHaveLength(1);
  });

  it('returns null when boot has not activated a user yet', async () => {
    const startup = await import('../../../src/main/features/builtin_marketplace_startup');

    await expect(startup.seedBuiltinMarketplaceForActiveUser({ reason: 'test' })).resolves.toBeNull();
  });
});
