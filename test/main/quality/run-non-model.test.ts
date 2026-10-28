import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const appRoot = path.resolve(__dirname, '../../..');
const node = process.env.ORKAS_TEST_NODE || process.execPath;
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const laneOrder = ['typecheck', 'test', 'test:e2e:typecheck', 'test:e2e', 'test:platform-native', 'smoke'];

// Execute the actual CLI in a disposable flat checkout. Only child dispatch is
// replaced: no business test, Electron window or native host process is run.
function runEntry(options: { platform?: string; args?: string[]; fail?: string; failure?: string } = {}) {
  // Node resolves the entry module and child cwd through macOS's /var alias.
  // Use the fixture's real location for both invocation and exact path oracles.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-non-model-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const file of ['run-non-model.mjs', 'test-checkpoint.mjs', 'test-stderr-receipt.mjs', 'test-runtime-env.mjs']) {
    fs.copyFileSync(path.join(appRoot, 'scripts', file), path.join(root, 'scripts', file));
  }
  const callsPath = path.join(root, 'dispatch.jsonl');
  const preload = path.join(root, 'dispatch.mjs');
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(options.platform || process.platform)} });
    cp.spawnSync = (command, args, options) => {
      if (command === 'where.exe') return { status: 1, stdout: '' };
      fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ command, args, cwd: options.cwd,
        stdio: options.stdio, shell: options.shell, sentinel: options.env.NON_MODEL_SENTINEL }) + '\\n');
      const script = args.includes('run') ? args[args.indexOf('run') + 1] : 'test';
      // The parent must persist each completed stage before starting the next.
      const dispatched = fs.readFileSync(${JSON.stringify(callsPath)}, 'utf8').trim().split('\\n').length;
      if (dispatched > 1) {
        if (!fs.existsSync('test-results')) return { status: 91 };
        const report = JSON.parse(fs.readFileSync('test-results/' + fs.readdirSync('test-results')[0], 'utf8'));
        if (report.stages.length !== dispatched - 1) return { status: 91 };
      }
      if (script === ${JSON.stringify(options.fail || '')}) {
        if (${JSON.stringify(options.failure)} === 'spawn') return { status: null, signal: null, error: new Error('controlled spawn failure') };
        if (${JSON.stringify(options.failure)} === 'signal') return { status: null, signal: 'SIGTERM' };
        return { status: 7, signal: null };
      }
      return { status: 0, signal: null };
    };
    syncBuiltinESMExports();
  `);
  const result = spawnSync(node, ['--import', pathToFileURL(preload).href,
    path.join(root, 'scripts/run-non-model.mjs'), ...(options.args || [])], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', npm_execpath: preload, NON_MODEL_SENTINEL: 'preserved' },
  });
  expect(result.error).toBeUndefined();
  const calls = fs.existsSync(callsPath)
    ? fs.readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const reports = fs.existsSync(path.join(root, 'test-results'))
    ? fs.readdirSync(path.join(root, 'test-results')).map(file => ({ file, value: JSON.parse(fs.readFileSync(path.join(root, 'test-results', file), 'utf8')) })) : [];
  return { root, preload, result, calls, reports };
}

describe('flat repository non-model entry', () => {
  it.each(['darwin', 'linux', 'win32'])('preserves all six serial lanes and stage receipts on %s', platform => {
    const { root, preload, result, calls, reports } = runEntry({ platform });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(calls.map(call => call.args.slice(platform === 'win32' ? 1 : 0))).toEqual([
      ['run', 'typecheck'], ['test'], ['run', 'test:e2e:typecheck'], ['run', 'test:e2e'],
      ['run', 'test:platform-native'], ['run', 'smoke'],
    ]);
    for (const call of calls) {
      expect(call).toMatchObject({ command: platform === 'win32' ? node : 'npm', cwd: root, stdio: 'inherit', sentinel: 'preserved' });
      expect(call.shell).toBeUndefined();
      if (platform === 'win32') expect(call.args[0]).toBe(preload);
    }
    expect(reports).toHaveLength(1);
    expect(result.stdout).toContain(path.join(root, 'test-results', reports[0].file));
    expect(reports[0].value.stages.map((stage: any) => stage.script)).toEqual(laneOrder);
    for (const stage of reports[0].value.stages) {
      expect(stage).toMatchObject({ exitCode: 0, signal: null, execution: 'completed' });
      expect(Number.isInteger(stage.durationMs)).toBe(true);
      expect(stage.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(reports[0].value.logReview).toContain('each owning runner report');
  });

  it.each([
    ['--checkpoint-dir', 'checkpoint with spaces', '--batch-count', '4', '--resume'],
    ['--checkpoint-dir=checkpoint with spaces', '--batch-count=4', '--resume'],
  ])('forwards checkpoint options to the JS/Python suite owner and E2E only (%j)', (...args) => {
    const { root, result, calls } = runEntry({ platform: 'linux', args });
    expect(result.status, result.stderr).toBe(0);
    const forwarded = ['--', `--checkpoint-dir=${path.join(root, 'checkpoint with spaces')}`, '--batch-count=4', '--resume'];
    expect(calls.map(call => call.args)).toEqual([
      ['run', 'typecheck'], ['test', ...forwarded], ['run', 'test:e2e:typecheck'],
      ['run', 'test:e2e', ...forwarded], ['run', 'test:platform-native'], ['run', 'smoke'],
    ]);
    // No separate Python invocation: npm test owns builtin Python and its
    // checkpoint forwarding (covered by test-checkpoint.test.ts's suite case).
    expect(calls).toHaveLength(6);
  });

  it('uses the owning checkpoint default without enabling resume implicitly', () => {
    const { root, result, calls } = runEntry({ platform: 'linux', args: ['--checkpoint-dir=checkpoint'] });
    expect(result.status, result.stderr).toBe(0);
    expect(calls[1].args).toEqual(['test', '--', `--checkpoint-dir=${path.join(root, 'checkpoint')}`, '--batch-count=8']);
    expect(calls[3].args).toEqual(['run', 'test:e2e', '--', `--checkpoint-dir=${path.join(root, 'checkpoint')}`, '--batch-count=8']);
  });

  it.each(laneOrder)('retains failure and never starts later lanes after %s fails', fail => {
    const { result, calls, reports } = runEntry({ fail });
    expect(result.status).toBe(7);
    expect(result.stderr).toBe('');
    const expected = laneOrder.slice(0, laneOrder.indexOf(fail) + 1);
    expect(calls).toHaveLength(expected.length);
    expect(reports[0].value.stages.map((stage: any) => stage.script)).toEqual(expected);
    expect(reports[0].value.stages.at(-1)).toMatchObject({ script: fail, exitCode: 7 });
  });

  it.each(['spawn', 'signal'])('records %s failure without starting the next native lane', failure => {
    const { result, calls, reports } = runEntry({ fail: 'test:e2e', failure });
    expect(result.status).toBe(1);
    expect(calls).toHaveLength(4);
    expect(reports[0].value.stages.at(-1)).toMatchObject({ script: 'test:e2e', exitCode: null,
      execution: failure === 'spawn' ? 'unavailable' : 'interrupted', signal: failure === 'signal' ? 'SIGTERM' : null });
    if (failure === 'spawn') expect(result.stderr).toContain('controlled spawn failure');
    else expect(result.stderr).toBe('');
  });

  it.each([
    ['--resume'], ['--batch-count=4'], ['--checkpoint-dir'], ['--checkpoint-dir='],
    ['--checkpoint-dir=checkpoint', '--batch-count=0'], ['--checkpoint-dir=checkpoint', '--batch-count=33'],
    ['--coverage'], ['--include-ios'], ['--checkpoint-dir=checkpoint', '--watch'],
  ])('rejects invalid or scope-changing arguments before dispatch (%j)', (...args) => {
    const { result, calls, reports } = runEntry({ args });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('[non-model]');
    expect(calls).toEqual([]);
    expect(reports).toEqual([]);
  });
});
