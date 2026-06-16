import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// User-granted sandbox roots (plan §B2): deny-list enforcement + store
// round-trip + sandbox filtering.

const TEST_UID = 'u-granted';
let tmpDir: string;
let prevWs: string | undefined;
let prevHome: string | undefined;

let homeDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-granted-'));
  // HOME and the workspace root must be DISJOINT — in production `~` and
  // `~/.orkas/data` don't nest, and the deny-list treats anything under
  // WS_ROOT as an Orkas dir.
  homeDir = path.join(tmpDir, 'home');
  const wsRoot = path.join(tmpDir, 'data');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(wsRoot, { recursive: true });
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevHome = process.env.HOME;
  process.env.ORKAS_WORKSPACE_ROOT = wsRoot;
  process.env.HOME = homeDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function load() {
  return import('../../../src/main/features/granted_roots');
}

describe('granted_roots › grant + list + revoke', () => {
  it('grants an ordinary directory and round-trips through the store', async () => {
    const target = path.join(homeDir, 'Projects', 'app');
    fs.mkdirSync(target, { recursive: true });
    const mod = await load();
    const row = mod.grantRoot(TEST_UID, target);
    expect(row.path).toBe(fs.realpathSync(target));
    expect(mod.listGrantedRoots(TEST_UID).map((r) => r.path)).toContain(fs.realpathSync(target));
    expect(mod.grantedRootsForSandbox(TEST_UID)).toContain(fs.realpathSync(target));

    expect(mod.revokeRoot(TEST_UID, fs.realpathSync(target))).toBe(true);
    expect(mod.listGrantedRoots(TEST_UID)).toHaveLength(0);
  });

  it('is idempotent on the same realpath (granting twice keeps one row)', async () => {
    const target = path.join(homeDir, 'docs');
    fs.mkdirSync(target);
    const mod = await load();
    mod.grantRoot(TEST_UID, target);
    mod.grantRoot(TEST_UID, target);
    expect(mod.listGrantedRoots(TEST_UID)).toHaveLength(1);
  });
});

describe('granted_roots › deny-list', () => {
  it('refuses credential and home-equivalent dirs', async () => {
    const mod = await load();
    const home = homeDir;

    const ssh = path.join(home, '.ssh');
    fs.mkdirSync(ssh, { recursive: true });
    expect(() => mod.grantRoot(TEST_UID, ssh)).toThrowError(/E_CREDENTIALS_DIR/);

    const claude = path.join(home, '.claude', 'skills');
    fs.mkdirSync(claude, { recursive: true });
    expect(() => mod.grantRoot(TEST_UID, claude)).toThrowError(/E_CREDENTIALS_DIR/);

    const codex = path.join(home, '.codex', 'skills');
    fs.mkdirSync(codex, { recursive: true });
    expect(() => mod.grantRoot(TEST_UID, codex)).toThrowError(/E_CREDENTIALS_DIR/);

    expect(() => mod.grantRoot(TEST_UID, home)).toThrowError(/E_HOME_ROOT/);
  });

  it('refuses the Orkas data root and rejects a non-existent path', async () => {
    const mod = await load();
    // WS_ROOT == tmpDir; granting it (or a child) must be blocked.
    const inside = path.join(tmpDir, 'data', TEST_UID);
    expect(() => mod.grantRoot(TEST_UID, inside)).toThrowError(/E_ORKAS_DIR/);
    expect(() => mod.grantRoot(TEST_UID, path.join(homeDir, 'nope'))).toThrowError(/E_NOT_FOUND/);
  });

  it('denyReason returns null for a plain grantable folder', async () => {
    const mod = await load();
    const ok = path.join(homeDir, 'work');
    fs.mkdirSync(ok);
    expect(mod.denyReason(ok)).toBeNull();
  });

  it('drops a previously-granted root that now hits the deny-list at read time', async () => {
    // Grant a fine dir, then point the store at a sensitive path on disk to
    // simulate rules tightening / symlink swap — grantedRootsForSandbox
    // must filter it out even though it is recorded.
    const mod = await load();
    const ok = path.join(homeDir, 'ok');
    fs.mkdirSync(ok);
    mod.grantRoot(TEST_UID, ok);
    expect(mod.grantedRootsForSandbox(TEST_UID)).toContain(fs.realpathSync(ok));

    // Hand-write a credential dir into the store (bypassing grantRoot).
    const aws = path.join(homeDir, '.aws');
    fs.mkdirSync(aws, { recursive: true });
    const storePath = path.join(tmpDir, 'data', TEST_UID, 'local', 'config', 'granted-roots.json');
    const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    store.roots.push({ path: aws, granted_at: '2026-01-01T00:00:00Z' });
    fs.writeFileSync(storePath, JSON.stringify(store));

    const sandbox = mod.grantedRootsForSandbox(TEST_UID);
    expect(sandbox).toContain(fs.realpathSync(ok));
    expect(sandbox).not.toContain(aws);
  });
});
