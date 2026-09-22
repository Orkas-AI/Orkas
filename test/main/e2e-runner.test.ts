import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(process.cwd(), 'scripts/run-e2e.cjs'), 'utf8');

function launch(args: string[], inherited: Record<string, string> = {}) {
  const env = { ...inherited };
  const argv = ['node', 'scripts/run-e2e.cjs', ...args];
  let loadedEnv: Record<string, string> | undefined;
  let parsedArgv: string[] | undefined;
  runInNewContext(source, {
    process: { env, argv },
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
