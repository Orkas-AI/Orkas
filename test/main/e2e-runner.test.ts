import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(process.cwd(), 'scripts/run-e2e.cjs'), 'utf8');

function launch(args: string[], inherited: Record<string, string> = {}, platform = 'darwin') {
  const env = { ...inherited };
  const argv = ['node', 'scripts/run-e2e.cjs', ...args];
  let loadedEnv: Record<string, string> | undefined;
  let parsedArgv: string[] | undefined;
  runInNewContext(source, {
    process: { env, argv, platform },
    require(name: string) {
      if (name !== 'playwright/lib/program') throw new Error(`Unexpected runner import: ${name}`);
      loadedEnv = { ...env };
      return { program: { parse: (value: string[]) => { parsedArgv = [...value]; } } };
    },
  });
  expect(parsedArgv).toEqual(argv);
  return loadedEnv!;
}

describe('E2E runner desktop isolation', () => {
  it('retains an earlier run attachment when the same Playwright selection runs again', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orkas-e2e-output-'));
    const pc = process.cwd();
    const node = process.env.ORKAS_TEST_NODE || process.execPath;
    try {
      const config = path.join(root, 'playwright.config.ts');
      writeFileSync(config, `import base from ${JSON.stringify(path.join(pc, 'playwright.config.ts'))};
        export default { ...base, testDir: ${JSON.stringify(root)}, testMatch: 'owned.spec.ts', retries: 0, reporter: 'json' };`);
      writeFileSync(path.join(root, 'owned.spec.ts'), `import { test } from ${JSON.stringify(path.join(pc, 'node_modules/@playwright/test/index.mjs'))};
        import fs from 'node:fs';
        test('retains proof', async ({}, info) => {
          fs.writeFileSync(info.outputPath('proof.txt'), process.env.OUTPUT_PROOF);
          await info.attach('proof', { path: info.outputPath('proof.txt') });
        });`);
      const run = (label: string) => {
        const result = spawnSync(node, [path.join(pc, 'node_modules/playwright/cli.js'), 'test', '--config', config], {
          cwd: root, encoding: 'utf8', timeout: 20_000,
          env: { ...process.env, OUTPUT_PROOF: label, FORCE_COLOR: '0', NO_COLOR: undefined },
        });
        expect(result.error).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        const report = JSON.parse(result.stdout);
        expect(report.errors).toEqual([]);
        const file = report.suites[0].specs[0].tests[0].results[0].attachments[0].path;
        expect(readFileSync(file, 'utf8')).toBe(label);
        return file;
      };
      const first = run('first'); const second = run('second');
      expect(second).not.toBe(first);
      expect(existsSync(first)).toBe(true);
      expect(readFileSync(first, 'utf8')).toBe('first');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);

  it.each<Record<string, string>>([{}, { GOMAXPROCS: '', GOMEMLIMIT: '' }])('bounds Windows source compilation before Playwright loads with %j', inherited => {
    const result = launch(['test'], inherited, 'win32');
    expect(result).toMatchObject({ GOMAXPROCS: '1', GOMEMLIMIT: '128MiB', ORKAS_E2E_HIDE_WINDOW: '1' });
  });

  it('preserves explicit Windows compiler resource budgets', () => {
    const result = launch(['test'], { GOMAXPROCS: '2', GOMEMLIMIT: '256MiB' }, 'win32');
    expect(result).toMatchObject({ GOMAXPROCS: '2', GOMEMLIMIT: '256MiB' });
  });

  it.each(['darwin', 'linux'])('leaves compiler budgets unchanged on %s', platform => {
    const result = launch(['test'], {}, platform);
    expect(result.GOMAXPROCS).toBeUndefined(); expect(result.GOMEMLIMIT).toBeUndefined();
  });

  it.each<{ name: string; env: Record<string, string> }>([
    { name: 'clean shell', env: {} },
    { name: 'inherited visible mode', env: { ORKAS_E2E_SHOW_WINDOW: '1' } },
    { name: 'inherited Playwright debug mode', env: { PWDEBUG: '1' } },
    { name: 'conflicting legacy controls', env: { ORKAS_E2E_SHOW_WINDOW: '1', ORKAS_E2E_HIDE_WINDOW: '0', PWDEBUG: 'console' } },
  ])('keeps ordinary runs in the background with $name', ({ env }) => {
    const result = launch(['test', '--config', 'playwright.config.ts'], env);
    expect(result).toMatchObject({ ORKAS_E2E_SHOW_WINDOW: '0', ORKAS_E2E_HIDE_WINDOW: '1' });
    expect(result.PWDEBUG).toBeUndefined();
  });

  it('keeps the generation entry hidden and preserves model selection and test filters', () => {
    const result = launch(['test', '--config', 'playwright.config.ts', 'test/e2e/web_app_generation_e2e_model.spec.ts'], {
      ORKAS_E2E_SHOW_WINDOW: '1', PWDEBUG: '1', ORKAS_WEB_APP_MODEL_EVAL: '0',
    });
    expect(result).toMatchObject({ ORKAS_E2E_SHOW_WINDOW: '0', ORKAS_WEB_APP_MODEL_EVAL: '0' });
    expect(result.PWDEBUG).toBeUndefined();
  });

  it('permits a visible debugger only when this invocation explicitly requests it', () => {
    const result = launch(['test', '--config', 'playwright.config.ts', '--debug'], {
      ORKAS_E2E_SHOW_WINDOW: '0', ORKAS_E2E_HIDE_WINDOW: '1', PWDEBUG: 'console',
    });
    expect(result).toMatchObject({ ORKAS_E2E_SHOW_WINDOW: '1', ORKAS_E2E_HIDE_WINDOW: '0', PWDEBUG: '1' });
  });

  it('does not treat a positional filter after the option terminator as a debug request', () => {
    const result = launch(['test', '--', '--debug'], { ORKAS_E2E_SHOW_WINDOW: '1' });
    expect(result.ORKAS_E2E_SHOW_WINDOW).toBe('0');
    expect(result.PWDEBUG).toBeUndefined();
  });

  it('preserves plain output without leaking contradictory color controls', () => {
    const result = launch(['test'], { NO_COLOR: '1', FORCE_COLOR: '1' });
    expect(result).toMatchObject({ ORKAS_E2E_NO_COLOR: '1', FORCE_COLOR: '0', DEBUG_COLORS: '0' });
    expect(result.NO_COLOR).toBeUndefined();
  });
});
