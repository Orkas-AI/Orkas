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
});
