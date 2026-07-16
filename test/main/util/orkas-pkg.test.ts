import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

// Integration tests for bin/orkas-pkg.cjs — install/scan/registry/shim
// lifecycle against real local git repos (git clone accepts a local path
// source, so no network involved). The registry written here is the
// contract consumed by features/packages.ts + run-skill.cjs.

const TEST_UID = 'u1';
let tmpDir: string;
let wsRoot: string;

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const itOnNonWindows = process.platform === 'win32' ? it.skip : it;

function pkgsDir(): string {
  return path.join(wsRoot, TEST_UID, 'local', 'packages');
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

/** Create a local git repo fixture with the given files. */
function makeRepo(name: string, files: Record<string, string>): string {
  const repo = path.join(tmpDir, 'repos', name);
  fs.mkdirSync(repo, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  return repo;
}

function runPkgWithEnv(extraEnv: Record<string, string>, ...args: string[]) {
  const pcRoot = process.cwd();
  const r = spawnSync(TEST_NODE, [path.join(pcRoot, 'bin', 'orkas-pkg.cjs'), ...args], {
    cwd: pcRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      ORKAS_WORKSPACE_ROOT: wsRoot,
      ORKAS_UID: TEST_UID,
      ORKAS_PC_DIR: pcRoot,
    },
  });
  // git clone progress is inherited onto stderr, so the JSON payload is the
  // trailing `{...}` block of whichever stream carries the result.
  const text = (r.status === 0 ? r.stdout : r.stderr) || '';
  const start = text.indexOf('{');
  let json: any = null;
  if (start !== -1) {
    try { json = JSON.parse(text.slice(start)); } catch { /* asserted by callers */ }
  }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function runPkg(...args: string[]) {
  return runPkgWithEnv({}, ...args);
}

function runPkgInput(input: string, ...args: string[]) {
  const pcRoot = process.cwd();
  const r = spawnSync(TEST_NODE, [path.join(pcRoot, 'bin', 'orkas-pkg.cjs'), ...args], {
    cwd: pcRoot,
    encoding: 'utf8',
    input,
    env: { ...process.env, ORKAS_WORKSPACE_ROOT: wsRoot, ORKAS_UID: TEST_UID, ORKAS_PC_DIR: pcRoot },
  });
  const text = (r.status === 0 ? r.stdout : r.stderr) || '';
  const start = text.indexOf('{');
  let json: any = null;
  if (start !== -1) { try { json = JSON.parse(text.slice(start)); } catch { /* asserted by callers */ } }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function companionFile(pkg: string): string {
  return path.join(wsRoot, TEST_UID, 'local', 'package_skills', pkg, 'SKILL.md');
}

function readRegistry(): any {
  return JSON.parse(fs.readFileSync(path.join(pkgsDir(), '_registry.json'), 'utf8'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-pkg-'));
  wsRoot = path.join(tmpDir, 'data');
  fs.mkdirSync(wsRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('orkas-pkg.cjs source invariants', () => {
  it('hides dependency subprocess windows on Windows', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'bin', 'orkas-pkg.cjs'), 'utf8');
    const body = source.match(/function run\(cmd, args, opts\) \{[\s\S]*?\n\}/)?.[0] ?? '';

    expect(body).toContain('windowsHide: true');
  });
});

describe.skipIf(!gitAvailable)('orkas-pkg.cjs', () => {
  it('installs a skill-shaped repo verbatim and records skill roots', () => {
    const repo = makeRepo('skillpack', {
      'SKILL.md': '---\nname: skillpack\ndescription: top-level\n---\nbody',
      'skills/sub-a/SKILL.md': '---\nname: sub-a\ndescription: nested\n---\nbody',
      'README.md': 'hello',
    });
    const r = runPkg('install', repo);
    expect(r.status).toBe(0);
    expect(r.json.ok).toBe(true);
    expect(r.json.kind).toBe('skill');
    expect(r.json.skill_roots).toEqual(expect.arrayContaining(['.', 'skills']));

    // Verbatim hosting: SKILL.md content untouched (no frontmatter rewrite).
    const installed = path.join(pkgsDir(), 'skillpack');
    expect(fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8'))
      .toBe('---\nname: skillpack\ndescription: top-level\n---\nbody');

    const reg = readRegistry();
    expect(reg.packages).toHaveLength(1);
    expect(reg.packages[0].enabled).toBe(true);
    expect(reg.packages[0].commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('rejects a repo with neither skills nor CLI entry points', () => {
    const repo = makeRepo('agent-only', { 'README.md': 'agent stuff', 'agent.yaml': 'x' });
    const r = runPkg('install', repo);
    expect(r.status).toBe(65);
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain('not installable');
    // Nothing promoted, no registry entry.
    expect(fs.existsSync(path.join(pkgsDir(), 'agent-only'))).toBe(false);
  });

  it('records CLI bin entries, creates shims, and defers deps without consent', () => {
    const repo = makeRepo('clitool', {
      'package.json': JSON.stringify({
        name: 'clitool',
        version: '1.0.0',
        bin: { clitool: 'bin/cli.js' },
        dependencies: { 'left-pad': '^1.0.0' },
      }),
      'bin/cli.js': '#!/usr/bin/env node\nconsole.log("hi")\n',
    });
    const r = runPkg('install', repo);
    expect(r.status).toBe(0);
    expect(r.json.kind).toBe('cli');
    expect(r.json.shims).toEqual(['clitool']);
    // Deps declared but no --consent-deps → reported, NOT installed.
    expect(r.json.deps_pending_consent).toEqual(['npm install --omit=dev']);
    expect(r.json.deps_installed).toEqual([]);
    expect(fs.existsSync(path.join(pkgsDir(), 'clitool', 'node_modules'))).toBe(false);

    // Shim exists, is executable, and targets the package entry file.
    const shim = path.join(pkgsDir(), '.bin', 'clitool');
    const content = fs.readFileSync(shim, 'utf8');
    expect(content).toContain(path.join(pkgsDir(), 'clitool', 'bin/cli.js'));
    expect(content).toContain('ORKAS_BUNDLED_NODE');
    expect(content).not.toContain('ORKAS_NODE');
  });

  itOnNonWindows('records package-local native executables and creates shims', () => {
    const repo = makeRepo('nativepkg', {
      'package.json': JSON.stringify({
        name: '@vendor/nativepkg',
        version: '1.0.0',
        private: true,
      }),
      'skills/native/SKILL.md': '---\nname: native\ndescription: native\n---\n',
      'npm/bin/native-tool': '#!/bin/sh\nprintf "native tool\\n"\n',
      'npm/bin/README.md': 'not executable',
    });
    fs.chmodSync(path.join(repo, 'npm', 'bin', 'native-tool'), 0o755);
    git(repo, 'add', '--chmod=+x', 'npm/bin/native-tool');
    git(repo, 'commit', '-qm', 'mark native executable');

    const r = runPkg('install', repo);
    expect(r.status).toBe(0);
    expect(r.json.kind).toBe('both');
    expect(r.json.bin_entries).toEqual(['native-tool']);
    expect(r.json.shims).toEqual(['native-tool']);
    const regEntry = readRegistry().packages[0];
    expect(regEntry.bin_entries).toEqual([{ name: 'native-tool', target: 'npm/bin/native-tool', runtime: 'native' }]);

    const shim = fs.readFileSync(path.join(pkgsDir(), '.bin', 'native-tool'), 'utf8');
    expect(shim).toContain(path.join(pkgsDir(), 'nativepkg', 'npm/bin/native-tool'));
  });

  itOnNonWindows('installs Node deps under the user package tree with Orkas npm cache/prefix', () => {
    const repo = makeRepo('npmpkg', {
      'package.json': JSON.stringify({
        name: 'npmpkg',
        version: '1.0.0',
        bin: { npmpkg: 'bin/cli.js' },
        dependencies: { 'left-pad': '1.3.0' },
      }),
      'package-lock.json': JSON.stringify({ name: 'npmpkg', lockfileVersion: 3, packages: {} }),
      'bin/cli.js': '#!/usr/bin/env node\nconsole.log("hi")\n',
    });
    const fakeBin = path.join(tmpDir, 'fake-bin');
    const fakeNpm = path.join(fakeBin, 'npm');
    const argsLog = path.join(tmpDir, 'npm-args.log');
    const cacheLog = path.join(tmpDir, 'npm-cache.log');
    const prefixLog = path.join(tmpDir, 'npm-prefix.log');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(fakeNpm, [
      '#!/bin/sh',
      'printf "%s\\n" "$*" > "$NPM_ARGS_LOG"',
      'printf "%s\\n" "$NPM_CONFIG_CACHE" > "$NPM_CACHE_LOG"',
      'printf "%s\\n" "$NPM_CONFIG_PREFIX" > "$NPM_PREFIX_LOG"',
      'mkdir -p node_modules/fake-dep',
      '',
    ].join('\n'));
    fs.chmodSync(fakeNpm, 0o755);

    const install = runPkg('install', repo);
    expect(install.status).toBe(0);
    expect(install.json.deps_pending_consent).toEqual(['npm ci --omit=dev']);
    expect(fs.existsSync(path.join(pkgsDir(), 'npmpkg', 'node_modules'))).toBe(false);

    const consent = runPkgWithEnv({
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
      NPM_ARGS_LOG: argsLog,
      NPM_CACHE_LOG: cacheLog,
      NPM_PREFIX_LOG: prefixLog,
    }, 'consent-deps', 'npmpkg');

    expect(consent.status).toBe(0);
    expect(consent.json.deps_installed).toEqual(['npm ci --omit=dev']);
    expect(fs.readFileSync(argsLog, 'utf8').trim()).toBe('ci --omit=dev --no-fund --no-audit');
    expect(fs.readFileSync(cacheLog, 'utf8').trim()).toBe(path.join(wsRoot, 'venv', 'node', 'cache', 'npm'));
    expect(fs.readFileSync(prefixLog, 'utf8').trim()).toBe(path.join(wsRoot, 'venv', 'node', 'prefix'));
    expect(fs.existsSync(path.join(pkgsDir(), 'npmpkg', 'node_modules', 'fake-dep'))).toBe(true);
    expect(path.join(pkgsDir(), 'npmpkg', 'node_modules')).toContain(path.join(TEST_UID, 'local', 'packages'));
  });

  it('parses pyproject [project.scripts] but not look-alike sections', () => {
    const repo = makeRepo('pytool', {
      'pyproject.toml': [
        '[build-system]',
        'requires = ["setuptools"]',
        '',
        '[tool.poetry.scripts]',
        'fake-entry = "pkg:never"',
        '',
        '[project.scripts]',
        '# comment line',
        'real-entry = "pkg.cli:main"',
        '',
        '[project.urls]',
        'homepage = "https://example.invalid"',
      ].join('\n'),
      'pkg/__init__.py': '',
    });
    const r = runPkg('install', repo);
    expect(r.status).toBe(0);
    const names = readRegistry().packages[0].bin_entries.map((b: any) => b.name);
    expect(names).toEqual(['real-entry']);
    // homepage lives in [project.urls], fake-entry in [tool.poetry.scripts] —
    // neither may leak into bin entries.
    expect(names).not.toContain('fake-entry');
    expect(names).not.toContain('homepage');
    // Console script not materialized (no venv) → no shim generated.
    expect(fs.existsSync(path.join(pkgsDir(), '.bin', 'real-entry'))).toBe(false);
  });

  itOnNonWindows('uses ORKAS_UV and ORKAS_PYTHON for Python package dependency consent', () => {
    const repo = makeRepo('pyuv', {
      'pyproject.toml': [
        '[build-system]',
        'requires = ["setuptools"]',
        '',
        '[project.scripts]',
        'real-entry = "pkg.cli:main"',
      ].join('\n'),
      'pkg/__init__.py': '',
    });
    const fakePython = path.join(tmpDir, 'fake-python');
    fs.writeFileSync(fakePython, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakePython, 0o755);
    const fakeUv = path.join(tmpDir, 'fake-uv');
    fs.writeFileSync(fakeUv, [
      '#!/bin/sh',
      'set -eu',
      'if [ "$1" = "venv" ]; then',
      '  if [ "$2" = "--python" ]; then venv="$4"; else venv="$2"; fi',
      '  mkdir -p "$venv/bin"',
      '  printf "#!/bin/sh\\nexit 0\\n" > "$venv/bin/python"',
      '  chmod +x "$venv/bin/python"',
      'elif [ "$1" = "pip" ]; then',
      '  venv="$(dirname "$(dirname "$4")")"',
      '  mkdir -p "$venv/bin"',
      '  printf "#!/bin/sh\\necho real-entry\\n" > "$venv/bin/real-entry"',
      '  chmod +x "$venv/bin/real-entry"',
      'else',
      '  exit 2',
      'fi',
      '',
    ].join('\n'));
    fs.chmodSync(fakeUv, 0o755);
    const env = { ORKAS_UV: fakeUv, ORKAS_PYTHON: fakePython };

    const install = runPkgWithEnv(env, 'install', repo);
    expect(install.status).toBe(0);
    expect(install.json.deps_pending_consent).toHaveLength(1);
    expect(install.json.deps_pending_consent[0]).toContain(path.join(wsRoot, 'venv', 'python', 'packages', 'pyuv-'));
    expect(install.json.deps_pending_consent[0]).toContain('$ORKAS_UV pip install --python');
    expect(install.json.deps_pending_consent[0]).not.toContain(' -e ');
    expect(fs.existsSync(path.join(pkgsDir(), '.bin', 'real-entry'))).toBe(false);

    const consent = runPkgWithEnv(env, 'consent-deps', 'pyuv');
    expect(consent.status).toBe(0);
    expect(consent.json.deps_installed).toEqual(['uv pip install .']);
    expect(consent.json.shims).toEqual(['real-entry']);
    expect(fs.existsSync(path.join(pkgsDir(), 'pyuv', '.venv', 'bin', 'real-entry'))).toBe(false);
    const shim = fs.readFileSync(path.join(pkgsDir(), '.bin', 'real-entry'), 'utf8');
    expect(shim).toContain(path.join(wsRoot, 'venv', 'python', 'packages'));
    expect(fs.existsSync(path.join(pkgsDir(), '.bin', 'real-entry'))).toBe(true);
  });

  it('refuses duplicate install and supports remove', () => {
    const repo = makeRepo('dup', { 'SKILL.md': '---\nname: dup\n---\nx' });
    expect(runPkg('install', repo).status).toBe(0);
    const again = runPkg('install', repo);
    expect(again.status).toBe(73);
    expect(again.json.error).toContain('already exists');

    const rm = runPkg('remove', 'dup');
    expect(rm.status).toBe(0);
    expect(fs.existsSync(path.join(pkgsDir(), 'dup'))).toBe(false);
    expect(readRegistry().packages).toHaveLength(0);
  });

  it('skill-write authors a companion outside the package tree, and remove prunes it', () => {
    const repo = makeRepo('clionly', {
      'package.json': JSON.stringify({ name: 'clionly', version: '1.0.0', bin: { clionly: 'bin/cli.js' } }),
      'bin/cli.js': '#!/usr/bin/env node\n',
    });
    expect(runPkg('install', repo).json.kind).toBe('cli');

    const md = '---\nname: clionly\ndescription: drive the clionly CLI\n---\n# clionly\nrun `clionly --help`\n';
    const w = runPkgInput(md, 'skill-write', 'clionly');
    expect(w.status).toBe(0);
    expect(w.json.action).toBe('skill-write');
    // Written OUTSIDE the verbatim package tree, with a sidecar _meta.json.
    expect(fs.readFileSync(companionFile('clionly'), 'utf8')).toBe(md);
    expect(fs.existsSync(path.join(pkgsDir(), 'clionly', 'SKILL.md'))).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(companionFile('clionly')), '_meta.json'), 'utf8'));
    expect(meta.source_package).toBe('clionly');

    // remove prunes the companion too — no orphan.
    expect(runPkg('remove', 'clionly').status).toBe(0);
    expect(fs.existsSync(companionFile('clionly'))).toBe(false);
  });

  it('skill-write rejects an uninstalled package and malformed frontmatter', () => {
    const ghost = runPkgInput('---\nname: x\ndescription: y\n---\n', 'skill-write', 'ghost');
    expect(ghost.status).toBe(66);

    const repo = makeRepo('cli2', {
      'package.json': JSON.stringify({ name: 'cli2', version: '1.0.0', bin: { cli2: 'bin/cli.js' } }),
      'bin/cli.js': '#!/usr/bin/env node\n',
    });
    runPkg('install', repo);
    // No frontmatter at all → rejected, nothing written.
    const bad = runPkgInput('just a body, no frontmatter', 'skill-write', 'cli2');
    expect(bad.status).toBe(65);
    expect(fs.existsSync(companionFile('cli2'))).toBe(false);
    // Frontmatter missing description → rejected.
    const noDesc = runPkgInput('---\nname: cli2\n---\nbody', 'skill-write', 'cli2');
    expect(noDesc.status).toBe(65);
  });

  it('list reflects installed packages', () => {
    const repo = makeRepo('listed', { 'SKILL.md': '---\nname: listed\n---\nx' });
    runPkg('install', repo);
    const r = runPkg('list');
    expect(r.status).toBe(0);
    expect(r.json.packages).toHaveLength(1);
    expect(r.json.packages[0]).toMatchObject({ name: 'listed', kind: 'skill', enabled: true });
  });

  it('enable/disable flips the registry flag and regenerates shims', () => {
    const repo = makeRepo('toggle', {
      'package.json': JSON.stringify({ name: 'toggle', version: '1.0.0', bin: { toggle: 'cli.js' } }),
      'cli.js': '#!/usr/bin/env node\n',
    });
    runPkg('install', repo);
    // Installed + enabled → shim exists.
    expect(fs.existsSync(path.join(pkgsDir(), '.bin', 'toggle'))).toBe(true);

    const dis = runPkg('disable', 'toggle');
    expect(dis.status).toBe(0);
    expect(readRegistry().packages[0].enabled).toBe(false);
    // Disabled → shim removed from PATH.
    expect(fs.existsSync(path.join(pkgsDir(), '.bin', 'toggle'))).toBe(false);

    const en = runPkg('enable', 'toggle');
    expect(en.status).toBe(0);
    expect(readRegistry().packages[0].enabled).toBe(true);
    expect(fs.existsSync(path.join(pkgsDir(), '.bin', 'toggle'))).toBe(true);
  });

  it('enable/disable on an unknown package errors', () => {
    expect(runPkg('disable', 'ghost').status).toBe(66);
  });

  itOnNonWindows('refuses to install a repo containing a symbolic link (escape defense)', () => {
    // A public repo can legitimately ship symlinks; one pointing outside the
    // package would let the scan/read follow it out of the tree. Reject install.
    const repo = path.join(tmpDir, 'repos', 'evilpack');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), 'hi');
    const secret = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(secret, 'TOPSECRET');
    fs.symlinkSync(secret, path.join(repo, 'SKILL.md')); // SKILL.md -> outside the package
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');

    const r = runPkg('install', repo);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/symbolic link/i);
    const regPath = path.join(pkgsDir(), '_registry.json');
    const installed = fs.existsSync(regPath) ? JSON.parse(fs.readFileSync(regPath, 'utf8')).packages.length : 0;
    expect(installed).toBe(0);
  });

  it('refuses a non-allowlisted git source scheme (ext:: command-execution vector)', () => {
    // --name so the source passes name validation and reaches the scheme check.
    const r = runPkg('install', 'ext::sh -c "echo pwned"', '--name', 'evilpkg');
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/unsupported source/i);
  });
});
