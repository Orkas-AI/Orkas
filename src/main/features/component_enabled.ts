/**
 * 个人启用/禁用配置 — agents + skills 的"用户级开关"。
 *
 * 落点：`<uid>/cloud/config/component-enabled.json`，与 preferences.json 同目录，
 * 走同一份云同步策略。
 *
 * **schema**（v1）：
 * ```
 * {
 *   "version": 1,
 *   "agents": { "<agent_id>": false, ... },
 *   "skills": { "<skill_id>": false, ... }
 * }
 * ```
 *
 * **存储约定 — 只存 false 覆盖**：
 *   - 缺 key = 走 spec 默认值（当前所有 spec 默认 = enabled，所以缺 key = enabled）
 *   - 显式 `true` 不会被 setEnabled 写入（写 true 时直接 delete 该 key）
 *   - 这样新增组件天然 enabled，不需要迁移；后期 spec 引入 `default_enabled: false`
 *     时同一份 file 立即生效，单 resolver `overrides[id] ?? specDefault ?? true`
 *
 * **resolver**（单一函数）：
 *   `isEnabled(uid, kind, id, specDefault?) = overrides[kind][id] ?? specDefault ?? true`
 *
 * **invalidate 由调用方负责**：本模块只管文件 IO，setAgentEnabled / setSkillEnabled
 * 写完返回，调用 IPC handler 自行触发各自的缓存失效（_invalidateAgentsCache /
 * _invalidateSkillListCache + invalidateCoreAgentSkills）。这样模块边界干净，
 * 不反向 import features/agents.ts / features/skills.ts。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userComponentEnabledFile } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('component-enabled');

const SCHEMA_VERSION = 1;

export interface ComponentEnabledFile {
  version: number;
  agents: Record<string, boolean>;
  skills: Record<string, boolean>;
}

function emptyFile(): ComponentEnabledFile {
  return { version: SCHEMA_VERSION, agents: {}, skills: {} };
}

/** Read the per-user enabled-overrides file. Missing / corrupt → empty defaults. */
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
    if (v === true) continue; // 只保留 false 覆盖
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
  };
  if (enabled) delete next.agents[agentId];
  else next.agents[agentId] = false;
  writeAtomic(uid, next);
  log.info(`agent ${agentId} → ${enabled ? 'enabled' : 'disabled'}`);
}

export function setSkillEnabled(uid: string, skillId: string, enabled: boolean): void {
  if (!skillId) throw new Error('skillId required');
  const cur = readEnabledMap(uid);
  const next: ComponentEnabledFile = {
    version: SCHEMA_VERSION,
    agents: { ...cur.agents },
    skills: { ...cur.skills },
  };
  if (enabled) delete next.skills[skillId];
  else next.skills[skillId] = false;
  writeAtomic(uid, next);
  log.info(`skill ${skillId} → ${enabled ? 'enabled' : 'disabled'}`);
}

/** Bulk read — used by the renderer to render toggle states without re-fetching
 *  per row. Returns `{agents: Set<disabledId>, skills: Set<disabledId>}`. */
export function readDisabledSets(uid: string): { agents: Set<string>; skills: Set<string> } {
  const map = readEnabledMap(uid);
  return {
    agents: new Set(Object.keys(map.agents)),
    skills: new Set(Object.keys(map.skills)),
  };
}
