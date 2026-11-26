import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('preserves first failures, recovery, all attempts and the failing exit through real Playwright workers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-attempts-'));
  try {
    const output = path.join(root, 'results');
    const reporter = path.resolve('scripts/e2e-attempt-reporter.ts');
    fs.writeFileSync(path.join(root, 'playwright.config.cjs'), `module.exports = {
      testDir: __dirname, workers: 1, retries: 2, outputDir: ${JSON.stringify(output)},
      reporter: [['line'], [${JSON.stringify(reporter)}]] };`);
    fs.writeFileSync(path.join(root, 'attempt.spec.cjs'), `
      const { test, expect } = require(${JSON.stringify(require.resolve('@playwright/test'))});
      test('private customer stable', () => expect(true).toBe(true));
      test('private customer recovery', ({}, info) => expect(info.retry).toBeGreaterThan(0));
      test('private customer failure', () => expect(false).toBe(true));
      test('expected failure', () => { test.fail(); expect(false).toBe(true); });
      test.skip('platform skip', () => {});
    `);
    const result = spawnSync(process.env.ORKAS_TEST_NODE || process.execPath,
      ['scripts/run-e2e.cjs', 'test', '--config', path.join(root, 'playwright.config.cjs')],
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env, NO_COLOR: '1' } });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('1 flaky');
    expect(result.stdout).toContain('[e2e-attempts]');
    const bytes = fs.readFileSync(path.join(output, 'attempt-summary.json'), 'utf8');
    const report = JSON.parse(bytes);
    expect(report).toMatchObject({ schemaVersion: 1, status: 'failed', selected: 5, executed: 4,
      firstAttemptPassed: 2, retryRecovered: 1, finalFailed: 1, skipped: 1, notRun: 0,
      firstAttemptPassRate: 0.5, retryRecoveryRate: 0.5 });
    expect(report.cases.map((row: any) => row.attempts.map((a: any) => a.status))).toEqual([
      ['passed'], ['failed', 'passed'], ['failed', 'failed', 'failed'], ['failed'], ['skipped'],
    ]);
    expect(bytes).not.toContain('private customer');
    expect(bytes).not.toContain(root);
    expect(report.durationMs).toBeGreaterThan(0);
    expect(report.cases[1].attempts[0]).toMatchObject({ retry: 0, expected: false });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 40_000);

it('keeps interrupted, skipped and unstarted work out of successful counts and empty rates unavailable', async () => {
  const { summarizeAttempts } = await import('../../../scripts/e2e-attempt-reporter');
  const test = (id: string, results: any[], expectedStatus = 'passed') => ({ id, results, expectedStatus });
  const suite = { allTests: () => [test('not-run', []), test('interrupted', [{ retry: 0, status: 'interrupted', duration: 2 }]),
    test('skipped', [{ retry: 0, status: 'skipped', duration: 0 }], 'skipped'),
    test('failure-then-skip', [{ retry: 0, status: 'failed', duration: 2 }, { retry: 1, status: 'skipped', duration: 0 }], 'skipped')] } as any;
  expect(summarizeAttempts(suite, { status: 'interrupted', duration: 2 } as any)).toMatchObject({
    firstAttemptPassed: 0, retryRecovered: 0, finalFailed: 2, skipped: 1, notRun: 1, executed: 2,
  });
  expect(summarizeAttempts({ allTests: () => [] } as any, { status: 'passed', duration: 0 } as any))
    .toMatchObject({ firstAttemptPassRate: null, retryRecoveryRate: null });
});

it('uses the default local and CI reporter registration without turning recovered tests into a new gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-default-attempts-'));
  try {
    const pc = process.cwd();
    fs.writeFileSync(path.join(root, 'playwright.config.ts'), `
      import base from ${JSON.stringify(path.join(pc, 'playwright.config.ts'))};
      export default { ...base, testDir: ${JSON.stringify(root)}, testMatch: '*.spec.cjs', retries: 1,
        outputDir: ${JSON.stringify(path.join(root, 'results'))},
        reporter: base.reporter.map(([name, options]) => [name.startsWith('.') ? ${JSON.stringify(pc)} + '/' + name : name,
          name === 'html' ? { ...options, outputFolder: ${JSON.stringify(path.join(root, 'html'))} } : options]) };
    `);
    fs.writeFileSync(path.join(root, 'recovery.spec.cjs'), `
      const { test, expect } = require(${JSON.stringify(require.resolve('@playwright/test'))});
      test('retry recovers', ({}, info) => expect(info.retry).toBe(1));
    `);
    for (const ci of ['', '1']) {
      const result = spawnSync(process.env.ORKAS_TEST_NODE || process.execPath,
        ['scripts/run-e2e.cjs', 'test', '--config', path.join(root, 'playwright.config.ts')],
        { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CI: ci, NO_COLOR: '1' } });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('[e2e-attempts] first-pass=0/1 recovered=1');
      expect(JSON.parse(fs.readFileSync(path.join(root, 'results/attempt-summary.json'), 'utf8')))
        .toMatchObject({ status: 'passed', firstAttemptPassed: 0, retryRecovered: 1 });
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 60_000);
