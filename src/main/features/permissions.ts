/**
 * Local-execution permission state.
 *
 * Single per-install flag that gates the `bash` / `write_file` /
 * `markdown_to_pdf` / `html_to_pdf` tools. The app runs real shell commands
 * and writes real files on the host, so the user has to grant consent
 * explicitly once.
 *
 * Stored in `data/config/permissions.json` (local-only; not synced across
 * devices — see CLAUDE.md §4). Corrupt / missing file → fail closed (not
 * granted).
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

const DEFAULT_STATE: LocalExecState = { granted: false };

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
    return {
      localExec: {
        granted: le.granted === true,
        ...(typeof le.grantedAt === 'string' ? { grantedAt: le.grantedAt } : {}),
        ...(typeof le.revokedAt === 'string' ? { revokedAt: le.revokedAt } : {}),
      },
    };
  } catch (err) {
    log.warn(`permissions.json read failed, defaulting to not-granted: ${(err as Error).message}`);
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
  log.info('local execution granted');
  return next;
}

export function revokeLocalExec(): LocalExecState {
  const next: LocalExecState = { granted: false, revokedAt: nowIso() };
  writeFileAtomic({ localExec: next });
  log.info('local execution revoked');
  return next;
}
