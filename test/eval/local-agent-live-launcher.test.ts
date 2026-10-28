import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { runLocalAgentLive } from '../../scripts/run-local-agents-live.mjs';
import { localAgentLiveArguments } from '../../scripts/local-agent-live-electron-main.mts';

describe('real CLI acceptance host runtime', () => {
  it('preserves the selected cohort and budget across Electron argument framing', () => {
    const args = ['--benchmark', '--no-install', '--agents', 'opencode', '--k', '2'];
    expect(localAgentLiveArguments(args)).toEqual(args);
    expect(localAgentLiveArguments([path.join(process.cwd(), 'scripts/local-agent-live-electron-entry.mjs'), ...args])).toEqual(args);
    expect(localAgentLiveArguments(['/unrelated/entry.mjs', ...args])).toEqual(['/unrelated/entry.mjs', ...args]);
  });
  it('uses the production Electron runtime and scoped log acceptance for every live entry', async () => {
    const launch = vi.fn(async () => 78);
    const argv = ['--benchmark', '--no-install', '--agents', 'hermes,opencode', '--k', '2'];
    expect(await runLocalAgentLive(argv, { launch, env: {} })).toBe(78);
    expect(launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      argv, disableGpu: true,
      electronEntry: path.join(process.cwd(), 'scripts/local-agent-live-electron-entry.mjs'),
      runner: path.join(process.cwd(), 'scripts/local-agent-live-electron-main.mts'),
      reportsDir: path.join(process.cwd(), 'test-results/local-agents'),
    }));
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    for (const key of ['test:local-agents:live', 'test:local-agents:lifecycle', 'test:local-agents:prepare', 'benchmark:local-agents']) {
      expect(pkg.scripts[key], key).toContain('node scripts/run-local-agents-live.mjs');
      expect(pkg.scripts[key], key).not.toContain('tsx ');
    }
  });

  it('shows usage without preparing dependencies, launching Electron or consuming model quota', async () => {
    const launch = vi.fn();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await runLocalAgentLive(['--help'], { launch, env: {} })).toBe(0);
      expect(launch).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    } finally { write.mockRestore(); }
  });

  it('rejects an invalid cohort or unsupported interruption before preparation', async () => {
    const launch = vi.fn();
    for (const args of [['--agents', 'unknown'], ['--lifecycle', '--no-install', '--lifecycle-fault', 'idle']]) {
      await expect(runLocalAgentLive(args, { launch, env: {} })).rejects.toThrow();
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects a direct plain-Node invocation before discovery or model work', () => {
    const node = process.env.ORKAS_TEST_NODE;
    if (!node) throw new Error('The test launcher must provide a standalone Node runtime');
    const result = spawnSync(node, ['--import', 'tsx', 'scripts/test-local-agents-live.ts', '--no-install', '--agents', 'codex'], {
      cwd: process.cwd(), env: { ...process.env }, encoding: 'utf8', timeout: 15_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires Electron');
    expect(result.stdout).not.toContain('[local-agent-live] prepared:');
  });
});
