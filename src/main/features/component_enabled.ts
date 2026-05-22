/**
 * Per-user enable/disable config — the "user-level toggle" for agents +
 * skills.
 *
 * Lives at `<uid>/cloud/config/component-enabled.json`, alongside
 * preferences.json and following the same cloud-sync policy.
 *
 * **Schema** (v1):
 * ```
 * {
 *   "version": 1,
 *   "agents": { "<agent_id>": false, ... },
 *   "skills": { "<skill_id>": false, ... }
 * }
 * ```
 *
 * **Storage convention — only `false` overrides are stored**:
 *   - Missing key = use the spec default (every spec is currently
 *     `enabled`, so missing key = enabled).
 *   - Explicit `true` is never written by setEnabled (writing `true`
 *     deletes the key instead).
 *   - This way new components are naturally enabled without a
 *     migration; if a future spec ships `default_enabled: false`, the
 *     same file works immediately under the single resolver
 *     `overrides[id] ?? specDefault ?? true`.
 *
 * **Resolver** (single function):
 *   `isEnabled(uid, kind, id, specDefault?) = overrides[kind][id] ?? specDefault ?? true`
 *
 * **Invalidation is the caller's responsibility**: this module only
 * does file IO. setAgentEnabled / setSkillEnabled return after writing,
 * and the calling IPC handler triggers the relevant cache invalidations
 * (_invalidateAgentsCache / _invalidateSkillListCache +
 * invalidateCoreAgentSkills). This keeps module boundaries clean — no
 * reverse imports of features/agents.ts / features/skills.ts from here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userComponentEnabledFile } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('component-enabled');

// features/sync is stripped from the OrkasOpen build — markDirty is a no-op.
function _notifyDirty(): void {
  /* no-op */
}

const SCHEMA_VERSION = 1;

export interface ComponentEnabledFile {
  version: number;
  agents: Record<string, boolean>;
  skills: Record<string, boolean>;
  /** Per-user soft-disable for connector instances. Independent of OAuth grant / MCP connection
   *  state — a "disabled" connector keeps its tokens and stays connected, but is invisible to
   *  the LLM (`resolveVisibleConnectors` filters it out). "Disconnect" (manager.removeInstance)
   *  is the heavier action that wipes the grant. */
  connectors: Record<string, boolean>;
}

function emptyFile(): ComponentEnabledFile {
  return { version: SCHEMA_VERSION, agents: {}, skills: {}, connectors: {} };
}

/** Read the per-user enabled-overrides file. Missing / corrupt → empty defaults.
 *  Old v1 files without a `connectors` field are auto-padded with `{}` (no migration needed —
 *  missing key = treat-as-enabled is the contract). */
export function readEnabledMap(uid: string): ComponentEnabledFile {
  const p = userComponentEnabledFile(uid);
  try {
    if (!fs.existsSync(p)) return emptyFile();
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return emptyFile();
    return {
      version: SCHEMA_VERSION,
      agents: (parsed.agents && typeof parsed.agents === 'object') ? sanitiseMap(parsed.agents) : {},
      skills: (parsed.skills && typeof parsed.skills === 'object') ? sanitiseMap(parsed.skills) : {},
      connectors: (parsed.connectors && typeof parsed.connectors === 'object') ? sanitiseMap(parsed.connectors) : {},
    };
  } catch (err) {
    log.warn(`read failed, using empty defaults: ${(err as Error).message}`);
    return emptyFile();
  }
}

function sanitiseMap(raw: Record<string, unknown>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || !k) continue;
    if (typeof v !== 'boolean') continue;
    if (v === true) continue; // only false-overrides are persisted
    out[k] = false;
  }
  return out;
}

function writeAtomic(uid: string, data: ComponentEnabledFile): void {
  const p = userComponentEnabledFile(uid);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/** Single resolver — used everywhere (`getSystemPromptBlock` / `_buildAgentsIndex` /
 *  `streamSendToConversation` / list endpoints). */
export function isAgentEnabled(uid: string, agentId: string, specDefault?: boolean): boolean {
  if (!agentId) return true;
  const map = readEnabledMap(uid);
  return resolve(map.agents, agentId, specDefault);
}

export function isSkillEnabled(uid: string, skillId: string, specDefault?: boolean): boolean {
  if (!skillId) return true;
  const map = readEnabledMap(uid);
  return resolve(map.skills, skillId, specDefault);
}

export function isConnectorEnabled(uid: string, connectorId: string, specDefault?: boolean): boolean {
  if (!connectorId) return true;
  const map = readEnabledMap(uid);
  return resolve(map.connectors, connectorId, specDefault);
}

function resolve(overrides: Record<string, boolean>, id: string, specDefault?: boolean): boolean {
  const o = overrides[id];
  if (typeof o === 'boolean') return o;
  if (typeof specDefault === 'boolean') return specDefault;
  return true;
}

export function setAgentEnabled(uid: string, agentId: string, enabled: boolean): void {
  if (!agentId) throw new Error('agentId required');
  const cur = readEnabledMap(uid);
  const next: ComponentEnabledFile = {
    version: SCHEMA_VERSION,
    agents: { ...cur.agents },
    skills: { ...cur.skills },
    connectors: { ...cur.connectors },
  };
  if (enabled) delete next.agents[agentId];
  else next.agents[agentId] = false;
  writeAtomic(uid, next);
  _notifyDirty();
  log.info(`agent ${agentId} → ${enabled ? 'enabled' : 'disabled'}`);
}

export function setSkillEnabled(uid: string, skillId: string, enabled: boolean): void {
  if (!skillId) throw new Error('skillId required');
  const cur = readEnabledMap(uid);
  const next: ComponentEnabledFile = {
    version: SCHEMA_VERSION,
    agents: { ...cur.agents },
    skills: { ...cur.skills },
    connectors: { ...cur.connectors },
  };
  if (enabled) delete next.skills[skillId];
  else next.skills[skillId] = false;
  writeAtomic(uid, next);
  _notifyDirty();
  log.info(`skill ${skillId} → ${enabled ? 'enabled' : 'disabled'}`);
}

export function setConnectorEnabled(uid: string, connectorId: string, enabled: boolean): void {
  if (!connectorId) throw new Error('connectorId required');
  const cur = readEnabledMap(uid);
  const next: ComponentEnabledFile = {
    version: SCHEMA_VERSION,
    agents: { ...cur.agents },
    skills: { ...cur.skills },
    connectors: { ...cur.connectors },
  };
  if (enabled) delete next.connectors[connectorId];
  else next.connectors[connectorId] = false;
  writeAtomic(uid, next);
  _notifyDirty();
  log.info(`connector ${connectorId} → ${enabled ? 'enabled' : 'disabled'}`);
}

/** Bulk read — used by the renderer to render toggle states without re-fetching
 *  per row. Returns `{agents, skills, connectors: Set<disabledId>}`. */
export function readDisabledSets(uid: string): { agents: Set<string>; skills: Set<string>; connectors: Set<string> } {
  const map = readEnabledMap(uid);
  return {
    agents: new Set(Object.keys(map.agents)),
    skills: new Set(Object.keys(map.skills)),
    connectors: new Set(Object.keys(map.connectors)),
  };
}
