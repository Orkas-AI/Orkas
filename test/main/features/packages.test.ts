import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Read-side contract tests for the external-packages domain. The registry
// file is written out-of-process by bin/orkas-pkg.cjs (integration-tested in
// test/main/util/orkas-pkg.test.ts); this suite pins the sanitiser + root
// resolution invariants the skill loader and bash PATH injection depend on.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

function pkgsDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'packages');
}

function writeRegistry(registry: unknown): void {
  fs.mkdirSync(pkgsDir(), { recursive: true });
  fs.writeFileSync(path.join(pkgsDir(), '_registry.json'), JSON.stringify(registry));
}

function mkPkgDir(...segments: string[]): string {
  const dir = path.join(pkgsDir(), ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-packages-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadPackages() {
  return import('../../../src/main/features/packages');
}

describe('packages › readPackagesRegistry', () => {
  it('returns empty for missing or corrupt registry', async () => {
    const { readPackagesRegistry } = await loadPackages();
    expect(readPackagesRegistry(TEST_UID).packages).toEqual([]);
    fs.mkdirSync(pkgsDir(), { recursive: true });
    fs.writeFileSync(path.join(pkgsDir(), '_registry.json'), '{not json');
    expect(readPackagesRegistry(TEST_UID).packages).toEqual([]);
  });

  it('drops entries with unsafe names or traversal-bearing roots/targets', async () => {
    writeRegistry({
      version: 1,
      packages: [
        { name: '../evil', kind: 'skill', skill_roots: ['.'], bin_entries: [] },
        { name: 'has/slash', kind: 'skill', skill_roots: ['.'], bin_entries: [] },
        {
          name: 'ok',
          kind: 'both',
          skill_roots: ['skills', '../outside', '/abs', 'a/../..'],
          bin_entries: [
            { name: 'good', target: 'bin/cli.js', runtime: 'node' },
            { name: 'native', target: 'npm/bin/native', runtime: 'native' },
            { name: 'bad-target', target: '../../etc/passwd', runtime: 'node' },
            { name: 'bad-runtime', target: 'bin/x.js', runtime: 'deno' },
          ],
        },
      ],
    });
    const { readPackagesRegistry } = await loadPackages();
    const reg = readPackagesRegistry(TEST_UID);
    expect(reg.packages).toHaveLength(1);
    expect(reg.packages[0]!.name).toBe('ok');
    expect(reg.packages[0]!.skill_roots).toEqual(['skills']);
    expect(reg.packages[0]!.bin_entries.map((b) => b.name)).toEqual(['good', 'native']);
  });
});

describe('packages › enabledPackageSkillRoots', () => {
  it("maps '.' to the packages dir and rel roots to <pkg>/<rel>; skips disabled and missing", async () => {
    writeRegistry({
      version: 1,
      packages: [
        { name: 'top', kind: 'skill', skill_roots: ['.'], bin_entries: [], enabled: true },
        { name: 'nested', kind: 'skill', skill_roots: ['skills'], bin_entries: [], enabled: true },
        { name: 'off', kind: 'skill', skill_roots: ['skills'], bin_entries: [], enabled: false },
        { name: 'ghost', kind: 'skill', skill_roots: ['skills'], bin_entries: [], enabled: true },
      ],
    });
    mkPkgDir('top');
    mkPkgDir('nested', 'skills');
    mkPkgDir('off', 'skills');
    // 'ghost' has no dir on disk → must be filtered.
    const { enabledPackageSkillRoots } = await loadPackages();
    const roots = enabledPackageSkillRoots(TEST_UID);
    expect(roots).toContain(path.resolve(pkgsDir()));
    expect(roots).toContain(path.resolve(path.join(pkgsDir(), 'nested', 'skills')));
    expect(roots).toHaveLength(2);
  });

  it('de-duplicates the packages-dir root when several packages use "."', async () => {
    writeRegistry({
      version: 1,
      packages: [
        { name: 'a', kind: 'skill', skill_roots: ['.'], bin_entries: [], enabled: true },
        { name: 'b', kind: 'skill', skill_roots: ['.'], bin_entries: [], enabled: true },
      ],
    });
    mkPkgDir('a');
    mkPkgDir('b');
    const { enabledPackageSkillRoots } = await loadPackages();
    expect(enabledPackageSkillRoots(TEST_UID)).toEqual([path.resolve(pkgsDir())]);
  });
});

describe('packages › listPackagesForUi', () => {
  it('projects registry entries to UI rows with kind/enabled/counts', async () => {
    writeRegistry({
      version: 1,
      packages: [
        { name: 'alpha', kind: 'both', skill_roots: ['skills', '.'], bin_entries: [{ name: 'alpha', target: 'cli.js', runtime: 'node' }], enabled: true, repo_url: 'https://github.com/x/alpha', commit: 'abcdef1234567890', updated_at: '2026-06-01T00:00:00Z' },
        { name: 'beta', kind: 'skill', skill_roots: ['.'], bin_entries: [], enabled: false },
      ],
    });
    fs.writeFileSync(path.join(mkPkgDir('alpha'), 'SKILL.md'), '---\nname: alpha\ndescription: top\n---\n');
    fs.writeFileSync(path.join(mkPkgDir('alpha', 'skills', 'one'), 'SKILL.md'), '---\nname: one\ndescription: one\n---\n');
    fs.writeFileSync(path.join(mkPkgDir('alpha', 'skills', 'two'), 'SKILL.md'), '---\nname: two\ndescription: two\n---\n');
    fs.writeFileSync(path.join(mkPkgDir('beta'), 'SKILL.md'), '---\nname: beta\ndescription: beta\n---\n');
    const { listPackagesForUi } = await loadPackages();
    const rows = listPackagesForUi(TEST_UID);
    expect(rows).toHaveLength(2);
    const alpha = rows.find((r) => r.name === 'alpha')!;
    expect(alpha).toMatchObject({ kind: 'both', enabled: true, skill_count: 3, bin_names: ['alpha'] });
    expect(alpha.commit).toBe('abcdef123456'); // truncated to 12
    expect(rows.find((r) => r.name === 'beta')).toMatchObject({ enabled: false, skill_count: 1 });
  });

  it('uses the curated OSS catalog name as the external package display name', async () => {
    writeRegistry({
      version: 1,
      packages: [{
        name: 'cli',
        repo_url: 'https://github.com/hugohe3/ppt-master',
        kind: 'skill',
        skill_roots: ['skills'],
        bin_entries: [],
        enabled: true,
      }],
    });

    const { listPackagesForUi } = await loadPackages();
    expect(listPackagesForUi(TEST_UID)[0]).toMatchObject({
      name: 'cli',
      display_name: 'PPT-Master',
    });
  });
});

describe('packages › runPackageCommand guards', () => {
  it('rejects unsupported commands and bad names without spawning', async () => {
    const { runPackageCommand } = await loadPackages();
    expect((await runPackageCommand(TEST_UID, 'install', 'x')).ok).toBe(false);
    expect((await runPackageCommand(TEST_UID, 'enable', '../evil')).ok).toBe(false);
    expect((await runPackageCommand(TEST_UID, 'enable', 'has/slash')).error).toBe('invalid package name');
  });

  it('routes enable and disable through orkas-pkg and updates the registry', async () => {
    writeRegistry({
      version: 1,
      packages: [{
        name: 'toggle',
        kind: 'skill',
        skill_roots: ['.'],
        bin_entries: [],
        enabled: true,
      }],
    });
    mkPkgDir('toggle');

    const { readPackagesRegistry, runPackageCommand } = await loadPackages();
    const disabled = await runPackageCommand(TEST_UID, 'disable', 'toggle');
    expect(disabled.ok).toBe(true);
    expect(JSON.parse(disabled.stdout)).toMatchObject({ ok: true, action: 'disable', name: 'toggle' });
    expect(readPackagesRegistry(TEST_UID).packages[0]!.enabled).toBe(false);

    const enabled = await runPackageCommand(TEST_UID, 'enable', 'toggle');
    expect(enabled.ok).toBe(true);
    expect(JSON.parse(enabled.stdout)).toMatchObject({ ok: true, action: 'enable', name: 'toggle' });
    expect(readPackagesRegistry(TEST_UID).packages[0]!.enabled).toBe(true);
  });
});

describe('packages › packagesBinDirIfActive', () => {
  it('returns the .bin dir only when an enabled package ships bin entries AND the dir exists', async () => {
    const { packagesBinDirIfActive } = await loadPackages();
    // No registry at all.
    expect(packagesBinDirIfActive(TEST_UID)).toBeNull();

    // CLI package but .bin not materialized.
    writeRegistry({
      version: 1,
      packages: [{
        name: 'tool', kind: 'cli', skill_roots: [],
        bin_entries: [{ name: 'tool', target: 'bin/cli.js', runtime: 'node' }],
        enabled: true,
      }],
    });
    expect(packagesBinDirIfActive(TEST_UID)).toBeNull();

    // .bin exists → returned.
    mkPkgDir('.bin');
    expect(packagesBinDirIfActive(TEST_UID)).toBe(path.join(pkgsDir(), '.bin'));

    // Disabled package → null even though .bin exists.
    writeRegistry({
      version: 1,
      packages: [{
        name: 'tool', kind: 'cli', skill_roots: [],
        bin_entries: [{ name: 'tool', target: 'bin/cli.js', runtime: 'node' }],
        enabled: false,
      }],
    });
    expect(packagesBinDirIfActive(TEST_UID)).toBeNull();
  });
});

describe('packages › packagePathEntriesIfActive', () => {
  it('includes package-local executable bin dirs even when the registry has no generated shim', async () => {
    writeRegistry({
      version: 1,
      packages: [{
        name: 'native-cli',
        repo_url: 'https://github.com/example/native-cli',
        kind: 'skill',
        skill_roots: ['skills'],
        bin_entries: [],
        enabled: true,
      }],
    });
    const binDir = mkPkgDir('native-cli', 'npm', 'bin');
    const exe = path.join(binDir, process.platform === 'win32' ? 'native-cli.exe' : 'native-cli');
    fs.writeFileSync(exe, '');
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);

    const { packagePathEntriesIfActive } = await loadPackages();
    expect(packagePathEntriesIfActive(TEST_UID)).toContain(path.resolve(binDir));
  });

  it('keeps the generated .bin shim dir first and ignores disabled packages', async () => {
    writeRegistry({
      version: 1,
      packages: [
        {
          name: 'tool',
          kind: 'cli',
          skill_roots: [],
          bin_entries: [{ name: 'tool', target: 'bin/cli.js', runtime: 'node' }],
          enabled: true,
        },
        {
          name: 'off',
          kind: 'skill',
          skill_roots: ['skills'],
          bin_entries: [],
          enabled: false,
        },
      ],
    });
    const shimDir = mkPkgDir('.bin');
    const offBinDir = mkPkgDir('off', 'npm', 'bin');
    const offExe = path.join(offBinDir, process.platform === 'win32' ? 'off.exe' : 'off');
    fs.writeFileSync(offExe, '');
    if (process.platform !== 'win32') fs.chmodSync(offExe, 0o755);

    const { packagePathEntriesIfActive } = await loadPackages();
    expect(packagePathEntriesIfActive(TEST_UID)).toEqual([path.resolve(shimDir)]);
  });
});
