/**
 * Local-execution permission state.
 *
 * Per-install mode that gates tools which execute commands or write local
 * state (`bash`, write/edit/delete file, PDF/artifact generation, and
 * companion generators such as images). Three modes:
 *
 *   - `off`         — read-only agent. Every execution-class tool is denied.
 *   - `risk_prompt` — DEFAULT. Execution tools run; `bash` additionally
 *                     classifies the command (model/core-agent/bash-risk.ts)
 *                     and prompts the user before running a *risky* command
 *                     (network exfil, recursive delete outside the workspace,
 *                     privilege escalation, sensitive paths). Write/edit/delete
 *                     keep their existing path-sandbox + delete-confirm gates.
 *   - `allow_all`   — execution tools run with no bash prompting (the legacy
 *                     "granted" behavior).
 *
 * Stored in `<uid>/local/config/permissions.json` (local-only; not synced
 * across devices — see CLAUDE.md §4). Corrupt / missing file → DEFAULT mode
 * (`risk_prompt`): a damaged file must never silently fall open to full
 * unprompted execution.
 *
 * Back-compat: the file historically stored `localExec.granted: boolean`.
 * On read, a legacy `granted:true` migrates to `risk_prompt` (the new safe
 * "on"), `granted:false` to `off`. `getLocalExecGranted()` is retained for
 * the existing tool wrappers (bash / write / edit / delete / pdf / image),
 * returning `mode !== 'off'` so "off = nothing runs" is unchanged.
 *
 * Contract:
 *   - `getLocalExecMode()` / `getLocalExecGranted()` are called at every tool
 *     execute(). Cheap: one sync read of a ~200-byte file.
 *   - `setLocalExecMode()` writes atomically (tmp + rename); "latest wins".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userLocalConfigDir } from '../paths';
import { nowIso } from '../storage';
import { getActiveUserId } from './users';
import { createLogger } from '../logger';

const log = createLogger('permissions');

export type LocalExecMode = 'off' | 'risk_prompt' | 'allow_all';

const MODES: readonly LocalExecMode[] = ['off', 'risk_prompt', 'allow_all'];

/** Damaged / missing file falls back here — never to `allow_all`. */
const DEFAULT_MODE: LocalExecMode = 'risk_prompt';

export interface LocalExecState {
  mode: LocalExecMode;
  /** Derived (`mode !== 'off'`). Kept for back-compat with callers / renderer
   *  that only care whether execution is enabled at all. */
  granted: boolean;
  /** Set when leaving `off`. Cleared when entering `off`. */
  grantedAt?: string;
  /** Set when entering `off`. */
  revokedAt?: string;
}

interface StoredState {
  mode: LocalExecMode;
  grantedAt?: string;
  revokedAt?: string;
}

function isMode(v: unknown): v is LocalExecMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v);
}

function filePath(): string {
  return path.join(userLocalConfigDir(getActiveUserId()), 'permissions.json');
}

/** Read + migrate the persisted state. Never throws; defaults on any
 *  ambiguity. Returns the stored shape (mode + timestamps). */
function readStored(): StoredState {
  const fallback: StoredState = { mode: DEFAULT_MODE };
  const p = filePath();
  try {
    if (!fs.existsSync(p)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const le = parsed?.localExec;
    if (!le || typeof le !== 'object') return fallback;

    const grantedAt = typeof le.grantedAt === 'string' ? le.grantedAt : undefined;
    const revokedAt = typeof le.revokedAt === 'string' ? le.revokedAt : undefined;

    // Preferred: explicit mode.
    if (isMode(le.mode)) {
      return { mode: le.mode, ...(grantedAt ? { grantedAt } : {}), ...(revokedAt ? { revokedAt } : {}) };
    }
    // Legacy migration: boolean `granted`.
    if (typeof le.granted === 'boolean') {
      const mode: LocalExecMode = le.granted ? 'risk_prompt' : 'off';
      return { mode, ...(grantedAt ? { grantedAt } : {}), ...(revokedAt ? { revokedAt } : {}) };
    }
    return fallback;
  } catch (err) {
    log.warn(`permissions.json read failed, defaulting to ${DEFAULT_MODE}: ${(err as Error).message}`);
    return fallback;
  }
}

function writeStored(state: StoredState): void {
  const p = filePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ localExec: state }, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function toPublic(state: StoredState): LocalExecState {
  return {
    mode: state.mode,
    granted: state.mode !== 'off',
    ...(state.grantedAt ? { grantedAt: state.grantedAt } : {}),
    ...(state.revokedAt ? { revokedAt: state.revokedAt } : {}),
  };
}

/** Snapshot the full local-exec permission state. */
export function getLocalExecState(): LocalExecState {
  return toPublic(readStored());
}

/** Current mode. */
export function getLocalExecMode(): LocalExecMode {
  return readStored().mode;
}

/** Fast boolean check used by the tool wrappers on every execute(): is *any*
 *  execution allowed? `risk_prompt` and `allow_all` are both "granted"; the
 *  bash-specific prompting happens separately inside the bash tool. */
export function getLocalExecGranted(): boolean {
  return getLocalExecMode() !== 'off';
}

/** Set the mode. Stamps grantedAt (leaving off) or revokedAt (entering off);
 *  "latest wins", no history kept. Returns the new public state. */
export function setLocalExecMode(mode: LocalExecMode): LocalExecState {
  if (!isMode(mode)) throw new Error(`invalid local-exec mode: ${String(mode)}`);
  const next: StoredState = mode === 'off'
    ? { mode, revokedAt: nowIso() }
    : { mode, grantedAt: nowIso() };
  writeStored(next);
  log.info(`tool execution mode set: ${mode}`);
  return toPublic(next);
}

// ── Back-compat helpers (legacy IPC / tests) ─────────────────────────────

/** Legacy "enable" (the old binary "grant tool access"). Maps to `allow_all`
 *  to preserve its historical behavior — execution on, no bash prompting.
 *  NOTE: this is distinct from the NEW-INSTALL / migrated default, which is
 *  the safer `risk_prompt`. A legacy boolean `granted:true` on disk migrates
 *  to `risk_prompt` (see readStored); an explicit runtime grant means "fully
 *  on". The new settings UI uses `setLocalExecMode` directly. */
export function grantLocalExec(): LocalExecState {
  return setLocalExecMode('allow_all');
}

/** Legacy "disable": maps to `off`. */
export function revokeLocalExec(): LocalExecState {
  return setLocalExecMode('off');
}
