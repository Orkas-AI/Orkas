/**
 * Local access permission state.
 *
 * This is the account-level, cloud-synced posture for local machine access.
 * The product has three modes:
 *
 *   - `workspace_approval` — cautious. Agents may work inside the active
 *                            workspace / conversation attachments; sensitive
 *                            operations require user approval.
 *   - `all_files_approval` — default / regular. Agents may access paths
 *                            outside the workspace; sensitive operations
 *                            still require approval.
 *   - `all_files_auto`     — agents may access paths outside the workspace;
 *                            sensitive operations do not prompt.
 *
 * Stored in `<uid>/cloud/config/permissions.json` and synced across devices.
 * Corrupt / missing file falls back to `all_files_approval`.
 *
 * Back-compat: older builds stored `off | risk_prompt | allow_all` or
 * `localExec.granted: boolean`. Those shapes are accepted and migrated to the
 * new safe equivalents on read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userLocalConfigDir, userPermissionsFile } from '../paths';
import { nowIso } from '../storage';
import { getActiveUserId } from './users';
import { createLogger } from '../logger';

const log = createLogger('permissions');

export type LocalExecMode = 'workspace_approval' | 'all_files_approval' | 'all_files_auto';
type LegacyLocalExecMode = 'off' | 'risk_prompt' | 'allow_all';

const MODES: readonly LocalExecMode[] = ['workspace_approval', 'all_files_approval', 'all_files_auto'];
const LEGACY_MODES: readonly LegacyLocalExecMode[] = ['off', 'risk_prompt', 'allow_all'];

/** Damaged / missing file falls back here; never to the no-approval mode. */
const DEFAULT_MODE: LocalExecMode = 'all_files_approval';

export interface LocalExecState {
  mode: LocalExecMode;
  /** Kept for legacy callers. New modes all allow local execution; the mode
   * decides filesystem breadth and approval behavior. */
  granted: boolean;
  grantedAt?: string;
  revokedAt?: string;
}

interface StoredState {
  mode: LocalExecMode;
  grantedAt?: string;
  revokedAt?: string;
}

interface StoredFile {
  version?: number;
  localExec?: unknown;
  _field_updated_at?: {
    localExec?: number;
  };
}

function isMode(v: unknown): v is LocalExecMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

function isLegacyMode(v: unknown): v is LegacyLocalExecMode {
  return typeof v === 'string' && (LEGACY_MODES as readonly string[]).includes(v);
}

function migrateLegacyMode(mode: LegacyLocalExecMode): LocalExecMode {
  if (mode === 'allow_all') return 'all_files_auto';
  if (mode === 'risk_prompt') return 'all_files_approval';
  return 'workspace_approval';
}

function filePath(): string {
  return userPermissionsFile(getActiveUserId());
}

function legacyFilePath(): string {
  return path.join(userLocalConfigDir(getActiveUserId()), 'permissions.json');
}

function _notifyDirty(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = null as { markDirty?: (domain: string, relPath: string) => void };
    sync?.markDirty?.('permissions', 'cloud/config/permissions.json');
  } catch { /* sync is optional in stripped builds / before account init */ }
}

function parseStoredFile(raw: string): StoredState | null {
  const parsed = JSON.parse(raw) as StoredFile;
  const le = parsed?.localExec;
  if (!le || typeof le !== 'object') return null;

  const rec = le as Record<string, unknown>;
  const grantedAt = typeof rec.grantedAt === 'string' ? rec.grantedAt : undefined;
  const revokedAt = typeof rec.revokedAt === 'string' ? rec.revokedAt : undefined;

  if (isMode(rec.mode)) {
    return { mode: rec.mode, ...(grantedAt ? { grantedAt } : {}), ...(revokedAt ? { revokedAt } : {}) };
  }
  if (isLegacyMode(rec.mode)) {
    return { mode: migrateLegacyMode(rec.mode), ...(grantedAt ? { grantedAt } : {}), ...(revokedAt ? { revokedAt } : {}) };
  }
  if (typeof rec.granted === 'boolean') {
    return {
      mode: rec.granted ? 'all_files_approval' : 'workspace_approval',
      ...(grantedAt ? { grantedAt } : {}),
      ...(revokedAt ? { revokedAt } : {}),
    };
  }
  return null;
}

/** Return:
 *   - `undefined` when the file is missing,
 *   - `null` when present but invalid/corrupt,
 *   - StoredState when valid.
 */
function readStoredAt(p: string): StoredState | null | undefined {
  try {
    if (!fs.existsSync(p)) return undefined;
    const state = parseStoredFile(fs.readFileSync(p, 'utf8'));
    if (!state) {
      log.warn(`${path.basename(p)} did not contain a valid localExec state, defaulting to ${DEFAULT_MODE}`);
      return null;
    }
    return state;
  } catch (err) {
    log.warn(`${path.basename(p)} read failed, defaulting to ${DEFAULT_MODE}: ${(err as Error).message}`);
    return null;
  }
}

function readClock(p: string): number {
  try {
    if (!fs.existsSync(p)) return 0;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const n = Number(parsed?._field_updated_at?.localExec);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function readStored(): StoredState {
  const fallback: StoredState = { mode: DEFAULT_MODE };
  const current = readStoredAt(filePath());
  if (current === null) return fallback;
  if (current) return current;

  const legacy = readStoredAt(legacyFilePath());
  if (legacy === null) return fallback;
  if (legacy) {
    writeStored(legacy);
    try { fs.rmSync(legacyFilePath(), { force: true }); } catch { /* best effort */ }
    log.info('migrated local access permission to cloud config');
    return legacy;
  }

  return fallback;
}

function writeStored(state: StoredState): void {
  const p = filePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  const clock = Math.max(Date.now(), readClock(p) + 1);
  fs.writeFileSync(tmp, JSON.stringify({
    version: 2,
    localExec: state,
    _field_updated_at: { localExec: clock },
  }, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  _notifyDirty();
}

function toPublic(state: StoredState): LocalExecState {
  return {
    mode: state.mode,
    granted: true,
    ...(state.grantedAt ? { grantedAt: state.grantedAt } : {}),
    ...(state.revokedAt ? { revokedAt: state.revokedAt } : {}),
  };
}

export function getLocalExecState(): LocalExecState {
  return toPublic(readStored());
}

export function getLocalExecMode(): LocalExecMode {
  return readStored().mode;
}

/** Legacy boolean check retained for existing tool wrappers. New modes all
 * allow local execution; scope/approval is enforced separately. */
export function getLocalExecGranted(): boolean {
  return true;
}

export function localAccessAllowsOutsideWorkspace(mode: LocalExecMode = getLocalExecMode()): boolean {
  return mode === 'all_files_approval' || mode === 'all_files_auto';
}

export function localAccessRequiresSensitiveApproval(mode: LocalExecMode = getLocalExecMode()): boolean {
  return mode !== 'all_files_auto';
}

export function setLocalExecMode(mode: LocalExecMode): LocalExecState {
  if (!isMode(mode)) throw new Error(`invalid local-access mode: ${String(mode)}`);
  const next: StoredState = { mode, grantedAt: nowIso() };
  writeStored(next);
  log.info(`local access mode set: ${mode}`);
  return toPublic(next);
}

// ── Back-compat helpers (legacy IPC / tests) ─────────────────────────────

/** Legacy "enable" maps to the most permissive new mode, matching the old
 * explicit grant behavior of "run without asking". */
export function grantLocalExec(): LocalExecState {
  return setLocalExecMode('all_files_auto');
}

/** Legacy "disable" no longer exists in the product. Map it to the safest
 * available new mode. */
export function revokeLocalExec(): LocalExecState {
  const next: StoredState = { mode: 'workspace_approval', revokedAt: nowIso() };
  writeStored(next);
  log.info('legacy local execution revoke mapped to workspace_approval');
  return toPublic(next);
}
