import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { finished } from 'node:stream/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { createPackageWithOptions, statFile } = require('@electron/asar');

describe('operator policy packaged runtime', () => {
  it('loads the real Worker from ASAR, enforces rules, terminates slow regex and recovers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-policy-asar-'));
    try {
      const stage = path.join(root, 'stage');
      const archive = path.join(root, 'app.asar');
      const copy = (relative: string) => {
        const target = path.join(stage, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(path.join(process.cwd(), relative), target, { recursive: true });
      };
      copy('src/main/quality');
      copy('src/main/util/token-estimate.ts');
      copy('src/main/util/skill-description-policy.ts');
      const build = require('../../../package.json').build;
      for (const dep of ['tsx', 'get-tsconfig', 'resolve-pkg-maps', 'esbuild', '@esbuild']) {
        expect(build.asarUnpack).toContain(`node_modules/${dep}/**/*`);
        copy(`node_modules/${dep}`);
      }
      const unpack = build.asarUnpack.map((pattern: string) => path.join(stage, pattern).replaceAll('\\', '/'));
      // asar 3 returns its output stream before the archive handle closes.
      // Windows must not read or remove the fixture until that close completes.
      const output = await createPackageWithOptions(stage, archive, { unpack: `{${unpack.join(',')}}` });
      await finished(output);
      expect(statFile(archive, 'src/main/quality/operator-worker.js').unpacked).not.toBe(true);
      const launcher = path.join(root, 'launch.cjs');
      fs.writeFileSync(launcher, `
        require('node:module').createRequire(require('node:path').join(__dirname, 'app.asar', 'entry.cjs'))('tsx/cjs');
        const { runOperatorPolicy } = require('./app.asar/src/main/quality');
        const assert = require('node:assert/strict');
        const policy = pattern => JSON.stringify({ version: 1, rules: [{ id: 'blocked', level: 'EXTREME', pattern }] });
        const request = content => ({ kind: 'files', files: [{ relpath: 'run.sh', content }] });
        (async () => {
          const hit = await runOperatorPolicy(policy('private-resource'), request('echo private-resource'));
          assert.equal(hit.reports?.[0].ok, false, JSON.stringify(hit));
          assert.ok(hit.reports[0].violations.some(v => v.rule === 'operator:blocked'));
          let ticks = 0;
          const timer = setInterval(() => ticks++, 10);
          const slow = await runOperatorPolicy(policy('^(a+)+$'), request('a'.repeat(31) + '!'));
          clearInterval(timer);
          assert.equal(slow.error, 'timeout');
          assert.ok(ticks > 10);
          const next = await runOperatorPolicy(policy('private-resource'), request('echo safe'));
          assert.equal(next.reports?.[0].ok, true, JSON.stringify(next));
          process.stdout.write('POLICY_ASAR_OK');
        })().catch(e => { console.error(e); process.exitCode = 1; });
      `);
      // Match bootstrap.cjs: esbuild's executable must use its real unpacked path.
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ESBUILD_BINARY_PATH: path.join(
        `${archive}.unpacked`, 'node_modules', '@esbuild', `${process.platform}-${process.arch}`,
        ...(process.platform === 'win32' ? ['esbuild.exe'] : ['bin', 'esbuild']),
      ) };
      expect(fs.existsSync(env.ESBUILD_BINARY_PATH)).toBe(true);
      delete env.NODE_OPTIONS;
      delete env.NODE_PATH;
      const result = spawnSync(process.execPath, [launcher], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
      expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(0);
      expect(result.stdout).toContain('POLICY_ASAR_OK');
    } finally {
      // Electron's fs wrapper treats ASARs as directories; delete the real archive.
      require('original-fs').rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 30000);
});
