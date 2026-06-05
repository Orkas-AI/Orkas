/**
 * Local-execution permission state.
 *
 * Single per-install flag that gates tools which execute commands or write
 * local state (`bash`, write/edit/delete file, PDF/artifact generation, and
 * companion generators such as images). It defaults to enabled; users can
 * turn it off from Settings when they want read-only agent behavior.
 *
 * Stored in `data/config/permissions.json` (local-only; not synced across
 * devices — see CLAUDE.md §4). Corrupt / missing file → default enabled.
 *
 * Contract:
 *   - `getLocalExecGranted()` is called at every tool execute(). Cheap: one
 *     sync read of a ~200-byte file.
 *   - `grantLocalExec()` / `revokeLocalExec()` write atomically (tmp + rename).
 *   - Revoke clears `grantedAt` — intent is "latest wins", no history.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userLocalConfigDir } from '../paths';
import { nowIso } from '../storage';
import { getActiveUserId } from './users';
import { createLogger } from '../logger';

const log = createLogger('permissions');

export interface LocalExecState {
  granted: boolean;
  /** Set when granted. Cleared on revoke. */
  grantedAt?: string;
  /** Set on every revoke. Previous value overwritten. */
  revokedAt?: string;
}

interface PermissionsFile {
  localExec: LocalExecState;
}

const DEFAULT_STATE: LocalExecState = { granted: true };

function filePath(): string {
  return path.join(userLocalConfigDir(getActiveUserId()), 'permissions.json');
}

function readFileSafe(): PermissionsFile {
  const p = filePath();
  try {
    if (!fs.existsSync(p)) return { localExec: { ...DEFAULT_STATE } };
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    const le = parsed?.localExec;
    if (!le || typeof le !== 'object') return { localExec: { ...DEFAULT_STATE } };
    if (typeof le.granted !== 'boolean') return { localExec: { ...DEFAULT_STATE } };
    return {
      localExec: {
        granted: le.granted,
        ...(typeof le.grantedAt === 'string' ? { grantedAt: le.grantedAt } : {}),
        ...(typeof le.revokedAt === 'string' ? { revokedAt: le.revokedAt } : {}),
      },
    };
  } catch (err) {
    log.warn(`permissions.json read failed, defaulting to granted: ${(err as Error).message}`);
    return { localExec: { ...DEFAULT_STATE } };
  }
}

function writeFileAtomic(data: PermissionsFile): void {
  const p = filePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** Snapshot the full local-exec permission state. */
export function getLocalExecState(): LocalExecState {
  return readFileSafe().localExec;
}

/** Fast boolean check used by the tool wrappers on every execute(). */
export function getLocalExecGranted(): boolean {
  return getLocalExecState().granted === true;
}

export function grantLocalExec(): LocalExecState {
  const next: LocalExecState = { granted: true, grantedAt: nowIso() };
  writeFileAtomic({ localExec: next });
  log.info('tool execution access granted');
  return next;
}

export function revokeLocalExec(): LocalExecState {
  const next: LocalExecState = { granted: false, revokedAt: nowIso() };
  writeFileAtomic({ localExec: next });
  log.info('tool execution access revoked');
  return next;
}
