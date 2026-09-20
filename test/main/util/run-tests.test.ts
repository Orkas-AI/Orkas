import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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
      electronNode: process.env.ELECTRON_RUN_AS_NODE, outerNode: process.env.ORKAS_TEST_NODE }));
    console.error('${family}-diagnostic');
    if (process.env.HOLD_FAMILY !== '${family}') process.exit(Number(process.env.${family === 'js' ? 'JS' : 'RESOURCE'}_EXIT || 0));
  `;
  write('node_modules/vitest/vitest.mjs', child('js'));
  write('scripts/run-python-tests.mjs', child('resources'));
  return root;
}

function invoke(root: string, args: string[], env: Record<string, string> = {}) {
  const npm = process.env.npm_execpath;
  const command = npm ? node : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const commandArgs = npm ? [npm, ...args] : args;
  const result = spawnSync(command, commandArgs, {
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
