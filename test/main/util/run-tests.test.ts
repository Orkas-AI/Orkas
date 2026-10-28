import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { findTestNpmCli } from '../../helpers/npm-cli';

const pcRoot = path.resolve(__dirname, '../../..');
const roots: string[] = [];
const node = process.env.ORKAS_TEST_NODE || process.execPath;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-test-entry-'));
  roots.push(root);
  const pkg = JSON.parse(fs.readFileSync(path.join(pcRoot, 'package.json'), 'utf8'));
  function write(relative: string, text: string) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  write('package.json', JSON.stringify({ name: 'test-entry-fixture', private: true, scripts: {
    test: pkg.scripts.test, 'test:js': pkg.scripts['test:js'], 'test:resources': pkg.scripts['test:resources'],
  } }));
  for (const file of ['run-tests.mjs', 'test-runtime-env.mjs', 'check-installed-dependencies.mjs']) {
    write(`scripts/${file}`, fs.readFileSync(path.join(pcRoot, 'scripts', file), 'utf8'));
  }
  // Real npm and launcher, recording child executables: exercising routing
  // cannot recursively run this suite or depend on native/Python availability.
  write('node_modules/electron/index.js', `module.exports = ${JSON.stringify(node)};`);
  const child = (family: string) => `
    if (process.env.HOLD_FAMILY === '${family}') {
      process.on('SIGTERM', () => { console.error('${family}-stopped'); process.exit(0); });
      setTimeout(() => process.exit(12), 5000);
    }
    console.log('EXEC:' + JSON.stringify({ family: '${family}', args: process.argv.slice(2),
      electronNode: process.env.ELECTRON_RUN_AS_NODE, outerNode: process.env.ORKAS_TEST_NODE,
      testPython: process.env.ORKAS_TEST_PYTHON, evalPython: process.env.ORKAS_EVAL_PYTHON }));
    console.error('${family}-diagnostic');
    if (process.env.HOLD_FAMILY !== '${family}') process.exit(Number(process.env.${family === 'js' ? 'JS' : 'RESOURCE'}_EXIT || 0));
  `;
  write('node_modules/vitest/vitest.mjs', child('js'));
  write('scripts/run-python-tests.mjs', child('resources'));
  return root;
}

function invoke(root: string, args: string[], env: Record<string, string> = {}) {
  const npm = findTestNpmCli(node);
  if (!npm) throw new Error('No npm CLI found on PATH or beside the test Node.');
  const result = spawnSync(node, [npm, ...args], {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  const records = result.stdout.split(/\r?\n/).filter(line => line.startsWith('EXEC:'))
    .map(line => JSON.parse(line.slice(5)));
  // Every child diagnostic must survive; anything else on stderr is a failure.
  expect(result.stderr.trim().split(/\r?\n/)).toEqual(records.map(record => `${record.family}-diagnostic`));
  return { ...result, records };
}

describe('npm test selection and outcome', () => {
  it('runs the real npm fixture when a direct Node parent does not export npm_execpath', () => {
    const previous = process.env.npm_execpath;
    delete process.env.npm_execpath;
    try {
      const result = invoke(fixture(), ['run', 'test:js', '--', 'test/direct.test.ts']);
      expect(result.status).toBe(0);
      expect(result.records.map(record => [record.family, record.args])).toEqual([
        ['js', ['run', 'test/direct.test.ts']],
      ]);
    } finally {
      if (previous === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = previous;
    }
  });

  it('shares the configured project Python with fixture subprocesses in both test families', () => {
    const result = invoke(fixture(), ['test'], {
      ORKAS_TEST_PYTHON: path.join(os.tmpdir(), 'project-python'), ORKAS_EVAL_PYTHON: '',
    });
    expect(result.status).toBe(0);
    expect(result.records.map(record => [record.family, record.testPython, record.evalPython])).toEqual([
      ['js', path.join(os.tmpdir(), 'project-python'), path.join(os.tmpdir(), 'project-python')],
      ['resources', path.join(os.tmpdir(), 'project-python'), path.join(os.tmpdir(), 'project-python')],
    ]);
  });

  it('passes targeted file/name filters intact to JS without starting the resource suite', () => {
    const args = ['--run', 'test/selected case.test.ts', '--testNamePattern', 'keeps two words'];
    const result = invoke(fixture(), ['test', '--', ...args]);
    expect(result.status).toBe(0);
    expect(result.records.map(record => [record.family, record.args])).toEqual([['js', ['run', ...args]]]);
    expect(result.records[0].electronNode).toBe('1');
    expect(result.records[0].outerNode).toBe(node);
  });

  it.each([
    { js: '0', resources: '0', expected: 0, families: ['js', 'resources'] },
    { js: '7', resources: '0', expected: 7, families: ['js'] },
    { js: '0', resources: '9', expected: 9, families: ['js', 'resources'] },
  ])('preserves unfiltered suite order and failure exit ($js/$resources)', ({ js, resources, expected, families }) => {
    const result = invoke(fixture(), ['test'], { JS_EXIT: js, RESOURCE_EXIT: resources });
    expect(result.status).toBe(expected);
    expect(result.records.map(record => record.family)).toEqual(families);
    expect(result.records[0].args).toEqual(['run']);
    if (families.length === 2) expect(result.records[1].args).toEqual(['resources/builtin', 'resources/test', '-q']);
  });

  it('propagates a selected test failure without running other suites', () => {
    const result = invoke(fixture(), ['test', '--', 'test/selected.test.ts'], { JS_EXIT: '5' });
    expect(result.status).toBe(5);
    expect(result.records.map(record => [record.family, record.args]))
      .toEqual([['js', ['run', 'test/selected.test.ts']]]);
  });

  it('keeps the explicit JS entry compatible', () => {
    const result = invoke(fixture(), ['run', 'test:js', '--', 'test/selected.test.ts']);
    expect(result.status).toBe(0);
    expect(result.records.map(record => [record.family, record.args]))
      .toEqual([['js', ['run', 'test/selected.test.ts']]]);
  });

  it.skipIf(process.platform === 'win32').each(['js', 'resources'])(
    'forwards cancellation to the active %s child and never reports success', async (family) => {
      const root = fixture();
      const child = spawn(node, [path.join(root, 'scripts/run-tests.mjs'), 'suite'], {
        cwd: root, env: { ...process.env, HOLD_FAMILY: family }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let cancelled = false;
      child.stderr.on('data', data => { stderr += data.toString(); });
      child.stdout.on('data', data => {
        stdout += data.toString();
        const ready = stdout.split(/\r?\n/).some(line => {
          if (!line.startsWith('EXEC:')) return false;
          try { return JSON.parse(line.slice(5)).family === family; } catch { return false; }
        });
        if (ready && !cancelled) { cancelled = true; child.kill('SIGTERM'); }
      });
      const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      expect(cancelled).toBe(true);
      expect(result).toEqual({ code: null, signal: 'SIGTERM' });
      const families = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line.slice(5)).family);
      expect(families).toEqual(family === 'js' ? ['js'] : ['js', 'resources']);
      expect(stderr.trim().split(/\r?\n/)).toEqual([
        ...families.map(item => `${item}-diagnostic`), `${family}-stopped`,
      ]);
    },
  );
});
