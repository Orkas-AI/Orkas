import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

// Exercise the package entry and a real Playwright worker, including failure
// propagation. No Electron app or external service is needed for this boundary.
describe('E2E launcher output contract', () => {
  it.each([
    { mode: 'plain', fail: false },
    { mode: 'color', fail: false },
    { mode: 'plain', fail: true },
  ])('preserves $mode output and test failure=$fail', ({ mode, fail }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orkas-e2e-launcher-'));
    try {
      const config = path.join(root, 'playwright.config.cjs');
      writeFileSync(config, `module.exports = { testDir: __dirname, testMatch: '*.spec.cjs', workers: 1, retries: 0, reporter: 'line', outputDir: ${JSON.stringify(path.join(root, 'results'))} };`);
      writeFileSync(path.join(root, 'output.spec.cjs'), `
        const { test, expect } = require(${JSON.stringify(require.resolve('@playwright/test'))});
        test('worker output and failure propagation', () => {
          console.log('worker-output-visible', { active: true });
          console.warn('expected-warning-visible');
          expect(${JSON.stringify(fail)}).toBe(false);
        });
      `);
      const env = { ...process.env };
      delete env.NO_COLOR;
      delete env.FORCE_COLOR;
      delete env.DEBUG_COLORS;
      delete env.ORKAS_E2E_NO_COLOR;
      if (mode === 'plain') env.NO_COLOR = '1';
      else env.FORCE_COLOR = '1';
      // `npm_execpath` is set only when the suite itself was started by npm. A
      // direct `node scripts/run-tests.mjs` run must still exercise the package
      // entry, so fall back to npm on PATH instead of spawning an undefined path.
      const npmCli = process.env.npm_execpath;
      const args = ['run', 'test:e2e', '--', '--config', config];
      const result = npmCli
        ? spawnSync(process.env.ORKAS_TEST_NODE || process.execPath, [npmCli, ...args],
          { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 })
        : spawnSync('npm', args,
          { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32' });
      expect(result.error).toBeUndefined();
      const output = result.stdout + result.stderr;
      expect(result.status, output).toBe(fail ? 1 : 0);
      expect(output).toContain('worker-output-visible');
      expect(output).toContain('expected-warning-visible');
      expect(output).not.toContain("The 'NO_COLOR' env is ignored");
      expect(stripVTControlCharacters(result.stderr).trim()).toBe('expected-warning-visible');
      if (mode === 'plain') expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
      else expect(output).toMatch(/\x1b\[[0-9;]*m/);
      expect(output).toContain(fail ? '1 failed' : '1 passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40_000);
});
