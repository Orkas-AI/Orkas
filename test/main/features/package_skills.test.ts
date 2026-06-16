import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Read-side contract tests for the CLI-package companion-skill domain
// (`<uid>/local/package_skills/`). Companion files are written out-of-process
// by bin/orkas-pkg.cjs skill-write; this suite pins the discovery + registry
// join + env-summary de-dup invariants the open-tier loader depends on.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

function pkgsDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'packages');
}
function companionDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'package_skills');
}

function writeRegistry(registry: unknown): void {
  fs.mkdirSync(pkgsDir(), { recursive: true });
  fs.writeFileSync(path.join(pkgsDir(), '_registry.json'), JSON.stringify(registry));
}

function writeCompanion(pkg: string, body = '---\nname: x\ndescription: y\n---\n'): string {
  const dir = path.join(companionDir(), pkg);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
  return dir;
}

const CLI_PKG = {
  name: 'crawl4ai',
  kind: 'cli',
  skill_roots: [],
  bin_entries: [
    { name: 'crwl', target: '.venv/bin/crwl', runtime: 'python' },
    { name: 'crawl4ai-setup', target: '.venv/bin/crawl4ai-setup', runtime: 'python' },
  ],
  enabled: true,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-pkgskills-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function load() {
  return import('../../../src/main/features/package_skills');
}
async function loadPackages() {
  return import('../../../src/main/features/packages');
}

describe('package_skills › discovery', () => {
  it('companionSkillFileExists reflects on-disk SKILL.md', async () => {
    const { companionSkillFileExists } = await load();
    expect(companionSkillFileExists(TEST_UID, 'crawl4ai')).toBe(false);
    writeCompanion('crawl4ai');
    expect(companionSkillFileExists(TEST_UID, 'crawl4ai')).toBe(true);
  });

  it('companionSkillsRootIfPopulated returns the parent only when a child SKILL.md exists', async () => {
    const { companionSkillsRootIfPopulated } = await load();
    expect(companionSkillsRootIfPopulated(TEST_UID)).toBeNull();
    // empty child dir (no SKILL.md) does not count
    fs.mkdirSync(path.join(companionDir(), 'empty'), { recursive: true });
    expect(companionSkillsRootIfPopulated(TEST_UID)).toBeNull();
    writeCompanion('crawl4ai');
    expect(companionSkillsRootIfPopulated(TEST_UID)).toBe(path.resolve(companionDir()));
  });

  it('companionPackageForDir maps a child dir to its package, rejects parent/outside', async () => {
    const { companionPackageForDir } = await load();
    expect(companionPackageForDir(TEST_UID, path.join(companionDir(), 'crawl4ai'))).toBe('crawl4ai');
    // the parent itself is not a package dir
    expect(companionPackageForDir(TEST_UID, companionDir())).toBeNull();
    // a nested grandchild is not a top-level companion
    expect(companionPackageForDir(TEST_UID, path.join(companionDir(), 'a', 'b'))).toBeNull();
    // an unrelated path
    expect(companionPackageForDir(TEST_UID, pkgsDir())).toBeNull();
  });
});

describe('packages › buildEnvSummaryLine de-dup', () => {
  it('lists CLI bin names when there is no companion skill', async () => {
    writeRegistry({ version: 1, packages: [CLI_PKG] });
    const { buildEnvSummaryLine } = await loadPackages();
    const line = buildEnvSummaryLine(TEST_UID);
    expect(line).toContain('`crwl`');
    expect(line).toContain('`crawl4ai-setup`');
  });

  it('drops a package whose bins are documented by a companion skill', async () => {
    writeRegistry({ version: 1, packages: [CLI_PKG] });
    writeCompanion('crawl4ai');
    const { buildEnvSummaryLine } = await loadPackages();
    const line = buildEnvSummaryLine(TEST_UID);
    expect(line).toBe('No external package CLIs installed.');
  });

  it('keeps a second CLI package that has no companion', async () => {
    writeRegistry({
      version: 1,
      packages: [
        CLI_PKG,
        { name: 'other', kind: 'cli', skill_roots: [], bin_entries: [{ name: 'oth', target: 'bin/oth', runtime: 'node' }], enabled: true },
      ],
    });
    writeCompanion('crawl4ai');
    const { buildEnvSummaryLine } = await loadPackages();
    const line = buildEnvSummaryLine(TEST_UID);
    expect(line).toContain('`oth`');
    expect(line).not.toContain('`crwl`');
  });
});
