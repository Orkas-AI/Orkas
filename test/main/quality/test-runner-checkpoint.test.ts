import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const pcRoot = path.resolve(__dirname, '../../..');
const node = process.env.ORKAS_TEST_NODE || process.execPath;
const python = process.env.ORKAS_TEST_PYTHON!;
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function fixture(kind: 'python' | 'e2e') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-runner-resume-'));
  roots.push(root);
  const pc = root;
  const write = (file: string, value: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), value);
  };
  write('.gitignore', 'test-results/\nnode_modules/\n__pycache__/\n*.pyc\n.pytest_cache/\n');
  write('package.json', '{}');
  for (const name of fs.readdirSync(path.join(pcRoot, 'scripts'))) {
    if (['test-checkpoint.mjs', 'test-stderr-receipt.mjs', 'test-runtime-env.mjs', 'model-eval-log-policy.mjs',
      'run-python-tests.mjs', 'run-e2e.cjs', 'runner-checkpoint.mjs', 'pytest_checkpoint.py', 'checkpoint-reporter.ts'].includes(name)) {
      write(`scripts/${name}`, fs.readFileSync(path.join(pcRoot, 'scripts', name), 'utf8'));
    }
  }
  write('test/e2e/fixtures/web-app-log-analysis.ts', fs.readFileSync(path.join(pcRoot, 'test/e2e/fixtures/web-app-log-analysis.ts'), 'utf8'));
  write('node_modules/playwright/package.json', '{}');
  write('node_modules/playwright/cli.js', `require(${JSON.stringify(path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js'))});`);
  write('node_modules/playwright/lib/program.js', `module.exports = require(${JSON.stringify(require.resolve('playwright/lib/program'))});`);
  write('playwright.config.ts', `export default { testDir: './test/e2e', workers: 1, fullyParallel: false, retries: 0, reporter: 'list' };`);
  const add = (name: string, fail = false, logs = '') => {
    if (kind === 'python') write(`tests/test_${name}.py`, `
from pathlib import Path
import pytest, sys, logging, warnings

def test_${name}():
    marker = Path('test-results/${name}')
    marker.parent.mkdir(exist_ok=True)
    previous = marker.exists()
    marker.write_text(str(int(marker.read_text()) + 1) if previous else '1')
    ${logs || 'pass'}
    assert ${fail ? 'previous' : 'True'}
`);
    else write(`test/e2e/${name}_e2e_fixture.spec.ts`, `
import { test, expect } from ${JSON.stringify(require.resolve('@playwright/test'))};
import fs from 'node:fs';
test('${name}', async () => {
  const marker = 'test-results/${name}';
  fs.mkdirSync('test-results', { recursive: true });
  const previous = fs.existsSync(marker);
  fs.writeFileSync(marker, String(previous ? Number(fs.readFileSync(marker)) + 1 : 1));
  ${logs}
  expect(${fail ? 'previous' : 'true'}).toBe(true);
});
`);
  };
  add('a'); add('b', true); add('c');
  expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0);
  const command = (resume = false, extra: string[] = []) => [
    kind === 'python' ? 'scripts/run-python-tests.mjs' : 'scripts/run-e2e.cjs',
    ...(kind === 'python' ? ['tests', '-q'] : ['test', '--config', 'playwright.config.ts']),
    '--checkpoint-dir=test-results/checkpoints', '--batch-count=3', ...(resume ? ['--resume'] : []), ...extra,
  ];
  const env = { ...process.env, ORKAS_TEST_PYTHON: python, ORKAS_TEST_BATCH_REPORT: '', NO_COLOR: '1', FORCE_COLOR: '0' };
  const run = (resume = false, extra: string[] = [], extraEnv = {}) => spawnSync(node, command(resume, extra),
    { cwd: pc, encoding: 'utf8', timeout: 60_000, env: { ...env, ...extraEnv } });
  const start = () => spawn(node, command(), { cwd: pc, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const count = (name: string) => Number(fs.readFileSync(path.join(pc, 'test-results', name), 'utf8'));
  const stateFile = () => fs.readdirSync(path.join(pc, 'test-results/checkpoints'), { recursive: true })
    .map(String).find(file => file.endsWith('checkpoint.json'))!;
  return { root, pc, write, add, run, start, count, stateFile };
}

it.each(['python', 'e2e'] as const)('%s resumes failed work, preserves evidence and discovers new cases', kind => {
  const f = fixture(kind);
  const first = f.run();
  expect(first.status, first.stdout + first.stderr).toBe(1);
  expect([f.count('a'), f.count('b'), f.count('c')]).toEqual([1, 1, 1]);
  const second = f.run(true);
  expect(second.status, second.stdout + second.stderr).toBe(0);
  expect(second.stdout).toContain('reused=2');
  expect([f.count('a'), f.count('b'), f.count('c')]).toEqual([1, 2, 1]);
  const base = path.join(f.pc, 'test-results/checkpoints', path.dirname(f.stateFile()));
  const state = JSON.parse(fs.readFileSync(path.join(base, 'checkpoint.json'), 'utf8'));
  fs.unlinkSync(path.join(base, state.completed['1'].stdout));
  expect(f.run(true).status).toBe(0);
  expect(f.count('a') + f.count('b') + f.count('c')).toBe(5);
  const refreshed = JSON.parse(fs.readFileSync(path.join(base, 'checkpoint.json'), 'utf8'));
  const entry = refreshed.completed['1'];
  const report = JSON.parse(fs.readFileSync(path.join(base, entry.report), 'utf8'));
  fs.appendFileSync(path.join(base, report.artifacts[0].file), 'corrupted');
  const corrupt = f.run(true);
  expect(corrupt.status, corrupt.stdout + corrupt.stderr).toBe(0);
  expect(corrupt.stdout).toContain('reused=2');
  f.add('new', true);
  const changed = f.run(true);
  expect(changed.status, changed.stdout + changed.stderr).toBe(1);
  expect(f.count('new')).toBe(1);
  expect(changed.stdout).toContain('reused=0');
  const attempts = fs.readdirSync(base, { recursive: true }).map(String).filter(file => file.endsWith('attempt.json'));
  expect(attempts.some(file => JSON.parse(fs.readFileSync(path.join(base, file), 'utf8')).exitCode === 1)).toBe(true);
}, 120_000);

it.each(['python', 'e2e'] as const)('%s rejects unclassified stderr and surfaces structured warnings', kind => {
  const f = fixture(kind);
  f.add('b', false, kind === 'python' ? "sys.stderr.write('unclassified probe\\n')" : "process.stderr.write('unclassified probe\\n');");
  const invalid = f.run();
  expect(invalid.status, invalid.stdout + invalid.stderr).toBe(1);
  expect(invalid.stdout).toContain('log analysis FAIL');
  f.add('b', false, kind === 'python' ? "logging.error('structured failure')" : "process.stdout.write('[00:00:00.000] [error] [(probe)] structured failure\\n');");
  expect(f.run(true).status).toBe(1);
  f.add('b', false, kind === 'python' ? "warnings.warn('probe warning')" : "process.stdout.write('warning: probe warning\\n');");
  const warned = f.run(true);
  expect(warned.status, warned.stdout + warned.stderr).toBe(0);
  expect(warned.stdout).toContain('log analysis WARN');
}, 120_000);


it.each(['python', 'e2e'] as const)('%s preserves skipped cases and whole files with uneven case counts', kind => {
  const f = fixture(kind);
  f.add('b');
  if (kind === 'python') f.write('tests/test_a.py', `
import pytest
@pytest.mark.parametrize('number', range(12))
def test_many(number): assert number >= 0
@pytest.mark.skip(reason='platform fixture')
def test_skip(): assert False
`);
  else f.write('test/e2e/a_e2e_fixture.spec.ts', `
import {test, expect} from ${JSON.stringify(require.resolve('@playwright/test'))};
for (let i = 0; i < 12; i++) test('case ' + i, () => expect(i).toBeGreaterThanOrEqual(0));
test.skip('platform fixture', () => expect(false).toBe(true));
`);
  const initial = f.run();
  expect(initial.status, initial.stdout + initial.stderr).toBe(0);
  const resumed = f.run(true);
  expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
  expect(resumed.stdout).toContain('reused=3');
  const base = path.join(f.pc, 'test-results/checkpoints', path.dirname(f.stateFile()));
  const state = JSON.parse(fs.readFileSync(path.join(base, 'checkpoint.json'), 'utf8'));
  const results = Object.values(state.completed).flatMap((entry: any) => JSON.parse(fs.readFileSync(path.join(base, entry.report), 'utf8')).files);
  expect(results).toHaveLength(15);
  expect(results.filter((file: any) => file.skipped === 1)).toHaveLength(1);
}, 120_000);

it('invalidates Python results when an external import dependency changes', () => {
  const f = fixture('python');
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-external-python-'));
  roots.push(library);
  const source = path.join(library, 'checkpoint_dependency.py');
  fs.writeFileSync(source, 'value = 1\n');
  f.add('b', false, 'import checkpoint_dependency; assert checkpoint_dependency.value == 1');
  const env = { PYTHONPATH: library };
  const first = f.run(false, [], env);
  expect(first.status, first.stdout + first.stderr).toBe(0);
  expect(f.run(true, [], env).stdout).toContain('reused=3');
  fs.writeFileSync(source, 'value = 2\n');
  const changed = f.run(true, [], env);
  expect(changed.status, changed.stdout + changed.stderr).toBe(1);
  expect(changed.stdout).toContain('reused=0');
}, 120_000);

it.skipIf(process.platform === 'win32').each(['python', 'e2e'] as const)(
  '%s cancellation releases its lock and only resumes terminal batches', async kind => {
    const f = fixture(kind);
    f.add('b', false, kind === 'python'
      ? "if not Path('test-results/hold-ready').exists(): Path('test-results/hold-ready').write_text('1'); __import__('time').sleep(30)"
      : "if (!fs.existsSync('test-results/hold-ready')) { fs.writeFileSync('test-results/hold-ready', '1'); await new Promise(resolve => setTimeout(resolve, 30000)); }");
    const child = f.start();
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', data => { stderr += data.toString(); });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    try {
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(path.join(f.pc, 'test-results/hold-ready')) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(fs.existsSync(path.join(f.pc, 'test-results/hold-ready')), stderr).toBe(true);
      const conflict = f.run(true);
      expect(conflict.status).toBe(1);
      expect(conflict.stderr).toContain('Checkpoint is locked');
      child.kill('SIGTERM');
      expect(await closed).toEqual({ code: null, signal: 'SIGTERM' });
      const resumed = f.run(true);
      expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain('reused=1');
      expect([f.count('a'), f.count('b'), f.count('c')]).toEqual([1, 2, 1]);
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; }
  }, 120_000,
);


it('requires every Electron log attachment and retains independently verified recovery evidence', () => {
  const f = fixture('e2e');
  f.add('b', false, `await test.info().attach('electron-log-required', { body: Buffer.from('[]') });`);
  const missing = f.run();
  expect(missing.status, missing.stdout + missing.stderr).toBe(1);
  f.add('b', false, `
    await test.info().attach('electron-log-required', { body: Buffer.from(JSON.stringify([{ start: 1, end: 1, diagnosticIndex: 0 }])) });
    const log = test.info().outputPath('electron.log');
    fs.writeFileSync(log, '[renderer:pageerror] injected preview crash\\n');
    await test.info().attach('electron-logs', { path: log });
  `);
  const recovered = f.run(true);
  expect(recovered.status, recovered.stdout + recovered.stderr).toBe(0);
  expect(recovered.stdout).toContain('log analysis WARN');
  const resumed = f.run(true);
  expect(resumed.stdout).toContain('reused=3');
}, 120_000);


// Run the actual dispose owner without importing Playwright or starting an app.
// A missing receipt must reject certification and still release every resource.
it.each(['electron-log-required', 'electron-logs'])(
  'checkpoint %s attachment failures preserve cleanup and remain failures', async failedAttachment => {
    const file = ts.createSourceFile('orkas.ts', fs.readFileSync(
      path.join(pcRoot, 'test/e2e/fixtures/orkas.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const owner = file.statements.find((statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'OrkasTestApp');
    if (!owner) throw new Error('Missing Electron fixture owner');
    const methods = owner.members.filter(member => member.name
      && ['dispose', 'recoveredDiagnosticRanges'].includes(member.name.getText(file)));
    const code = ts.transpileModule('class DisposeOwner {' + methods.map(method => method.getText(file)).join('\n') + '}', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const Owner = new Function('process', 'expect', 'path', 'mkdirSync', 'writeFileSync', 'rmSync',
      'unlinkSync', 'collectLogFiles', 'randomUUID', code + '; return DisposeOwner;')(
      { env: { ORKAS_TEST_BATCH_REPORT: 'fixture-report' } }, expect, path, fs.mkdirSync, fs.writeFileSync,
      fs.rmSync, fs.unlinkSync, () => '', () => 'snapshot');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-checkpoint-dispose-'));
    roots.push(root);
    const appRoot = path.join(root, 'app');
    fs.mkdirSync(appRoot);
    fs.writeFileSync(path.join(appRoot, 'owned-file'), 'temporary fixture data');
    const released: string[] = [];
    const failure = new Error('injected checkpoint attachment failure');
    const fixture = Object.assign(new Owner(), {
      root: appRoot, page: null, apiResponses: [], expectedApiFailures: [], cliStub: false,
      rendererPageErrors: [], recoveredRendererErrors: new Set(), diagnostics: ['[fixture-cleanup] completed'], tracePaths: [],
      closeCurrentApp: async () => { released.push('app'); },
      closeStubServer: async () => { released.push('stub'); },
      testInfo: {
        status: 'passed', expectedStatus: 'passed', outputDir: path.join(root, 'output'),
        outputPath: (name: string) => path.join(root, 'output', name),
        attach: async (name: string) => {
          expect(released).toEqual(['app', 'stub']);
          if (name === failedAttachment) throw failure;
        },
      },
    });
    if (failedAttachment === 'electron-log-required') await expect(fixture.dispose()).rejects.toBe(failure);
    else await expect(fixture.dispose()).rejects.toMatchObject({
      message: 'Checkpoint Electron log capture failed', cause: failure,
    });
    expect(released).toEqual(['app', 'stub']);
    expect(fs.existsSync(appRoot)).toBe(false);
    expect(fs.existsSync(path.join(root, 'output', 'checkpoint-electron-snapshot.log'))).toBe(true);
  },
);

it('keeps a completed tool receipt without a terminal turn in the real interruption CLI fixture', () => {
  const file = ts.createSourceFile('orkas.ts', fs.readFileSync(
    path.join(pcRoot, 'test/e2e/fixtures/orkas.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const factory = file.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'fakeCodexSource');
  if (!factory) throw new Error('Missing Codex fixture producer');
  const code = ts.transpileModule(factory.getText(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-interruption-producer-'));
  roots.push(root);
  const script = path.join(root, 'codex.cjs');
  fs.writeFileSync(script, new Function(code + '; return fakeCodexSource();')());
  const requests = [
    { id: 1, method: 'initialize' },
    { id: 2, method: 'thread/start' },
    { id: 3, method: 'turn/start', params: { input: [{ type: 'text', text: 'E2E_CODEX_CRASH_PROCESS' }] } },
  ];
  const result = spawnSync(node, [script], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, ORKAS_E2E_CLI_STATE: path.join(root, 'state.json') },
    input: requests.map(request => JSON.stringify(request)).join('\n') + '\n',
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(records.find(row => row.method === 'item/completed')?.params.item).toMatchObject({
    id: 'crash-tool', type: 'commandExecution', status: 'completed',
    aggregatedOutput: 'DURABLE_CRASH_RECEIPT', exitCode: 0,
  });
  expect(records.filter(row => row.method === 'turn/started')).toHaveLength(1);
  expect(records.filter(row => row.method === 'turn/completed')).toEqual([]);
  expect(records.filter(row => row.method === 'item/agentMessage/delta')).toEqual([]);
});
