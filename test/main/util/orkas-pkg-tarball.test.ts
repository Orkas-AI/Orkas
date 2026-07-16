import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Unit + offline coverage for the git-free GitHub install path in
// bin/orkas-pkg.cjs: source classification (the parsing trap), tarball URL
// shape, tarball extraction/flatten/commit recovery, and the "no git +
// non-GitHub → git required" routing. A real network install is gated behind
// ORKAS_PKG_NET_TEST so CI stays offline.

const require = createRequire(import.meta.url);
const PKG_PATH = path.join(process.cwd(), 'bin', 'orkas-pkg.cjs');
const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;
const pkg = require(PKG_PATH) as {
  classifySource: (s: string) => { kind: string; owner?: string; repo?: string; ref?: string };
  githubTarballUrl: (cls: { owner: string; repo: string; ref?: string }) => string;
  extractGithubTarball: (archive: string, destDir: string) => { commit: string };
  findSymlink: (root: string) => string | null;
  isGithubHost: (hostname: string) => boolean;
  validGithubId: (s: string) => boolean;
};

const tarAvailable = spawnSync('tar', ['--version'], { encoding: 'utf8' }).status === 0;
const itWithTar = tarAvailable ? it : it.skip;
const itOnNonWindows = process.platform === 'win32' ? it.skip : it;

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-pkg-tb-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('classifySource', () => {
  it('recognizes GitHub https URLs (with and without .git / scheme / www)', () => {
    expect(pkg.classifySource('https://github.com/owner/repo'))
      .toEqual({ kind: 'github', owner: 'owner', repo: 'repo' });
    expect(pkg.classifySource('https://github.com/owner/repo.git'))
      .toEqual({ kind: 'github', owner: 'owner', repo: 'repo' });
    expect(pkg.classifySource('http://www.github.com/owner/repo'))
      .toEqual({ kind: 'github', owner: 'owner', repo: 'repo' });
    expect(pkg.classifySource('github.com/owner/repo'))
      .toEqual({ kind: 'github', owner: 'owner', repo: 'repo' });
  });

  it('recognizes the ssh form', () => {
    expect(pkg.classifySource('git@github.com:owner/repo.git'))
      .toEqual({ kind: 'github', owner: 'owner', repo: 'repo' });
  });

  it('extracts a ref from /tree/<branch> and from #<ref>', () => {
    expect(pkg.classifySource('https://github.com/owner/repo/tree/dev'))
      .toEqual({ kind: 'github', owner: 'owner', repo: 'repo', ref: 'dev' });
    expect(pkg.classifySource('https://github.com/owner/repo#v1.2.3'))
      .toEqual({ kind: 'github', owner: 'owner', repo: 'repo', ref: 'v1.2.3' });
  });

  it('rejects look-alikes — non-github hosts route to the git path, not github', () => {
    // Different host that merely ends in github.com-like text.
    expect(pkg.classifySource('https://mygithub.com/owner/repo').kind).toBe('git');
    expect(pkg.classifySource('https://github.company.com/owner/repo').kind).toBe('git');
    // A real non-github git host.
    expect(pkg.classifySource('https://gitlab.com/owner/repo.git').kind).toBe('git');
    // github.com without a repo segment is not a usable repo URL → git path.
    expect(pkg.classifySource('https://github.com/owner').kind).toBe('git');
  });

  it('classifies an existing local directory as local', () => {
    expect(pkg.classifySource(tmpDir).kind).toBe('local');
  });
});

describe('githubTarballUrl', () => {
  it('uses the api tarball endpoint and appends the ref when present', () => {
    expect(pkg.githubTarballUrl({ owner: 'o', repo: 'r' }))
      .toBe('https://api.github.com/repos/o/r/tarball');
    expect(pkg.githubTarballUrl({ owner: 'o', repo: 'r', ref: 'dev' }))
      .toBe('https://api.github.com/repos/o/r/tarball/dev');
  });
});

describe('extractGithubTarball', () => {
  itWithTar('flattens the single <repo>-<sha> top dir and recovers the commit', () => {
    const sha = 'a'.repeat(40);
    const top = `myrepo-${sha}`;
    const srcRoot = path.join(tmpDir, 'src');
    fs.mkdirSync(path.join(srcRoot, top, 'skills', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(srcRoot, top, 'SKILL.md'), '---\nname: myrepo\ndescription: x\n---\nbody');
    fs.writeFileSync(path.join(srcRoot, top, 'skills', 'sub', 'SKILL.md'), '---\nname: sub\ndescription: y\n---\nb');

    const archive = path.join(tmpDir, 'repo.tar.gz');
    const t = spawnSync('tar', ['-czf', archive, '-C', srcRoot, top], { encoding: 'utf8' });
    expect(t.status).toBe(0);

    const dest = path.join(tmpDir, 'out');
    const { commit } = pkg.extractGithubTarball(archive, dest);

    expect(commit).toBe(sha);
    // Top dir is flattened away: files land directly under dest.
    expect(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toContain('name: myrepo');
    expect(fs.existsSync(path.join(dest, 'skills', 'sub', 'SKILL.md'))).toBe(true);
    // No leftover temp extract dir beside dest.
    expect(fs.existsSync(`${dest}.x-${process.pid}`)).toBe(false);
  });
});

describe('install routing without git', () => {
  itOnNonWindows('errors clearly when git is absent and the source is not a public GitHub repo', () => {
    const wsRoot = path.join(tmpDir, 'data');
    fs.mkdirSync(wsRoot, { recursive: true });
    const emptyBin = path.join(tmpDir, 'empty-bin');
    fs.mkdirSync(emptyBin, { recursive: true });

    const r = spawnSync(TEST_NODE, [PKG_PATH, 'install', 'https://gitlab.com/foo/bar.git'], {
      encoding: 'utf8',
      env: {
        // Empty PATH ⇒ `git --version` ENOENTs ⇒ gitAvailable() === false.
        PATH: emptyBin,
        ORKAS_WORKSPACE_ROOT: wsRoot,
        ORKAS_UID: 'u1',
        ORKAS_PC_DIR: process.cwd(),
      },
    });
    expect(r.status).toBe(76);
    const text = r.stderr || '';
    expect(text).toContain('git is required');
  });
});

// Real end-to-end install over the network. Opt-in only (ORKAS_PKG_NET_TEST),
// non-Windows (uses a unix symlink + PATH to hide git while keeping tar).
describe.skipIf(!process.env.ORKAS_PKG_NET_TEST || process.platform === 'win32')('install over the network without git', () => {
  it('downloads a public GitHub repo as a tarball when git is unavailable', () => {
    const wsRoot = path.join(tmpDir, 'data');
    fs.mkdirSync(wsRoot, { recursive: true });
    // Isolated bin with ONLY tar (symlinked) — so `git --version` ENOENTs and
    // the tarball branch is exercised, while extraction still has tar. `node`
    // is found via the absolute test Node path regardless of PATH.
    const onlyTarBin = path.join(tmpDir, 'only-tar-bin');
    fs.mkdirSync(onlyTarBin, { recursive: true });
    const tarPath = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(tarPath, path.join(onlyTarBin, 'tar'));

    // octocat/Hello-World is tiny and stable but has no SKILL.md / CLI entry,
    // so a successful download+extract reaches the scan stage and exits 65.
    const r = spawnSync(TEST_NODE, [PKG_PATH, 'install', 'https://github.com/octocat/Hello-World'], {
      encoding: 'utf8',
      env: { PATH: onlyTarBin, ORKAS_WORKSPACE_ROOT: wsRoot, ORKAS_UID: 'u1', ORKAS_PC_DIR: process.cwd() },
    });
    // Proves the no-git tarball branch ran (not git clone).
    expect(r.stderr).toContain('downloading octocat/Hello-World tarball');
    expect(r.status).toBe(65);
  });
});

describe('orkas-pkg source hardening (security fixes)', () => {
  it('validGithubId accepts real ids and rejects traversal / odd chars', () => {
    for (const ok of ['owner', 'My-Repo', 'a.b_c', 'x1']) expect(pkg.validGithubId(ok)).toBe(true);
    for (const bad of ['..', 'a..b', 'a/b', 'a b', '', 'a;b', 'a:b']) expect(pkg.validGithubId(bad)).toBe(false);
  });

  it('classifySource refuses a github URL with traversal in owner/repo (falls through to git kind)', () => {
    expect(pkg.classifySource('https://github.com/../../admin/x').kind).toBe('git');
    expect(pkg.classifySource('https://github.com/owner/repo')).toMatchObject({ kind: 'github', owner: 'owner', repo: 'repo' });
  });

  it('githubTarballUrl encodes segments, keeps ref slashes, and pins api.github.com', () => {
    expect(pkg.githubTarballUrl({ owner: 'o', repo: 'r' })).toBe('https://api.github.com/repos/o/r/tarball');
    expect(pkg.githubTarballUrl({ owner: 'o', repo: 'r', ref: 'feature/bar' }))
      .toBe('https://api.github.com/repos/o/r/tarball/feature/bar');
    expect(pkg.githubTarballUrl({ owner: 'o', repo: 'r', ref: 'a b' }))
      .toBe('https://api.github.com/repos/o/r/tarball/a%20b');
  });

  it('isGithubHost allows only GitHub-owned hosts (redirect allowlist)', () => {
    for (const ok of ['api.github.com', 'codeload.github.com', 'github.com', 'objects.githubusercontent.com'])
      expect(pkg.isGithubHost(ok)).toBe(true);
    for (const bad of ['evil.com', 'github.com.evil.com', 'notgithub.com', 'githubusercontent.com.evil.com'])
      expect(pkg.isGithubHost(bad)).toBe(false);
  });

  itOnNonWindows('findSymlink reports the first repo-content symlink, skips top-level .git, null for a clean tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-sl-'));
    try {
      fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(root, 'sub', 'a.txt'), 'x');
      expect(pkg.findSymlink(root)).toBeNull();
      // a symlink inside .git (git metadata) is ignored
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      fs.symlinkSync('/etc/hosts', path.join(root, '.git', 'link'));
      expect(pkg.findSymlink(root)).toBeNull();
      // a symlink in repo content is reported (the escape vector)
      fs.symlinkSync('/etc/hosts', path.join(root, 'sub', 'SKILL.md'));
      expect(pkg.findSymlink(root)).toBe(path.join('sub', 'SKILL.md'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
