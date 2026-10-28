import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { finished } from 'node:stream/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bootstrap-entry-'));
  fs.copyFileSync(
    path.resolve(process.cwd(), 'bootstrap.cjs'),
    path.join(root, 'bootstrap.cjs'),
  );

  const tsxRoot = path.join(root, 'node_modules', 'tsx');
  fs.mkdirSync(tsxRoot, { recursive: true });
  fs.writeFileSync(path.join(tsxRoot, 'package.json'), JSON.stringify({
    name: 'tsx',
    version: '0.0.0-test',
    exports: {
      './cjs': './cjs.cjs',
      './esm/api': './esm-api.cjs',
    },
  }));
  fs.writeFileSync(path.join(tsxRoot, 'cjs.cjs'), 'module.exports = {};\n');
  fs.writeFileSync(
    path.join(tsxRoot, 'esm-api.cjs'),
    'module.exports = { register() {} };\n',
  );

  const mainRoot = path.join(root, 'src', 'main');
  fs.mkdirSync(mainRoot, { recursive: true });
  fs.mkdirSync(path.join(mainRoot, 'util'));
  fs.copyFileSync(path.join(process.cwd(), 'src/main/util/native-esm-loader.js'), path.join(mainRoot, 'util/native-esm-loader.js'));

});

afterEach(() => {
  require('original-fs').rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('desktop bootstrap entry', () => {
  // Windows container selection needs its native drive/pin fixture; never let
  // an ASAR contract case choose a real host drive as a side effect.
  it.skipIf(process.platform === 'win32')('cold-boots the packaged bootstrap and storage helpers from the configured ASAR file projection', async () => {
    const storageHelpers = ['src/main/install-data-root.cjs', 'src/main/util/migrate-source-data-root.cjs'];
    for (const relative of storageHelpers) {
      fs.copyFileSync(path.join(process.cwd(), relative), path.join(root, relative));
    }
    fs.writeFileSync(path.join(root, 'src/main/index.js'), `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const expected = path.join(require('node:os').homedir(), '.orkas', 'data');
      assert.equal(process.env.ORKAS_WORKSPACE_ROOT, expected);
      assert.ok(fs.statSync(expected).isDirectory());
      assert.ok(fs.statSync(path.join(expected, '.migrated-from-source')).isFile());
      assert.equal(typeof require('./util/migrate-source-data-root.cjs').migrateSourceDataRoot, 'function');
      process.stdout.write('BOOTSTRAP_ASAR_OK');
    `);
    // Use the real ASAR glob crawler and archive writer with production file
    // patterns. The controlled Main/tsx boundaries avoid starting the desktop;
    // the bootstrap and both early storage modules are their actual bytes.
    const { createPackageWithOptions, extractFile } = require('@electron/asar');
    const patterns: string[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).build.files;
    const archive = path.join(root, 'app.asar');
    const output = await createPackageWithOptions(root, archive, {
      pattern: `/{${patterns.filter((pattern) => !pattern.startsWith('!')).join(',')}}`,
      globOptions: { ignore: patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => path.join(root, pattern.slice(1)).replaceAll('\\', '/')) },
    });
    await finished(output);
    const launcher = path.join(root, 'launch.cjs');
    fs.writeFileSync(launcher, `
      require('node:os').homedir = () => require('node:path').join(__dirname, 'isolated-home');
      require('./app.asar/bootstrap.cjs');
    `);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.ORKAS_WORKSPACE_ROOT;
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const result = spawnSync(process.execPath, [launcher], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr.replaceAll(root, '<fixture>')).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('BOOTSTRAP_ASAR_OK');
    for (const relative of storageHelpers) {
      expect(extractFile(archive, relative)).toEqual(fs.readFileSync(path.join(process.cwd(), relative)));
    }
  }, 15000);

  it.each([
    { platform: 'darwin', defaultApp: true, override: false },
    { platform: 'linux', defaultApp: true, override: false },
    { platform: 'darwin', defaultApp: false, override: false },
    { platform: 'win32', defaultApp: true, override: true },
  ])('initializes storage before TypeScript or Main can read paths: %j', (scenario) => {
    const expected = scenario.override ? path.join(root, 'override') : path.join(root, '.orkas', 'data');
    const env: Record<string, string> = scenario.override ? { ORKAS_WORKSPACE_ROOT: expected } : {};
    const runtime = { platform: scenario.platform, defaultApp: scenario.defaultApp, env, argv: [], versions: {} };
    const events: string[] = [];
    const bootstrap = fs.readFileSync(path.join(root, 'bootstrap.cjs'), 'utf8');
    runInNewContext(bootstrap, {
      __dirname: root, process: runtime,
      require(name: string) {
        if (name === 'node:fs') return fs;
        if (name === 'node:path') return path;
        if (name === './src/main/install-data-root.cjs') {
          const module = { exports: {} };
          runInNewContext(fs.readFileSync(path.resolve('src/main/install-data-root.cjs'), 'utf8'), {
            module, exports: module.exports, process: runtime,
            require(dependency: string) {
              if (dependency === 'node:fs') return fs;
              if (dependency === 'node:path') return path;
              if (dependency === 'node:os') return { homedir: () => root };
              if (dependency === 'node:child_process') return { execFileSync() { throw new Error('Unexpected host probe'); } };
              if (dependency === './util/migrate-source-data-root.cjs') return { migrateSourceDataRoot() {} };
              throw new Error(`Unexpected install-root import: ${dependency}`);
            },
          });
          return module.exports;
        }
        if (name === 'tsx/cjs' || name === './src/main') {
          // Both TypeScript loaders and newly added Main imports may read paths
          // immediately. No test setup workspace override may hide a cold boot.
          expect(env.ORKAS_WORKSPACE_ROOT).toBe(expected);
          if (!scenario.override) expect(fs.statSync(expected).isDirectory()).toBe(true);
          events.push(name);
          return {};
        }
        if (name === 'tsx/esm/api') return { register() {} };
        if (name === './src/main/util/native-esm-loader.js') return { registerNativeEsmLoader() {} };
        throw new Error(`Unexpected bootstrap import: ${name}`);
      },
    });
    expect(events).toEqual(['tsx/cjs', './src/main']);
    if (scenario.override) expect(fs.existsSync(path.join(root, '.orkas'))).toBe(false);
  });

  it.each([
    { platform: 'darwin', defaultApp: true, hide: '1', accessory: true },
    { platform: 'darwin', defaultApp: true, hide: '0', accessory: false },
    { platform: 'darwin', defaultApp: true, hide: '', accessory: false },
    { platform: 'darwin', defaultApp: false, hide: '1', accessory: false },
    { platform: 'win32', defaultApp: true, hide: '1', accessory: false },
  ])('sets background activation before loading Main only for hidden macOS source runs: %j', (scenario) => {
    const events: string[] = [];
    runInNewContext(fs.readFileSync(path.join(root, 'bootstrap.cjs'), 'utf8'), {
      __dirname: root,
      process: {
        platform: scenario.platform, defaultApp: scenario.defaultApp,
        env: { ORKAS_E2E_HIDE_WINDOW: scenario.hide }, argv: [], versions: {},
      },
      require(name: string) {
        if (name === 'node:fs') return fs;
        if (name === 'node:path') return path;
        if (name === 'electron') return { app: { setActivationPolicy: (policy: string) => events.push(policy) } };
        if (name === './src/main/install-data-root.cjs') return {};
        if (name === 'tsx/cjs') return {};
        if (name === 'tsx/esm/api') return { register() {} };
        if (name === './src/main/util/native-esm-loader.js') return { registerNativeEsmLoader() {} };
        if (name === './src/main') { events.push('main'); return {}; }
        throw new Error(`Unexpected bootstrap import: ${name}`);
      },
    });
    expect(events).toEqual(scenario.accessory ? ['accessory', 'main'] : ['main']);
  });

});
