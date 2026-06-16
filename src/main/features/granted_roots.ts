/**
 * User-granted sandbox roots (plan §B2).
 *
 * The file tools (read_file / write_file / edit_file / grep_files / …) are
 * sandboxed to the active workspace + the current chat's attachment dir
 * (model/core-agent/local-tools.ts). That keeps agents from wandering the
 * disk, but it also blocks the legitimate "look at ~/Projects/foo for me"
 * flow. This module holds an explicit, user-approved allow-list of extra
 * directories, injected as `extraRoots` into the chat sandbox.
 *
 * Machine-private (`<uid>/local/config/granted-roots.json`): an absolute
 * path granted on this machine has no meaning on another device, and the
 * grant is a security decision that must not silently propagate via sync.
 *
 * A hard deny-list (credential dirs, system dirs, the Orkas trees) can
 * never be granted — same posture as skill-import blacklisting. The grant
 * stores the realpath so a later symlink swap can't widen scope, and the
 * sandbox's own `isPathAllowed` realpath check stays the final gate.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { userLocalConfigDir } from '../paths';
import { SRC_ROOT, WS_ROOT } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('granted-roots');

function storeFile(uid: string): string {
  return path.join(userLocalConfigDir(uid), 'granted-roots.json');
}

interface StoreFile {
  version: 1;
  roots: Array<{ path: string; granted_at: string }>;
}

function read(uid: string): StoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(uid), 'utf8'));
    if (parsed && Array.isArray(parsed.roots)) {
      const roots = parsed.roots
        .filter((r: unknown): r is { path: string; granted_at?: string } =>
          !!r && typeof (r as { path?: unknown }).path === 'string')
        .map((r: { path: string; granted_at?: string }) => ({
          path: r.path,
          granted_at: typeof r.granted_at === 'string' ? r.granted_at : '',
        }));
      return { version: 1, roots };
    }
  } catch { /* missing / corrupt → empty */ }
  return { version: 1, roots: [] };
}

function write(uid: string, store: StoreFile): void {
  const p = storeFile(uid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** realpath when the path exists, else the literal — so deny-list roots
 *  compare on the same canonical footing as the candidate (macOS tmp/home
 *  resolve through /private symlinks). */
function _canon(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

/** Reason code when a path may not be granted (null = grantable). */
export function denyReason(dir: string): string | null {
  const real = _canon(dir);
  const home = _canon(os.homedir());

  if (!path.isAbsolute(real)) return 'E_NOT_ABSOLUTE';
  if (home && real === home) return 'E_HOME_ROOT';

  for (const root of [SRC_ROOT, WS_ROOT]) {
    const r = root && _canon(root);
    if (r && (real === r || real.startsWith(r + path.sep))) return 'E_ORKAS_DIR';
  }

  const sensitive = [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.orkas'),
    path.join(home, '.claude'),
    path.join(home, '.codex'),
  ];
  // POSIX system dirs. `/var` and `/private/var` are deliberately NOT here:
  // the macOS tmpdir realpaths into `/private/var/folders/...`, and blocking
  // all of /var would forbid legitimate scratch dirs. The dangerous targets
  // are the binary/config trees below; `/usr/local` (brew, user installs)
  // stays grantable via the exception.
  const sys = process.platform === 'win32'
    ? ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)']
    : ['/System', '/etc', '/usr', '/bin', '/sbin'];
  const sysExcept = ['/usr/local'];

  const hits = (roots: string[]) => roots.some((r) => real === r || real.startsWith(r + path.sep));
  if (hits(sensitive)) return 'E_CREDENTIALS_DIR';
  if (hits(sys) && !hits(sysExcept)) return 'E_SYSTEM_DIR';
  return null;
}

/** Resolved, existing granted roots for the sandbox `extraRoots`. Skips
 *  entries that no longer pass the deny-list (rules tightened since the
 *  grant) or no longer exist. */
export function grantedRootsForSandbox(uid: string): string[] {
  const out: string[] = [];
  for (const entry of read(uid).roots) {
    if (denyReason(entry.path)) continue;
    try { if (fs.statSync(entry.path).isDirectory()) out.push(entry.path); }
    catch { /* gone */ }
  }
  return out;
}

export interface GrantedRootRow { path: string; granted_at: string; exists: boolean }

export function listGrantedRoots(uid: string): GrantedRootRow[] {
  return read(uid).roots.map((r) => {
    let exists = false;
    try { exists = fs.statSync(r.path).isDirectory(); } catch { /* gone */ }
    return { path: r.path, granted_at: r.granted_at, exists };
  });
}

export class GrantedRootError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

/** Grant a directory. Throws GrantedRootError(code) on deny-list hit or a
 *  non-directory path. Idempotent on an already-granted realpath. */
export function grantRoot(uid: string, dir: string): GrantedRootRow {
  if (typeof dir !== 'string' || !dir.trim()) throw new GrantedRootError('E_PATH');
  let real: string;
  try { real = fs.realpathSync(dir); }
  catch { throw new GrantedRootError('E_NOT_FOUND'); }
  try { if (!fs.statSync(real).isDirectory()) throw new GrantedRootError('E_NOT_DIR'); }
  catch (err) { if (err instanceof GrantedRootError) throw err; throw new GrantedRootError('E_NOT_DIR'); }
  const reason = denyReason(real);
  if (reason) throw new GrantedRootError(reason);

  const store = read(uid);
  if (!store.roots.some((r) => r.path === real)) {
    store.roots.push({ path: real, granted_at: new Date().toISOString() });
    write(uid, store);
    log.info('root granted', { path: real });
  }
  return { path: real, granted_at: new Date().toISOString(), exists: true };
}

export function revokeRoot(uid: string, dir: string): boolean {
  const store = read(uid);
  const before = store.roots.length;
  store.roots = store.roots.filter((r) => r.path !== dir);
  if (store.roots.length === before) return false;
  write(uid, store);
  log.info('root revoked', { path: dir });
  return true;
}
