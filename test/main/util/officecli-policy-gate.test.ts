import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const gate = require('../../../bin/officecli-policy-gate.cjs') as {
  POLICY_FILES: Record<string, string>;
  verifyHostOfficeCliBinary(root: string, options?: {
    required?: boolean;
    spawnSync?: (
      file: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv },
    ) => { error?: Error; status: number; stdout: string; stderr: string };
  }): readonly string[];
  verifyOfficeCliRuntimePolicy(root: string): readonly string[];
};

describe('OfficeCLI runtime policy gate', () => {
  let fixtureRoot = '';

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-officecli-policy-'));
    for (const relativeFile of Object.values(gate.POLICY_FILES)) {
      const source = path.join(process.cwd(), relativeFile);
      const target = path.join(fixtureRoot, relativeFile);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  });

  afterEach(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('accepts the reviewed runtime policy and pinned host binary contract', () => {
    expect(gate.verifyOfficeCliRuntimePolicy(process.cwd())).toEqual(expect.arrayContaining([
      'mac-app-exec-denied',
      'embedded-electron-renderer',
      'no-officecli-screenshot-calls',
    ]));
    expect(gate.verifyHostOfficeCliBinary(process.cwd(), { required: true })).toEqual([
      'pinned-host-binary',
      'host-version-match',
      'view-html-cli-contract',
    ]);
  });

  it('disables OfficeCLI self-update for every host binary probe', () => {
    const scriptsDir = path.join(fixtureRoot, 'scripts');
    const resourcesDir = path.join(fixtureRoot, 'resources', 'officecli');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(resourcesDir, { recursive: true });
    const asset = 'officecli-test-host';
    const binary = path.join(resourcesDir, asset);
    fs.writeFileSync(binary, 'pinned-officecli-fixture');
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    fs.writeFileSync(path.join(scriptsDir, 'fetch-officecli.cjs'), [
      `exports.VERSION = 'v1.0.139';`,
      `exports.ASSETS = { '${process.platform}-${process.arch}': '${asset}' };`,
      `exports.SHA256 = { '${asset}': '${sha256}' };`,
      '',
    ].join('\n'));

    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const result = gate.verifyHostOfficeCliBinary(fixtureRoot, {
      required: true,
      spawnSync: (_file, args, options) => {
        calls.push({ args, env: options.env });
        return {
          status: 0,
          stdout: args[0] === '--version' ? '1.0.139\n' : 'html --page --out\n',
          stderr: '',
        };
      },
    });

    expect(result).toEqual(['pinned-host-binary', 'host-version-match', 'view-html-cli-contract']);
    expect(calls.map(call => call.args)).toEqual([['--version'], ['view', '--help']]);
    expect(calls.every(call => call.env?.OFFICECLI_SKIP_UPDATE === '1')).toBe(true);
  });

  it('fails if an upgrade removes the macOS installed-App execution boundary', () => {
    const engine = path.join(fixtureRoot, gate.POLICY_FILES.engine);
    fs.writeFileSync(
      engine,
      fs.readFileSync(engine, 'utf8').replace(
        '(deny process-exec (subpath "/Applications"))',
        '(allow process-exec (subpath "/Applications"))',
      ),
    );
    expect(() => gate.verifyOfficeCliRuntimePolicy(fixtureRoot)).toThrow(/no longer denies installed app execution/);
  });

  it('fails if Office previews regress to the OfficeCLI screenshot backend', () => {
    const bypass = path.join(fixtureRoot, 'src/main/features/office/unsafe-preview.ts');
    fs.writeFileSync(bypass, [
      "import { runOfficeCli as launch } fr" + "om './office_engine';",
      "const argv = ['view', 'deck.pptx', 'screenshot'];",
      "void launch(argv, { cwd: '.' });",
      '',
    ].join('\n'));
    expect(() => gate.verifyOfficeCliRuntimePolicy(fixtureRoot)).toThrow(/forbidden OfficeCLI screenshot backend/);
  });

  it('fails if another main-process module bypasses the sole OfficeCLI engine owner', () => {
    const bypass = path.join(fixtureRoot, 'src/main/features/office/direct-binary.ts');
    fs.writeFileSync(bypass, [
      "import { officeCliBinaryPath as resolveOfficeCli } fr" + "om '../../paths';",
      'void resolveOfficeCli();',
      '',
    ].join('\n'));
    expect(() => gate.verifyOfficeCliRuntimePolicy(fixtureRoot)).toThrow(/outside the sole engine owner/);
  });

  it('is wired into fetch, Office regression, npm prepack, and electron-builder beforePack', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(packageJson.scripts['officecli:fetch']).toContain('--require-host-binary');
    expect(packageJson.scripts['test:office-artifacts']).toContain('--require-host-binary');
    expect(packageJson.scripts.prepack).toContain('--require-host-binary');
    expect(packageJson.build.beforePack).toBe('scripts/ensure-runtime-before-pack.cjs');

    const beforePack = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'ensure-runtime-before-pack.cjs'),
      'utf8',
    );
    expect(beforePack).toContain('requ' + 'ire(' + "'../bin/officecli-policy-gate.cjs'" + ')');
    expect(beforePack).toContain('verifyOfficeCliRuntimePolicy(pcRoot)');
  });
});
