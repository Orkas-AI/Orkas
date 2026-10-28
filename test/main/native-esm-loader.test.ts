import { finished } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
let root: string, dependency: string;
const project = process.cwd();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-native-esm-'));
  dependency = path.join(root, 'node_modules/fixture');
  fs.mkdirSync(dependency, { recursive: true });
  fs.mkdirSync(path.join(root, 'src/main'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(project, 'bootstrap.cjs'), path.join(root, 'bootstrap.cjs'));
  fs.copyFileSync(path.join(project, 'src/main/install-data-root.cjs'), path.join(root, 'src/main/install-data-root.cjs'));
  const helper = path.join(project, 'src/main/util/native-esm-loader.js');
  fs.mkdirSync(path.join(root, 'src/main/util'));
  if (fs.existsSync(helper)) fs.copyFileSync(helper, path.join(root, 'src/main/util/native-esm-loader.js'));
  fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', exports: './index.mjs' }));
  const tsx = path.join(root, 'node_modules/tsx');
  fs.mkdirSync(tsx, { recursive: true });
  fs.writeFileSync(path.join(tsx, 'package.json'), JSON.stringify({ exports: { './cjs': './cjs.cjs', './esm/api': './esm.cjs' } }));
  fs.writeFileSync(path.join(tsx, 'cjs.cjs'), `module.exports = require(${JSON.stringify(path.join(project, 'node_modules/tsx/dist/cjs/index.cjs'))});`);
  fs.writeFileSync(path.join(tsx, 'esm.cjs'), `
    const api = require(${JSON.stringify(path.join(project, 'node_modules/tsx/dist/esm/api/index.cjs'))});
    module.exports.register = () => {
      api.register();
      if (process.env.FAULT_NATIVE_TRANSFORM === '1') require('node:module').register('./fault-loader.mjs', require('node:url').pathToFileURL(${JSON.stringify(root + path.sep)}));
    };
  `);
  // A native JavaScript graph must not depend on the TypeScript worker. This
  // controlled failure gives the cold-load regression a deterministic signal.
  fs.writeFileSync(path.join(root, 'fault-loader.mjs'), `
    export function resolve(specifier, context, next) {
      if (specifier.endsWith('.mjs')) throw Object.assign(new Error('Unnecessary native transpilation'), { code: 'E_NATIVE_TRANSFORM' });
      return next(specifier, context);
    }
    export function load(url, context, next) {
      if (url.endsWith('.mjs')) throw Object.assign(new Error('Unnecessary native transpilation'), { code: 'E_NATIVE_TRANSFORM' });
      return next(url, context);
    }
  `);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function isAsarStatsDeprecation(stderr: string, executable: string) {
  // Node's warning formatter derives the hint from basename(process.argv0,
  // '.exe'). execFile gives the child the executable path as its argv0.
  const label = path.basename(executable, '.exe').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\(node:\\d+\\) \\[DEP0180\\] DeprecationWarning: fs\\.Stats constructor is deprecated\\.\\r?\\n\\(Use \`${label} --trace-deprecation \\.\\.\\.\` to show where the warning was created\\)\\r?\\n$`).test(stderr);
}

async function run(body: string, env: Record<string, string> = {}, packed = false) {
  const result = path.join(root, 'result.json');
  fs.writeFileSync(path.join(root, 'src/main/index.js'), `
    const fs = require('node:fs');
    (async () => { ${body} })().then(value => fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ value })),
      error => fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ error: error.code || error.name })));
  `);
  let entry = path.join(root, 'bootstrap.cjs');
  if (packed) {
    const stage = path.join(root, 'stage'), archive = path.join(root, 'app.asar');
    fs.mkdirSync(stage);
    for (const name of ['bootstrap.cjs', 'src', 'node_modules', 'fault-loader.mjs']) {
      fs.cpSync(path.join(root, name), path.join(stage, name), { recursive: true });
    }
    await finished(await (await import('@electron/asar')).createPackage(stage, archive));
    entry = path.join(archive, 'bootstrap.cjs');
  }
  const output = await execute(process.execPath, [entry], {
    cwd: root, env: { ...process.env, ...env },
  });
  if (packed && output.stderr) {
    // Electron's ASAR stat adapter uses the deprecated Node Stats constructor.
    // Retain this exact diagnostic as a review warning; all other stderr fails.
    expect(isAsarStatsDeprecation(output.stderr, process.execPath), output.stderr).toBe(true);
    console.warn('ASAR filesystem deprecation retained', { code: 'DEP0180' });
  } else expect(output.stderr).toBe('');
  return JSON.parse(fs.readFileSync(result, 'utf8'));
}

describe('native ESM dependency loading', () => {
  it.each(['electron', 'Electron', 'electron.exe'])('recognizes only the ASAR Stats warning for executable %s', executable => {
    const label = path.basename(executable, '.exe');
    const warning = `(node:123) [DEP0180] DeprecationWarning: fs.Stats constructor is deprecated.\n(Use \`${label} --trace-deprecation ...\` to show where the warning was created)\n`;
    expect(isAsarStatsDeprecation(warning, executable)).toBe(true);
    expect(isAsarStatsDeprecation(warning + 'unexpected warning\n', executable)).toBe(false);
    expect(isAsarStatsDeprecation(warning.replace('DEP0180', 'DEP0001'), executable)).toBe(false);
    expect(isAsarStatsDeprecation(warning.replace('fs.Stats', 'another API'), executable)).toBe(false);
    expect(isAsarStatsDeprecation(warning.replace(`${label} --trace`, 'other --trace'), executable)).toBe(false);
  });

  it('resolves a shared native dependency once across a diamond graph', async () => {
    fs.writeFileSync(path.join(dependency, 'shared.mjs'), 'export const identity = {};');
    for (const name of ['left', 'right']) {
      fs.writeFileSync(path.join(dependency, `${name}.mjs`), "export { identity } from './shared.mjs';");
    }
    fs.writeFileSync(path.join(dependency, 'index.mjs'), "export { identity as left } from './left.mjs'; export { identity as right } from './right.mjs';");
    expect(await run(`
      const original = fs.realpathSync;
      let probes = 0;
      fs.realpathSync = function(value, ...args) {
        if (String(value).endsWith('shared.mjs')) probes++;
        return original.call(this, value, ...args);
      };
      const value = await import('fixture');
      return { shared: value.left === value.right, probes };
    `)).toEqual({ value: { shared: true, probes: 1 } });
  });
  it('loads unchanged native dependency bytes and one shared instance without the transpilation worker', async () => {
    fs.writeFileSync(path.join(dependency, 'shared.mjs'), 'globalThis.initialized = (globalThis.initialized || 0) + 1; export let value = 20; export function add() { value++; }');
    fs.writeFileSync(path.join(dependency, 'index.mjs'), "import { value, add } from './shared.mjs'; export { value } from './shared.mjs'; add(); export const answer = value * 2;");
    expect(await run(`const [a, b] = await Promise.all([import('fixture'), import('fixture')]); return { answer: a.answer, live: a.value, same: a === b, initialized: globalThis.initialized };`, { FAULT_NATIVE_TRANSFORM: '1' }))
      .toEqual({ value: { answer: 42, live: 21, same: true, initialized: 1 } });
  });

  it('keeps TypeScript extension substitution and CommonJS dependency interop', async () => {
    fs.writeFileSync(path.join(dependency, 'typed.mts'), 'export const value: number = 42;');
    fs.writeFileSync(path.join(dependency, 'legacy.cjs'), 'module.exports = { label: "retained" };');
    fs.writeFileSync(path.join(dependency, 'index.mjs'), "import { value } from './typed.mjs'; import legacy from './legacy.cjs'; export const result = { value, label: legacy.label };");
    expect(await run("return (await import('fixture')).result;")).toEqual({ value: { value: 42, label: 'retained' } });
  });

  it('preserves query and fragment module identities and top-level await', async () => {
    fs.writeFileSync(path.join(dependency, 'index.mjs'), 'await Promise.resolve(); globalThis.initialized = (globalThis.initialized || 0) + 1; export const instance = globalThis.initialized;');
    expect(await run("const url = require('node:url').pathToFileURL(require.resolve('fixture')).href; return [(await import(url)).instance, (await import(url + '?copy')).instance, (await import(url + '#copy')).instance];"))
      .toEqual({ value: [1, 2, 3] });
  });

  it.each([
    ['missing', "await import('fixture/missing.mjs')", 'ERR_PACKAGE_PATH_NOT_EXPORTED'],
    ['relative missing', "await import(require('node:url').pathToFileURL(require.resolve('fixture')).href.replace('index.mjs', 'missing.mjs'))", 'ERR_MODULE_NOT_FOUND'],
    ['directory', "await import(require('node:url').pathToFileURL(require.resolve('fixture')).href.replace('index.mjs', 'directory.mjs'))", ['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']],
    ['wrong import attribute', "await import('fixture', { with: { type: 'json' } })", 'ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE'],
    ['source failure', "await import('fixture')", 'E_FIXTURE_SOURCE'],
  ])('retains the owning error for %s', async (kind, action, expected) => {
    fs.mkdirSync(path.join(dependency, 'directory.mjs'));
    fs.writeFileSync(path.join(dependency, 'index.mjs'), kind === 'source failure'
      ? "throw Object.assign(new Error('Fixture failure'), { code: 'E_FIXTURE_SOURCE' });" : 'export const value = 42;');
    const result = await run(action);
    if (Array.isArray(expected)) expect(expected).toContain(result.error);
    else expect(result).toEqual({ error: expected });
  });

  it('keeps real-path identity for a symlinked dependency', async () => {
    fs.writeFileSync(path.join(dependency, 'index.mjs'), 'export const identity = {};');
    fs.symlinkSync(path.join(dependency, 'index.mjs'), path.join(dependency, 'linked.mjs'));
    expect(await run("const url = require('node:url').pathToFileURL(require.resolve('fixture')).href; return (await import(url)).identity === (await import(url.replace('index.mjs', 'linked.mjs'))).identity;"))
      .toEqual({ value: true });
  });

  it('delegates a native-looking symlink whose real source still needs TypeScript', async () => {
    fs.writeFileSync(path.join(dependency, 'typed.mts'), 'export const value: number = 42;');
    fs.symlinkSync(path.join(dependency, 'typed.mts'), path.join(dependency, 'index.mjs'));
    expect(await run("return (await import('fixture')).value;")).toEqual({ value: 42 });
  });

  it('preserves explicit symlink policy and CommonJS callers', async () => {
    fs.writeFileSync(path.join(dependency, 'index.mjs'), 'export const identity = {}; export const value = 42;');
    fs.symlinkSync(path.join(dependency, 'index.mjs'), path.join(dependency, 'linked.mjs'));
    expect(await run("const url = require('node:url').pathToFileURL(require.resolve('fixture')).href; return { shared: (await import(url)).identity === (await import(url.replace('index.mjs', 'linked.mjs'))).identity, required: require('fixture').value };", {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--preserve-symlinks'].filter(Boolean).join(' '),
    })).toEqual({ value: { shared: false, required: 42 } });
  });

  it('loads encoded spaces without accepting encoded path separators', async () => {
    fs.writeFileSync(path.join(dependency, 'space name.mjs'), 'export const value = 42;');
    fs.writeFileSync(path.join(dependency, 'index.mjs'), "export { value } from './space%20name.mjs';");
    expect(await run("const url = require('node:url').pathToFileURL(require.resolve('fixture')).href; let rejected = false; try { await import(url.replace('index.mjs', 'sub%2Fname.mjs')); } catch { rejected = true; } return { rejected, value: (await import('fixture')).value };"))
      .toEqual({ value: { rejected: true, value: 42 } });
  });

  it('loads the packaged bootstrap helper and native dependency directly from ASAR', async () => {
    fs.writeFileSync(path.join(dependency, 'shared.mjs'), 'export const value = 42;');
    fs.writeFileSync(path.join(dependency, 'index.mjs'), "export { value } from './shared.mjs';");
    expect(await run("return (await import('fixture')).value;", { FAULT_NATIVE_TRANSFORM: '1' }, true))
      .toEqual({ value: 42 });
  });
});
