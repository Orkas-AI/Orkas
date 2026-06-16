import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// run-skill.cjs resolution across the external-packages root (registry-
// driven) + package-local dependency preference. Companion to
// test/main/util/run-skill.test.ts (custom/marketplace roots).

const TEST_UID = 'u1';
let tmpDir: string;

function pkgsDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'packages');
}

function writeRegistry(registry: unknown): void {
  fs.mkdirSync(pkgsDir(), { recursive: true });
  fs.writeFileSync(path.join(pkgsDir(), '_registry.json'), JSON.stringify(registry));
}

/** Package fixture: skills/<id>/{SKILL.md, scripts/<base>.js} + its own
 *  node_modules carrying a marker module the script imports. */
function writePackageSkill(pkgName: string, skillId: string, displayName: string): void {
  const pkgDir = path.join(pkgsDir(), pkgName);
  const skillDir = path.join(pkgDir, 'skills', skillId);
  const scriptsDir = path.join(skillDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${displayName}\ndescription: pkg skill\n---\nbody\n`,
  );
  // Marker dep vendored INSIDE the package — resolving it proves the
  // package-local node_modules is on the resolution path.
  const markerDir = path.join(pkgDir, 'node_modules', 'pkg-marker');
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(path.join(markerDir, 'package.json'), JSON.stringify({ name: 'pkg-marker', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(markerDir, 'index.js'), 'module.exports = "from-package-deps";');
  fs.writeFileSync(
    path.join(scriptsDir, 'hello.js'),
    'const marker = require("pkg-marker");\nmodule.exports = async ({ args }) => ({ marker, args });\n',
  );
}

function runSkill(skillRef: string, scriptBase: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const pcRoot = process.cwd();
  return spawnSync(process.execPath, [
    path.join(pcRoot, 'bin', 'run-skill.cjs'),
    skillRef,
    scriptBase,
    '--',
    ...args,
  ], {
    cwd: pcRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ORKAS_WORKSPACE_ROOT: tmpDir,
      ORKAS_PC_DIR: pcRoot,
      ORKAS_UID: TEST_UID,
      // Pin HOME into the sandbox tmp so the global-root scan
      // (~/.claude, ~/.codex) can't pick up skills from the developer machine.
      HOME: path.join(tmpDir, 'home'),
      USERPROFILE: path.join(tmpDir, 'home'),
      ...extraEnv,
    },
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-run-skill-pkg-'));
  fs.mkdirSync(path.join(tmpDir, 'home'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('run-skill.cjs › external packages root', () => {
  it('resolves a package skill by id and uses the package-local node_modules', () => {
    writePackageSkill('mypack', 'pkg-hello', 'pkg-hello');
    writeRegistry({
      version: 1,
      packages: [{ name: 'mypack', kind: 'skill', skill_roots: ['skills'], bin_entries: [], enabled: true }],
    });

    const r = runSkill('pkg-hello', 'hello', ['x']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ marker: 'from-package-deps', args: ['x'] });
  });

  it('resolves by SKILL.md display name when the dir id differs', () => {
    writePackageSkill('mypack', 'internal-dir-id', 'friendly-name');
    writeRegistry({
      version: 1,
      packages: [{ name: 'mypack', kind: 'skill', skill_roots: ['skills'], bin_entries: [], enabled: true }],
    });

    const r = runSkill('friendly-name', 'hello');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim()).marker).toBe('from-package-deps');
  });

  it('does not resolve skills from disabled packages', () => {
    writePackageSkill('mypack', 'pkg-hello', 'pkg-hello');
    writeRegistry({
      version: 1,
      packages: [{ name: 'mypack', kind: 'skill', skill_roots: ['skills'], bin_entries: [], enabled: false }],
    });

    const r = runSkill('pkg-hello', 'hello');
    expect(r.status).toBe(66);
    expect(r.stderr).toContain('skill script not found');
  });

  it('does not resolve package skills when the registry is absent (no blind scan)', () => {
    writePackageSkill('mypack', 'pkg-hello', 'pkg-hello');
    // No _registry.json on purpose.
    const r = runSkill('pkg-hello', 'hello');
    expect(r.status).toBe(66);
  });

  it('honors ORKAS_RUN_SKILL_DIR without falling back to other roots', () => {
    const allowed = path.join(tmpDir, TEST_UID, 'cloud', 'skills', 'allowed');
    const allowedScripts = path.join(allowed, 'scripts');
    fs.mkdirSync(allowedScripts, { recursive: true });
    fs.writeFileSync(path.join(allowed, 'SKILL.md'), '---\nname: allowed\ndescription: d\n---\n');
    fs.writeFileSync(path.join(allowedScripts, 'ok.sh'), 'printf \'{"ok":true,"where":"allowed"}\\n\'\n');

    const blockedScripts = path.join(tmpDir, 'home', '.codex', 'skills', 'blocked', 'scripts');
    fs.mkdirSync(blockedScripts, { recursive: true });
    fs.writeFileSync(path.join(path.dirname(blockedScripts), 'SKILL.md'), '---\nname: blocked\ndescription: g\n---\n');
    fs.writeFileSync(path.join(blockedScripts, 'steal.sh'), 'printf \'{"ok":false,"where":"blocked"}\\n\'\n');

    const ok = runSkill('allowed', 'ok', [], { ORKAS_RUN_SKILL_DIR: allowed });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout.trim())).toEqual({ ok: true, where: 'allowed' });

    const denied = runSkill('blocked', 'steal', [], { ORKAS_RUN_SKILL_DIR: allowed });
    expect(denied.status).toBe(66);
    expect(denied.stderr).toContain('skill script not found');
    expect(denied.stderr).not.toContain(path.join('.codex', 'skills', 'blocked'));
  });

  it('resolves global-root skills from ~/.claude/skills', () => {
    const skillDir = path.join(tmpDir, 'home', '.claude', 'skills', 'global-hello', 'scripts');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(skillDir), 'SKILL.md'),
      '---\nname: global-hello\ndescription: g\n---\nbody\n',
    );
    fs.writeFileSync(path.join(skillDir, 'hello.sh'), 'printf \'{"ok":true,"where":"global"}\\n\'\n');

    const r = runSkill('global-hello', 'hello');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true, where: 'global' });
  });

  it('resolves global-root skills from ~/.codex/skills (must stay in sync with paths.ts::globalSkillRoots)', () => {
    const skillDir = path.join(tmpDir, 'home', '.codex', 'skills', 'codex-hello', 'scripts');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(skillDir), 'SKILL.md'),
      '---\nname: codex-hello\ndescription: g\n---\nbody\n',
    );
    fs.writeFileSync(path.join(skillDir, 'hello.sh'), 'printf \'{"ok":true,"where":"codex"}\\n\'\n');

    const r = runSkill('codex-hello', 'hello');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true, where: 'codex' });
  });
});
