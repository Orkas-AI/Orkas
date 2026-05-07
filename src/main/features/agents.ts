/**
 * Agents — listing, custom CRUD, builtin sync, inline edit chat.
 *
 * Mirrors the skills module shape. Two sources:
 *   builtin — data/shared/agents/builtin/<id>.json (synced from PC/builtin/agents/)
 *   custom  — data/shared/agents/custom/<id>.json  (user-created, editable)
 *
 * Schema (one JSON per agent):
 *   { agent_id, name, description, workflow, created_at, updated_at }
 *
 * The inline "编辑" chat lets the LLM refine an agent by emitting one
 * `<agent>...</agent>` container per turn, whose children are the fields
 * to update: `<name>` / `<description>` / `<workflow>` / `<skills>` /
 * `<inputs>`. Each child is a full-replacement update for that field.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  BUILTIN_AGENTS_DIR, BUILTIN_AGENTS_SOURCE, BUILTIN_SKILLS_DIR,
  userAgentsDir, userSkillsDir, userAgentChatDir, userSessionFile, WS_ROOT,
  agentDir, agentDefinitionFile,
  builtinAgentDir, builtinAgentDefinitionFile,
} from '../paths';
import { evictSession } from '../model/core-agent/session-store';
import { getActiveUserId } from './users';
import { createLogger } from '../logger';
import { t, buildLanguageDirective } from '../i18n';

const log = createLogger('agents');

// Custom agents / skills roots — resolved from the active uid every call.
function CUSTOM_AGENTS_DIR(): string { return userAgentsDir(getActiveUserId()); }
function CUSTOM_SKILLS_DIR(): string { return userSkillsDir(getActiveUserId()); }
import { prompts } from '../prompts/loader';
import {
  nowIso, genAgentId, safeId,
  readJson, writeJson,
  appendJsonlAtomic, invalidateLineCount, readJsonl,
} from '../storage';
import { listSkillSpecs } from '../model/core-agent/skill-registry';
import { readDisabledSets, setAgentEnabled } from './component_enabled';
import { renameAgentInMembers } from './group_chat/state';

export type AgentSource = 'builtin' | 'custom';

export type AgentInputType = 'text' | 'textarea' | 'select' | 'multiselect' | 'number' | 'boolean' | 'file' | 'directory';

export interface AgentInputOption {
  value: string;
  label: string;
}

/** Declarative schema for an agent's user-facing input parameters.
 * Populated by the agent-edit LLM (or commander quick-create) via the
 * `<inputs>` child of the `<agent>` update container; consumed at run
 * time by the agent itself per `chat_agent_in_group.md` § inputs_schema
 * 触发的强制确认 (it emits a fenced `agent-input-form` block when fields
 * are missing or low-confidence) and by the chat-bubble form widget
 * (renderer renders it). */
export interface AgentInput {
  /** snake_case key, unique within an agent. */
  id: string;
  label: string;
  description?: string;
  type: AgentInputType;
  required?: boolean;
  /** Always defined. text/textarea → string; number → number;
   * boolean → boolean; select → option value (string); multiselect → string[];
   * file → string (single) or string[] (when `multiple`). For `file` the
   * default is always `""` / `[]` — model authors can't pre-pick a file. */
  default: string | number | boolean | string[];
  /** Required for select/multiselect; ignored otherwise. */
  options?: AgentInputOption[];
  placeholder?: string;
  min?: number;
  max?: number;
  /** `file` only — allow picking more than one file. Default false. */
  multiple?: boolean;
  /** `file` only — `accept` attribute hint passed to `<input type=file>`,
   * e.g. `".pdf,.docx"` or `"image/*"`. Optional. */
  accept?: string;
}

export interface Agent {
  agent_id: string;
  name: string;
  /** Chinese description (zh locale). May be empty. */
  description_zh: string;
  /** English description (en locale). May be empty. */
  description_en: string;
  workflow: string;
  /** Display avatar — paired (icon id, color id). Both come from
   * `renderer/modules/avatar.js` constants. Optional: missing fields fall
   * back to a deterministic hash of `agent_id` at render time so old
   * agents stay stable without a migration pass. */
  icon?: string;
  color?: string;
  /** Skill ids this agent declares it needs. Three-state:
   *   - undefined / field missing → no filter (inject every skill)
   *   - []                        → explicitly zero skills
   *   - string[] non-empty        → inject only these skill ids
   * Maintained exclusively by the agent-edit LLM via the `<skills>` child
   * of the `<agent>` container. Not exposed in the UI. */
  skill_list?: string[];
  /** User-facing input schema. Three-state:
   *   - undefined / field missing → agent needs no up-front confirmation
   *   - []                        → explicit zero inputs
   *   - AgentInput[] non-empty    → commander must first emit an
   *     `agent-input-form` block before @-mentioning the agent
   * Maintained exclusively by the agent-edit LLM via the `<inputs>` child
   * of the `<agent>` container. */
  inputs?: AgentInput[];
  /** Interactive agents need ongoing user back-and-forth (tutoring,
   * Q&A, role-play). When the agent's plan step is `in_progress`, the
   * group-chat input box auto-targets the agent so the user doesn't have
   * to manually @-mention every reply. Maintained by the agent-edit LLM
   * via the `<interactive>` child of `<agent>`; missing = false. */
  interactive?: boolean;
  /** Execution backend. Missing / `kind === 'in_process'` (the default)
   *  means the agent runs through `core-agent` like every existing
   *  agent. `kind === 'cli'` routes the worker turn through
   *  `features/local_agents/runner.ts` to spawn a local coding CLI
   *  (claude code / codex / openclaw / opencode / hermes). The field is
   *  set at create time from the modal's runtime selector and edited
   *  via the dedicated `chat_agent_setup_cli.md` prompt; the LLM
   *  doesn't author it directly. */
  runtime?: AgentRuntime;
  source: AgentSource;
  created_at: string;
  updated_at: string;
  /** **Computed at load time, not persisted.** Filled by `listAgents` /
   *  `getAgent` from `features/component_enabled.ts`. Defaults to true
   *  unless the user has explicitly disabled the agent. Don't write this
   *  field back to disk. */
  enabled: boolean;
}

interface AgentRaw {
  agent_id?: string;
  name?: string;
  description?: string;
  description_zh?: string;
  description_en?: string;
  workflow?: string;
  created_at?: string;
  updated_at?: string;
  skill_list?: unknown;
  inputs?: unknown;
  icon?: unknown;
  color?: unknown;
  interactive?: unknown;
  runtime?: unknown;
}

/** Per-agent execution backend. See `Agent.runtime`. */
export type AgentRuntime =
  | { kind: 'in_process' }
  | {
      kind: 'cli';
      /** Canonical CLI type — must match `LOCAL_CLI_TYPES` in
       *  `features/local_agents/registry.ts`. Validated on read; an
       *  unknown value drops the runtime field entirely. */
      cli: string;
      /** Optional model id; empty means "let the CLI pick its default". */
      model?: string;
      /** Extra CLI flags appended after our own args. Strings only;
       *  not shell-parsed by us. */
      custom_args?: string[];
    };

// 头像 token 校验走 catalog 白名单（src/main/data/avatars.json 是单一真相源）。
// renderer/modules/avatar.js 也从同一份文件拉数据，前后端不再有任何重复。
import * as avatars from './avatars';

export interface AgentChatMeta { session_id?: string; [k: string]: unknown }

// ─────────────────────────────────────────────────────────────────────────
// 1. Builtin agent sync (startup)
// ─────────────────────────────────────────────────────────────────────────

/** Hash all agent definitions under `root` (directory form: `<aid>/agent.json`).
 * Used by `syncBuiltinAgents` to detect upstream changes. Skipped: dot-prefixed
 * dirs and any subdir without `agent.json` (so the hash is stable against
 * runtime artifacts like `meta/` or `skills/` if they ever land here — they
 * shouldn't, builtin is spec-only). */
export function hashTree(root: string): string {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return '';
  const h = crypto.createHash('sha256');
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const specFile = path.join(root, e.name, 'agent.json');
    if (!fs.existsSync(specFile)) continue;
    h.update(e.name, 'utf8');
    h.update(Buffer.from([0]));
    try { h.update(fs.readFileSync(specFile)); } catch { /* skip */ }
    h.update(Buffer.from([0x0a]));
  }
  return h.digest('hex');
}

export function syncBuiltinAgents(): boolean {
  fs.mkdirSync(BUILTIN_AGENTS_DIR, { recursive: true });
  if (!fs.existsSync(BUILTIN_AGENTS_SOURCE)) {
    log.info(`source dir missing: ${BUILTIN_AGENTS_SOURCE}; skipping`);
    return false;
  }
  const srcHash = hashTree(BUILTIN_AGENTS_SOURCE);
  const dstHash = hashTree(BUILTIN_AGENTS_DIR);
  if (srcHash === dstHash) return false;

  const listAgentDirs = (root: string): Set<string> => new Set(
    fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory()
        && !e.name.startsWith('.')
        && fs.existsSync(path.join(root, e.name, 'agent.json')))
      .map((e) => e.name),
  );
  const srcIds = listAgentDirs(BUILTIN_AGENTS_SOURCE);
  const dstIds = listAgentDirs(BUILTIN_AGENTS_DIR);

  let changed = false;
  for (const stale of [...dstIds].filter((id) => !srcIds.has(id)).sort()) {
    try {
      fs.rmSync(builtinAgentDir(stale), { recursive: true, force: true });
      log.info(`removed stale builtin agent ${stale}`);
      changed = true;
    } catch (err) {
      log.warn(`rm ${stale} failed: ${(err as Error).message}`);
    }
  }
  for (const id of [...srcIds].sort()) {
    const src = path.join(BUILTIN_AGENTS_SOURCE, id, 'agent.json');
    const dst = builtinAgentDefinitionFile(id);
    try {
      const srcBuf = fs.readFileSync(src);
      const dstBuf = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
      if (!dstBuf || !srcBuf.equals(dstBuf)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.writeFileSync(dst, srcBuf);
        log.info(`synced builtin agent ${id}`);
        changed = true;
      }
    } catch (err) {
      log.warn(`copy ${id} failed: ${(err as Error).message}`);
    }
  }
  return changed;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Read / list
// ─────────────────────────────────────────────────────────────────────────

function agentBaseDir(source: AgentSource): string {
  return source === 'builtin' ? BUILTIN_AGENTS_DIR : CUSTOM_AGENTS_DIR();
}

const INPUT_ID_RE = /^[a-z_][a-z0-9_]{0,31}$/;
const ALLOWED_INPUT_TYPES: readonly AgentInputType[] = ['text', 'textarea', 'select', 'multiselect', 'number', 'boolean', 'file', 'directory'];

// Reserved agent display names — collide with the commander role surfaced in
// the chat-recipient chip ("指挥官") and the sidebar tab ("总指挥"). The bus
// router also keys "commander" as a member id, so we guard the English form
// too. Comparison is case-insensitive after stripping all whitespace, so
// "  Commander " or "总 指挥" all resolve to the same canonical key.
const RESERVED_AGENT_NAMES = new Set(['指挥官', '总指挥', 'commander']);
function _agentNameKey(name: string): string {
  return String(name || '').replace(/\s+/g, '').toLowerCase();
}
function assertAgentNameAllowed(name: string): void {
  const key = _agentNameKey(name);
  if (!key) return; // empty handled elsewhere (defaults to "未命名智能体")
  if (RESERVED_AGENT_NAMES.has(key)) {
    const err: any = new Error(`agent name "${name}" is reserved`);
    err.code = 'E_AGENT_NAME_RESERVED';
    throw err;
  }
}

/** Reject names already in use by another agent (custom OR builtin).
 *  Matches `_agentNameKey` (case-insensitive, all whitespace stripped) so
 *  "Code Helper" and "codehelper" collide. `excludeAgentId` lets the
 *  update path keep its own name. Caller owns the check at every write
 *  entry — IPC create / IPC update / LLM-driven create+edit — so neither
 *  the UI form nor the LLM can land a duplicate. */
async function assertAgentNameUnique(
  name: string, excludeAgentId?: string,
): Promise<void> {
  const key = _agentNameKey(name);
  if (!key) return;
  const all = await listAgents();
  for (const a of all) {
    if (excludeAgentId && a.agent_id === excludeAgentId) continue;
    if (_agentNameKey(a.name || '') === key) {
      const err: any = new Error(`agent name "${name}" is already in use`);
      err.code = 'E_AGENT_NAME_TAKEN';
      throw err;
    }
  }
}

/**
 * Normalize + validate a candidate `AgentInput[]`. Drop malformed entries
 * with a warn log rather than throw — we don't want one bad field to make
 * an entire agent unreadable. Returns a cleaned array (possibly empty).
 */
export function validateAgentInputs(raw: unknown): AgentInput[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AgentInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    if (!INPUT_ID_RE.test(id) || seen.has(id)) { log.warn(`input dropped: bad id ${JSON.stringify(e.id)}`); continue; }
    const type = e.type as AgentInputType;
    if (!ALLOWED_INPUT_TYPES.includes(type)) { log.warn(`input ${id} dropped: bad type ${JSON.stringify(e.type)}`); continue; }
    const label = typeof e.label === 'string' ? e.label : id;

    let options: AgentInputOption[] | undefined;
    if (type === 'select' || type === 'multiselect') {
      if (!Array.isArray(e.options) || e.options.length === 0) {
        log.warn(`input ${id} dropped: ${type} needs non-empty options`); continue;
      }
      const optValues = new Set<string>();
      options = [];
      for (const o of e.options) {
        if (!o || typeof o !== 'object') continue;
        const v = typeof (o as any).value === 'string' ? String((o as any).value) : '';
        if (!v || optValues.has(v)) continue;
        optValues.add(v);
        options.push({ value: v, label: typeof (o as any).label === 'string' ? (o as any).label : v });
      }
      if (options.length === 0) { log.warn(`input ${id} dropped: options invalid`); continue; }
    }

    let def: string | number | boolean | string[];
    const fileMultiple = type === 'file' && e.multiple === true;
    if (type === 'text' || type === 'textarea') {
      def = typeof e.default === 'string' ? e.default : '';
    } else if (type === 'number') {
      // Allow JS numeric default OR a string that parses to a finite number
      // (LLMs frequently emit `"3"` instead of `3` because of how they
      // serialise mixed-type JSON schemas). Drop the field if the default
      // is truly non-numeric (NaN / "abc" / object) — better to lose the
      // field than persist garbage.
      let n: number | null = null;
      if (typeof e.default === 'number' && Number.isFinite(e.default)) n = e.default;
      else if (typeof e.default === 'string' && e.default.trim() !== '') {
        const parsed = Number(e.default);
        if (Number.isFinite(parsed)) n = parsed;
      }
      if (n === null) { log.warn(`input ${id} dropped: default must be finite number`); continue; }
      def = n;
    } else if (type === 'boolean') {
      // Coerce common boolean reps the LLM emits (`"true"` / `"false"` /
      // `0` / `1`) instead of dropping the field — losing a structural
      // input over a serialisation quirk silently breaks the agent's
      // form schema, which the user sees as "form missing a checkbox".
      let b: boolean;
      if (typeof e.default === 'boolean') b = e.default;
      else if (e.default === 'true' || e.default === 1) b = true;
      else if (e.default === 'false' || e.default === 0) b = false;
      else {
        log.warn(`input ${id}: invalid boolean default ${JSON.stringify(e.default)}, falling back to false`);
        b = false;
      }
      def = b;
    } else if (type === 'select') {
      // prompt(chat_agent_in_group.md)明示运行时弹的 form 允许"空表单(不带 default)"。
      // 旧逻辑对缺/非法 default 直接 drop 整个 field,fields 全空 → form 不挂 →
      // raw <agent-input-form> XML 被 markdown 当未知 HTML 渲染 = 用户看到样式崩。
      // 优雅降级:fallback 到 options[0].value(对应浏览器 <select> 默认显示首项的行为)。
      const v = typeof e.default === 'string' ? e.default : '';
      if (v && options!.some((o) => o.value === v)) {
        def = v;
      } else {
        if (v) log.warn(`input ${id}: default ${JSON.stringify(v)} not in options, falling back to first`);
        def = options![0].value;
      }
    } else if (type === 'multiselect') {
      const arr = Array.isArray(e.default) ? e.default.filter((x): x is string => typeof x === 'string') : [];
      const allowed = new Set(options!.map((o) => o.value));
      const filtered = arr.filter((v) => allowed.has(v));
      def = filtered;
    } else if (type === 'directory') {
      // Directory — default is always empty; the user picks via native dialog.
      def = '';
    } else { // file — default is always empty (the model can't pre-pick a file)
      def = fileMultiple ? [] : '';
    }

    const input: AgentInput = { id, label, type, default: def };
    if (typeof e.description === 'string' && e.description) input.description = e.description;
    if (e.required === true) input.required = true;
    if (options) input.options = options;
    if (typeof e.placeholder === 'string' && e.placeholder) input.placeholder = e.placeholder;
    if (typeof e.min === 'number' && Number.isFinite(e.min)) input.min = e.min;
    if (typeof e.max === 'number' && Number.isFinite(e.max)) input.max = e.max;
    if (type === 'file') {
      if (fileMultiple) input.multiple = true;
      if (typeof e.accept === 'string' && e.accept.trim()) input.accept = e.accept.trim();
    }
    if (type === 'number' && typeof def === 'number') {
      if (typeof input.min === 'number' && def < input.min) { log.warn(`input ${id}: default below min`); }
      if (typeof input.max === 'number' && def > input.max) { log.warn(`input ${id}: default above max`); }
    }

    seen.add(id);
    out.push(input);
  }
  return out;
}

export function normalizeAgent(raw: AgentRaw | null | undefined, source: AgentSource): Agent | null {
  if (!raw || typeof raw !== 'object' || !raw.agent_id) return null;
  // Migrate legacy single-`description` into the matching language slot.
  // Same Chinese-character heuristic as the skill loader; explicit > legacy.
  const legacyDesc = typeof raw.description === 'string' ? raw.description.trim() : '';
  const explicitZh = typeof raw.description_zh === 'string' ? raw.description_zh.trim() : '';
  const explicitEn = typeof raw.description_en === 'string' ? raw.description_en.trim() : '';
  const legacyHasChinese = /[一-鿿]/.test(legacyDesc);
  const agent: Agent = {
    agent_id: raw.agent_id,
    name: typeof raw.name === 'string' ? raw.name : '',
    description_zh: explicitZh || (legacyDesc && legacyHasChinese ? legacyDesc : ''),
    description_en: explicitEn || (legacyDesc && !legacyHasChinese ? legacyDesc : ''),
    workflow: typeof raw.workflow === 'string' ? raw.workflow : '',
    source,
    created_at: raw.created_at || '',
    updated_at: raw.updated_at || '',
    // Defaults to enabled; overlaid by listAgents / getAgent from the
    // per-user enabled-overrides map. Don't read this field from raw JSON —
    // it is never persisted.
    enabled: true,
  };
  // skill_list is three-state: undefined = no filter, [] = zero skills,
  // string[] = the explicit subset. Anything else (string, object, null)
  // is treated as "unset" so we don't accidentally zero out skills on
  // malformed JSON.
  if (Array.isArray(raw.skill_list)) {
    agent.skill_list = raw.skill_list.filter(
      (v): v is string => typeof v === 'string' && safeId(v),
    );
  }
  // inputs follows the same three-state convention as skill_list. Only the
  // exact-array branch makes it through; malformed JSON is treated as "unset"
  // rather than "zero", so a corrupted field never silently erases the real
  // schema at read time.
  if (Array.isArray(raw.inputs)) {
    agent.inputs = validateAgentInputs(raw.inputs);
  }
  if (avatars.isKnownIcon(raw.icon)) agent.icon = raw.icon;
  if (avatars.isKnownColor(raw.color)) agent.color = raw.color;
  // interactive — tolerant boolean coerce (LLMs sometimes emit "true"/"false"
  // strings). Missing/malformed → undefined; downstream readers treat
  // undefined the same as false.
  if (typeof raw.interactive === 'boolean') {
    agent.interactive = raw.interactive;
  } else if (raw.interactive === 'true') {
    agent.interactive = true;
  } else if (raw.interactive === 'false') {
    agent.interactive = false;
  }
  const rt = _normalizeRuntime(raw.runtime);
  if (rt) agent.runtime = rt;
  return agent;
}

/** Validate / coerce a raw `runtime` field. Unknown shapes return null
 *  (= drop the field; the agent falls back to the in-process default).
 *  Kept loose on purpose: front-end and edit-prompt may both write here
 *  and a malformed value mustn't poison reads. */
function _normalizeRuntime(raw: unknown): AgentRuntime | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (kind === 'in_process') return { kind: 'in_process' };
  if (kind !== 'cli') return null;
  const cli = typeof r.cli === 'string' ? r.cli.trim() : '';
  if (!cli) return null;
  const out: AgentRuntime = { kind: 'cli', cli };
  if (typeof r.model === 'string' && r.model.trim()) out.model = r.model.trim();
  if (Array.isArray(r.custom_args)) {
    const args = r.custom_args.filter((s): s is string => typeof s === 'string');
    if (args.length) out.custom_args = args;
  }
  return out;
}

/** True when this CLI is a coding agent (claude code / codex). Coding
 *  agents are dispatched with a per-conversation project directory as
 *  cwd instead of the user workspace; the chip in the conversation
 *  surface lets the user set it. Single source of truth for both UI
 *  visibility and dispatch routing. */
export const CODING_CLIS = new Set<string>(['claude', 'codex']);
export function cliIsCodingAgent(cli: string | undefined): boolean {
  return !!cli && CODING_CLIS.has(cli);
}

/** True when this agent runs via a local CLI rather than in-process
 *  core-agent. Single source of truth — group_chat / chats / renderer
 *  all import this rather than re-checking `runtime?.kind` directly. */
export function isCliAgent(agent: Pick<Agent, 'runtime'> | null | undefined): boolean {
  return !!agent && agent.runtime?.kind === 'cli';
}

interface AgentListCache { stamp: string; data: Agent[] }
let _agentListCache: AgentListCache | null = null;

function _invalidateAgentListCache(): void { _agentListCache = null; }

/** Toggle the active user's enabled override for an agent. Wrapping the
 *  raw setter so the IPC handler stays one-line and the per-uid resolution
 *  happens here. The disk-spec cache doesn't need invalidating (enabled is
 *  overlaid outside it), but we no-op'd that explicitly to avoid surprise. */
export function setAgentEnabledForActiveUser(agentId: string, enabled: boolean): void {
  setAgentEnabled(getActiveUserId(), agentId, enabled);
}

function _agentDirStamp(): string {
  let stamp = '';
  for (const d of [CUSTOM_AGENTS_DIR(), BUILTIN_AGENTS_DIR]) {
    try { stamp += `${d}:${fs.statSync(d).mtimeMs};`; }
    catch { stamp += `${d}:0;`; }
  }
  return stamp;
}

export async function listAgents(): Promise<Agent[]> {
  const stamp = _agentDirStamp();
  let specs: Agent[];
  if (_agentListCache && _agentListCache.stamp === stamp) {
    specs = _agentListCache.data;
  } else {
    specs = [];
    const seen = new Set<string>();
    const sources: Array<[AgentSource, string]> = [['custom', CUSTOM_AGENTS_DIR()], ['builtin', BUILTIN_AGENTS_DIR]];
    for (const [source, dir] of sources) {
      if (!fs.existsSync(dir)) continue;
      const entries = (await fsp.readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const full = path.join(dir, e.name, 'agent.json');
        if (!fs.existsSync(full)) continue;
        let data: AgentRaw;
        try { data = await readJson<AgentRaw>(full); } catch { continue; }
        const norm = normalizeAgent(data, source);
        if (!norm) continue;
        if (seen.has(norm.agent_id)) {
          if (source === 'builtin') {
            log.warn(`id conflict: custom and builtin both define "${norm.agent_id}" — custom wins, rename one`);
          }
          continue;
        }
        seen.add(norm.agent_id);
        specs.push(norm);
      }
    }
    _agentListCache = { stamp, data: specs };
  }
  // Overlay per-user enabled overrides outside the cache so toggles take
  // effect immediately without busting the disk-spec cache. Cheap — one
  // small JSON file read per call.
  const { agents: disabledAgentIds } = readDisabledSets(getActiveUserId());
  return specs.map((a) => ({ ...a, enabled: !disabledAgentIds.has(a.agent_id) }));
}

/**
 * Look up an agent by id. Custom wins on name collision.
 * Returns normalized agent or null.
 */
export async function getAgent(agentId: string | null | undefined): Promise<Agent | null> {
  if (!agentId) return null;
  for (const source of ['custom', 'builtin'] as AgentSource[]) {
    const f = source === 'builtin'
      ? builtinAgentDefinitionFile(agentId)
      : agentDefinitionFile(getActiveUserId(), agentId);
    if (!fs.existsSync(f)) continue;
    try {
      const data = await readJson<AgentRaw>(f);
      const norm = normalizeAgent(data, source);
      if (norm) {
        const { agents: disabledAgentIds } = readDisabledSets(getActiveUserId());
        norm.enabled = !disabledAgentIds.has(norm.agent_id);
        return norm;
      }
    } catch { /* ignore */ }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Custom CRUD
// ─────────────────────────────────────────────────────────────────────────

/** spec.json path for the active user's custom agent. Builtin agents go
 *  through `builtinAgentDefinitionFile` directly. */
function customAgentFile(agentId: string): string {
  return agentDefinitionFile(getActiveUserId(), agentId);
}

export interface CreateAgentOptions {
  name?: string;
  /** Legacy single-language seed; routed into description_zh OR description_en
   *  by Chinese-character heuristic. Use `description_zh` / `description_en`
   *  directly when both languages are known. */
  description?: string;
  description_zh?: string;
  description_en?: string;
  workflow?: string;
  icon?: string;
  color?: string;
  interactive?: boolean;
  /** Picked at create time from the modal's runtime selector. Stored as
   *  authored — `normalizeAgent` validates on read. */
  runtime?: AgentRuntime;
}

/** Route a legacy `description` input into the matching language slot.
 *  Explicit `description_zh` / `description_en` always win; legacy fills
 *  the empty side based on whether it contains CJK ideographs. Returns the
 *  pair of resolved values (already trimmed; `''` when nothing to set). */
function resolveBilingualDescription(
  legacy: string | undefined,
  zh: string | undefined,
  en: string | undefined,
): { description_zh: string; description_en: string } {
  const l = (legacy || '').trim();
  const z = (zh || '').trim();
  const e = (en || '').trim();
  const hasChinese = /[一-鿿]/.test(l);
  return {
    description_zh: z || (l && hasChinese ? l : ''),
    description_en: e || (l && !hasChinese ? l : ''),
  };
}

/**
 * Create a blank custom agent. Initial fields are optional — the user typically
 * enters the edit page right after creation and fills them in via chat or
 * manual edit. Returns the created agent.
 */
export async function createCustomAgent(
  { name = '', description = '', description_zh, description_en, workflow = '', icon, color, interactive, runtime }: CreateAgentOptions = {},
): Promise<Agent | null> {
  assertAgentNameAllowed(name);
  await assertAgentNameUnique(String(name || '').trim());
  fs.mkdirSync(CUSTOM_AGENTS_DIR(), { recursive: true });
  let agentId: string;
  do { agentId = genAgentId(); }
  while (fs.existsSync(builtinAgentDefinitionFile(agentId))
      || fs.existsSync(customAgentFile(agentId)));
  // mkdir <aid>/ first so writeJson on agent.json has a parent.
  fs.mkdirSync(agentDir(getActiveUserId(), agentId), { recursive: true });
  const desc = resolveBilingualDescription(description, description_zh, description_en);
  const data: AgentRaw = {
    agent_id: agentId,
    name: String(name || '').trim() || '未命名智能体',
    description_zh: desc.description_zh,
    description_en: desc.description_en,
    workflow: String(workflow || ''),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  if (avatars.isKnownIcon(icon)) data.icon = icon;
  if (avatars.isKnownColor(color)) data.color = color;
  if (typeof interactive === 'boolean') data.interactive = interactive;
  // Persist runtime only when it survives validation; an in_process
  // selection is the implicit default and not written to disk so old
  // tooling diffs cleanly.
  const rt = _normalizeRuntime(runtime);
  if (rt && rt.kind === 'cli') {
    data.runtime = rt;
    // Coding CLIs (claude / codex) need a working directory. We inject
    // a `project_dir` input dependency so the standard agent-input-form
    // pipeline collects it before the first dispatch — same UX as any
    // other required input. The agent worker reads the submitted
    // value to set CLI cwd.
    if (cliIsCodingAgent(rt.cli)) {
      data.inputs = [PROJECT_DIR_INPUT];
    }
  }
  await writeJson(customAgentFile(agentId), data);
  _invalidateAgentListCache();
  log.info(`created id=${agentId} name=${data.name}`);
  return normalizeAgent(data, 'custom');
}

/** Required-input schema injected on every external coding agent. The
 *  field id `project_dir` is a contract — the dispatch path looks for
 *  exactly this id when extracting the cwd from a form submission. */
export const PROJECT_DIR_INPUT_ID = 'project_dir';
const PROJECT_DIR_INPUT: AgentInput = {
  id: PROJECT_DIR_INPUT_ID,
  type: 'directory',
  label: '项目目录',
  required: true,
  default: '',
};

export interface UpdateAgentFields {
  name?: string;
  description?: string;
  description_zh?: string;
  description_en?: string;
  workflow?: string;
  /** Display avatar tokens. Pass a string to set; omitted = untouched. */
  icon?: string;
  color?: string;
  /** Three-way update:
   *   array → replace (filtered through `safeId`)
   *   null  → drop the field (revert to "no filter")
   *   omitted → untouched */
  skill_list?: string[] | null;
  /** Three-way update mirror of `skill_list`:
   *   array → replace (validated via `validateAgentInputs`)
   *   null  → drop the field
   *   omitted → untouched */
  inputs?: AgentInput[] | null;
  /** Three-way update:
   *   boolean → set the flag
   *   null  → drop the field (revert to "missing" = false at read time)
   *   omitted → untouched */
  interactive?: boolean | null;
  /** Three-way update:
   *   AgentRuntime → replace (validated; in_process collapses to "drop")
   *   null         → drop runtime (revert to in_process default)
   *   omitted      → untouched
   *  Authored by the create modal + edit UI, not the LLM edit prompt. */
  runtime?: AgentRuntime | null;
}

/**
 * Update any mutable field on a custom agent. Builtin agents are
 * read-only — returns null if the target is builtin or missing.
 */
export async function updateCustomAgent(
  agentId: string, updates: UpdateAgentFields,
): Promise<Agent | null> {
  if (!agentId) return null;
  const f = customAgentFile(agentId);
  if (!fs.existsSync(f)) return null;
  const data = await readJson<AgentRaw>(f);
  const oldName = typeof (data as any).name === 'string' ? (data as any).name : '';
  if (Object.prototype.hasOwnProperty.call(updates || {}, 'name')) {
    const incomingName = typeof updates.name === 'string' ? updates.name : '';
    assertAgentNameAllowed(incomingName);
    const trimmed = incomingName.trim();
    if (trimmed) await assertAgentNameUnique(trimmed, agentId);
  }
  // CLI-backed agents have no authored workflow / skill_list — the
  // edit prompt forbids the LLM from emitting those tags, but if it
  // slips up we silently drop the field so the spec stays clean.
  // Compute on the post-update runtime: a runtime change in the same
  // turn (in_process → cli) takes effect first, then the strip runs.
  const incomingRuntime = Object.prototype.hasOwnProperty.call(updates || {}, 'runtime')
    ? _normalizeRuntime((updates as any).runtime)
    : null;
  const effectiveCli = incomingRuntime
    ? incomingRuntime.kind === 'cli'
    : (_normalizeRuntime((data as any).runtime)?.kind === 'cli');
  if (effectiveCli) {
    if ('workflow' in (updates || {})) delete (updates as any).workflow;
    if ('skill_list' in (updates || {})) delete (updates as any).skill_list;
  }
  for (const k of ['name', 'workflow'] as const) {
    if (Object.prototype.hasOwnProperty.call(updates || {}, k)) {
      const v = (updates as any)[k];
      (data as any)[k] = typeof v === 'string' ? v : '';
    }
  }
  // First migrate any persisted legacy `description` into the bilingual pair
  // (lossless). Then apply incoming updates: explicit `description_zh` /
  // `description_en` write through; legacy `description` routes via Chinese-
  // character heuristic into whichever side wasn't already set this turn.
  // Strip legacy `description` from the JSON at the end so it can't shadow
  // explicit values on the next read.
  {
    const persisted = typeof (data as any).description === 'string' ? (data as any).description.trim() : '';
    if (persisted) {
      const isChinese = /[一-鿿]/.test(persisted);
      if (isChinese && !(data as any).description_zh) (data as any).description_zh = persisted;
      else if (!isChinese && !(data as any).description_en) (data as any).description_en = persisted;
    }
  }
  const hasZh = Object.prototype.hasOwnProperty.call(updates || {}, 'description_zh');
  const hasEn = Object.prototype.hasOwnProperty.call(updates || {}, 'description_en');
  const hasLegacy = Object.prototype.hasOwnProperty.call(updates || {}, 'description');
  if (hasZh) {
    const v = (updates as any).description_zh;
    data.description_zh = typeof v === 'string' ? v : '';
  }
  if (hasEn) {
    const v = (updates as any).description_en;
    data.description_en = typeof v === 'string' ? v : '';
  }
  if (hasLegacy) {
    const v = (updates as any).description;
    // Non-string legacy update is a no-op: with two distinct language slots
    // there is no sane "clear description" interpretation. Use explicit
    // `description_zh` / `description_en` updates to clear individual sides.
    if (typeof v === 'string') {
      const legacy = v.trim();
      if (legacy) {
        const isChinese = /[一-鿿]/.test(legacy);
        if (isChinese && !hasZh) data.description_zh = legacy;
        if (!isChinese && !hasEn) data.description_en = legacy;
      }
    }
  }
  delete (data as any).description;
  if (Object.prototype.hasOwnProperty.call(updates || {}, 'skill_list')) {
    const v = updates.skill_list;
    if (v === null) {
      delete data.skill_list;
    } else if (Array.isArray(v)) {
      const raw = v.filter((x) => typeof x === 'string' && safeId(x));
      const specs = await listSkillSpecs();
      const known = new Set(specs.map((s) => s.id));
      const ids: string[] = [];
      const unknown: string[] = [];
      for (const id of raw) {
        if (known.has(id)) ids.push(id);
        else unknown.push(id);
      }
      if (unknown.length) {
        log.warn(`agent ${agentId}: unknown skills dropped: ${unknown.join(',')}`);
      }
      data.skill_list = ids;
    }
    // any other value (undefined sneaking through) is a no-op
  }
  if (Object.prototype.hasOwnProperty.call(updates || {}, 'inputs')) {
    const v = updates.inputs;
    if (v === null) {
      delete data.inputs;
    } else if (Array.isArray(v)) {
      // Re-validate on every write so even a trusted caller can't slip a
      // half-formed schema past us.
      data.inputs = validateAgentInputs(v);
    }
  }
  if (Object.prototype.hasOwnProperty.call(updates || {}, 'icon')) {
    const v = (updates as any).icon;
    if (avatars.isKnownIcon(v)) data.icon = v;
  }
  if (Object.prototype.hasOwnProperty.call(updates || {}, 'color')) {
    const v = (updates as any).color;
    if (avatars.isKnownColor(v)) data.color = v;
  }
  if (Object.prototype.hasOwnProperty.call(updates || {}, 'interactive')) {
    const v = updates.interactive;
    if (v === null) {
      delete data.interactive;
    } else if (typeof v === 'boolean') {
      data.interactive = v;
    }
  }
  if (Object.prototype.hasOwnProperty.call(updates || {}, 'runtime')) {
    const v = updates.runtime;
    // The runtime *kind* is locked at create time. Once an agent is
    // CLI-backed, post-create updates may only swap which CLI backs
    // it (cli → cli with a different `cli` field); reverting to
    // in-process would orphan the description / inputs that were
    // authored for a CLI runtime. The renderer enforces this in the
    // detail-page selector; we mirror it here so the rule survives
    // any other update path (tests, future scripts, IPC misuse).
    const existingKind: 'cli' | 'in_process' = data.runtime &&
      _normalizeRuntime(data.runtime)?.kind === 'cli' ? 'cli' : 'in_process';
    const incomingKind: 'cli' | 'in_process' | null = v === null
      ? 'in_process'
      : (_normalizeRuntime(v)?.kind === 'cli' ? 'cli' : 'in_process');
    if (incomingKind !== null && incomingKind !== existingKind) {
      log.warn(`agent ${agentId}: ignored runtime kind switch ${existingKind} → ${incomingKind}`);
    } else if (v === null) {
      delete data.runtime;
    } else {
      const rt = _normalizeRuntime(v);
      if (!rt || rt.kind === 'in_process') delete data.runtime;
      else data.runtime = rt;
    }
    // Reconcile the project_dir input with the (post-update) cli kind.
    // Coding cli ↔ project_dir input is a contract, not a user-authored
    // schema: swap claude → codex keeps it, swap to a non-coding cli
    // drops it, etc. We don't touch any other input the user defined.
    const finalCli = data.runtime && _normalizeRuntime(data.runtime)?.kind === 'cli'
      ? (_normalizeRuntime(data.runtime) as Extract<AgentRuntime, { kind: 'cli' }>).cli
      : '';
    const wantsProjectDir = cliIsCodingAgent(finalCli);
    const inputs = Array.isArray(data.inputs) ? validateAgentInputs(data.inputs) : [];
    const without = inputs.filter((i) => i.id !== PROJECT_DIR_INPUT_ID);
    if (wantsProjectDir) data.inputs = [PROJECT_DIR_INPUT, ...without];
    else if (without.length) data.inputs = without;
    else delete data.inputs;
  }
  if (!data.name) data.name = '未命名智能体';
  data.updated_at = nowIso();
  await writeJson(f, data);
  _invalidateAgentListCache();
  log.info(`updated id=${agentId}`);
  // Propagate a name change into every conversation roster that already
  // lists this agent. members.json snapshots the name at join time and the
  // @-router resolves on roster-first, so without this sweep `@<old-name>`
  // would keep matching in old chats.
  const newName = typeof (data as any).name === 'string' ? (data as any).name : '';
  if (newName && newName !== oldName) {
    try { await renameAgentInMembers(getActiveUserId(), agentId, newName); }
    catch (err) { log.warn(`rename roster sweep failed id=${agentId}: ${(err as Error).message}`); }
  }
  return normalizeAgent(data, 'custom');
}

/**
 * Append a single skill id to the agent's skill_list. Skips the unknown-id
 * filter `updateCustomAgent` does — System B (self-evolution `SkillStore`)
 * skills live in a different directory from System A (`SkillLoader`) and
 * would be dropped.
 *
 * No-op when:
 *   - agent missing / is builtin
 *   - agent.skill_list is undefined (unrestricted — agent already sees all)
 *   - skillId is already in the list
 */
export async function appendAgentSkill(agentId: string, skillId: string): Promise<boolean> {
  if (!agentId || !safeId(skillId)) return false;
  const f = customAgentFile(agentId);
  if (!fs.existsSync(f)) return false;
  const data = await readJson<AgentRaw>(f);
  if (!Array.isArray(data.skill_list)) return false;
  if (data.skill_list.includes(skillId)) return false;
  data.skill_list = [...data.skill_list, skillId];
  data.updated_at = nowIso();
  await writeJson(f, data);
  _invalidateAgentListCache();
  log.info(`appended skill "${skillId}" to agent ${agentId}.skill_list`);
  return true;
}

export async function deleteCustomAgent(agentId: string): Promise<boolean> {
  if (!agentId) return false;
  const dir = agentDir(getActiveUserId(), agentId);
  if (!fs.existsSync(dir)) return false;
  // 一刀切 `agents/<aid>/` 整个目录:agent.json + meta/ + skills/ 都在里面,
  // 不再需要单独 cascade metacognition.purgeAgent / SkillStore.delete。
  try { await fsp.rm(dir, { recursive: true, force: true }); }
  catch (err) { log.warn(`rm failed ${dir}: ${(err as Error).message}`); return false; }
  _invalidateAgentListCache();

  // Drop each user's per-agent edit chat directory + the matching
  // core-agent session jsonl. Without the session purge, recreating an
  // agent with the same name would reload the deleted agent's transcript
  // and the LLM would appear to "remember" the previous attempt.
  if (fs.existsSync(WS_ROOT)) {
    for (const uidEntry of await fsp.readdir(WS_ROOT, { withFileTypes: true })) {
      if (!uidEntry.isDirectory()) continue;
      const uid = uidEntry.name;
      const chatDir = userAgentChatDir(uid, agentId);
      if (fs.existsSync(chatDir)) {
        try { await fsp.rm(chatDir, { recursive: true, force: true }); }
        catch (err) { log.warn(`rm failed user=${uid} agent=${agentId}: ${(err as Error).message}`); }
        invalidateLineCount(path.join(chatDir, 'chat.jsonl'));
      }
      const sessionId = defaultAgentEditSessionId(uid, agentId);
      try { evictSession(sessionId); } catch { /* cache may not hold it */ }
      const sessionJsonl = userSessionFile(uid, sessionId);
      try { await fsp.unlink(sessionJsonl); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(`session unlink user=${uid} agent=${agentId}: ${(err as Error).message}`);
        }
      }
    }
  }

  // Cascade: drop every conversation tied to this agent across every user.
  try {
    // Lazy require breaks the circular chats↔agents dependency.
    const chats = require('./chats');
    await chats.deleteConversationsByAgent(agentId);
  } catch (err) {
    log.warn(`cascade chat cleanup failed for ${agentId}: ${(err as Error).message}`);
  }
  // Metacognition + evolved skills 已随 `rm -rf agents/<aid>/` 一并删除——
  // meta / skills 子目录就在这棵树里。无需单独 purge。

  log.info(`deleted id=${agentId}`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Inline edit chat (per user × agent)
// ─────────────────────────────────────────────────────────────────────────

// Single outer container: `<agent>...</agent>`. Inside: child tags `<name>`,
// `<description>`, `<workflow>`, `<skills>`, `<inputs>`. One container per
// turn gives us atomic extraction (all fields in or none) and a single
// placeholder to stream-hide. Shared between agent-edit chat and main-chat
// quick-create; see `chat_agent_setup.md` / `chat_commander.md` § 创建智能体.
const AGENT_CONTAINER_RE = /<agent>([\s\S]*?)<\/agent>/g;
const AGENT_CHILD_RE = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);

export interface ExtractedFields {
  /** Parsed from `<agent_id>` inside `<agent>`. Present → commander wants to
   * patch this existing custom agent (main-chat edit flow); absent → create
   * a brand-new agent. The agent-edit-chat surface ignores this field — the
   * target id is supplied by URL context, the LLM never writes it. Body
   * must pass `safeId`; otherwise the key is dropped (mis-spelled id should
   * NOT silently fall through to the create branch). */
  agent_id?: string;
  name?: string;
  description?: string;
  description_zh?: string;
  description_en?: string;
  workflow?: string;
  /** Parsed from `<skills>` inside `<agent>`. Empty tag body → `[]` (explicit
   * zero). Absent tag → key omitted (leave `skill_list` untouched). */
  skill_list?: string[];
  /** Parsed from `<inputs>` inside `<agent>`. Empty body → `[]` (explicit
   * zero). Absent or malformed JSON → key omitted. */
  inputs?: AgentInput[];
  /** Parsed from `<interactive>` inside `<agent>`. Body must be `true` or
   * `false` (case-insensitive); anything else → key omitted (leave the
   * existing flag untouched). */
  interactive?: boolean;
}

export function extractAgentFieldBlocks(text: string): { cleanText: string; fields: ExtractedFields } {
  if (!text || text.indexOf('<agent>') < 0) return { cleanText: text, fields: {} };
  const fields: ExtractedFields = {};
  // Only parse the FIRST container in a turn — the LLM is instructed to
  // emit one per reply. Subsequent containers (shouldn't happen) still get
  // stripped below via the global-flag replace.
  const first = text.match(/<agent>([\s\S]*?)<\/agent>/);
  if (first) {
    const inner = first[1];
    const aidM = inner.match(AGENT_CHILD_RE('agent_id'));
    if (aidM) {
      const v = aidM[1].trim();
      if (safeId(v)) fields.agent_id = v;
    }
    const nameM = inner.match(AGENT_CHILD_RE('name'));
    if (nameM) {
      const v = nameM[1].trim();
      if (v) fields.name = v;
    }
    const descM = inner.match(AGENT_CHILD_RE('description'));
    if (descM) {
      const v = descM[1].trim();
      if (v) fields.description = v;
    }
    const descZhM = inner.match(AGENT_CHILD_RE('description_zh'));
    if (descZhM) {
      const v = descZhM[1].trim();
      if (v) fields.description_zh = v;
    }
    const descEnM = inner.match(AGENT_CHILD_RE('description_en'));
    if (descEnM) {
      const v = descEnM[1].trim();
      if (v) fields.description_en = v;
    }
    const wfM = inner.match(AGENT_CHILD_RE('workflow'));
    if (wfM) {
      const v = wfM[1].trim();
      if (v) fields.workflow = v;
    }
    const skM = inner.match(AGENT_CHILD_RE('skills'));
    if (skM) {
      // One skill_id per line; empty body / all-blanks → explicit []
      // (zero skills). Non-safeId entries are dropped with no warning.
      fields.skill_list = skM[1]
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && safeId(s));
    }
    const inM = inner.match(AGENT_CHILD_RE('inputs'));
    if (inM) {
      const trimmed = inM[1].trim();
      if (trimmed === '' || trimmed === '[]') {
        fields.inputs = [];
      } else {
        try {
          const parsed = JSON.parse(trimmed);
          fields.inputs = validateAgentInputs(parsed);
        } catch (err) {
          log.warn(`<inputs> JSON parse failed: ${(err as Error).message}`);
          // Leave fields.inputs unset — malformed JSON shouldn't erase the
          // previous schema; let the next turn re-emit and fix it.
        }
      }
    }
    const itM = inner.match(AGENT_CHILD_RE('interactive'));
    if (itM) {
      const v = itM[1].trim().toLowerCase();
      if (v === 'true') fields.interactive = true;
      else if (v === 'false') fields.interactive = false;
      // Any other body → leave key omitted; previous flag survives.
    }
  }
  const cleaned = text.replace(AGENT_CONTAINER_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText: cleaned, fields };
}

function agentChatDir(userId: string, agentId: string): string {
  const d = userAgentChatDir(userId, agentId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function agentChatMsgsPath(userId: string, agentId: string): string {
  return path.join(agentChatDir(userId, agentId), 'chat.jsonl');
}

function agentChatMetaPath(userId: string, agentId: string): string {
  return path.join(agentChatDir(userId, agentId), 'chat.json');
}

function defaultAgentEditSessionId(userId: string, agentId: string): string {
  return `${userId}-agent-${agentId}`;
}

async function loadAgentChatMeta(userId: string, agentId: string): Promise<AgentChatMeta> {
  const p = agentChatMetaPath(userId, agentId);
  if (!fs.existsSync(p)) return {};
  try {
    const data: any = await readJson(p);
    return (data && typeof data === 'object') ? (data as AgentChatMeta) : {};
  } catch { return {}; }
}

async function saveAgentChatMeta(userId: string, agentId: string, meta: AgentChatMeta): Promise<void> {
  await writeJson(agentChatMetaPath(userId, agentId), meta);
}

export async function getAgentChatMessages(userId: string, agentId: string, limit = 500): Promise<any[]> {
  return readJsonl(agentChatMsgsPath(userId, agentId), limit);
}

async function _appendAgentChatMessage(userId: string, agentId: string, record: any): Promise<void> {
  const file = agentChatMsgsPath(userId, agentId);
  await appendJsonlAtomic(file, record);
}

export async function clearAgentChat(userId: string, agentId: string): Promise<boolean> {
  const agent = await getAgent(agentId);
  if (!agent || agent.source !== 'custom') return false;
  for (const p of [agentChatMsgsPath(userId, agentId), agentChatMetaPath(userId, agentId)]) {
    if (fs.existsSync(p)) {
      try { await fsp.unlink(p); }
      catch (err) { log.warn(`rm failed ${p}: ${(err as Error).message}`); }
    }
  }
  invalidateLineCount(agentChatMsgsPath(userId, agentId));
  // Also evict + drop the core-agent persistent session jsonl. Without this
  // the LLM retains its full prior context even though the UI history is
  // empty — same bug pattern as clearSkillChat (paths from before a
  // promote-to-builtin survive in the LLM's memory).
  const sessionId = defaultAgentEditSessionId(userId, agentId);
  try { evictSession(sessionId); } catch { /* not in cache */ }
  try { await fsp.unlink(userSessionFile(userId, sessionId)); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`session unlink user=${userId} agent=${agentId}: ${(err as Error).message}`);
    }
  }
  log.info(`cleared user=${userId} agent=${agentId}`);
  return true;
}

/**
 * Build the system prompt for the agent-edit chat. Includes the current
 * agent fields so the LLM always sees up-to-date state — re-run every turn.
 * The skill list is NOT embedded here; core-agent's SkillLoader appends it
 * to the final system prompt.
 */
export function buildAgentEditSystemPrompt(agent: {
  name?: string;
  /** Legacy single-language seed; auto-routed via Chinese-character heuristic. */
  description?: string;
  description_zh?: string;
  description_en?: string;
  workflow?: string;
  interactive?: boolean;
  /** When the agent is CLI-backed, switch to `chat_agent_setup_cli.md`
   *  which omits workflow/skills authoring and tells the LLM not to
   *  emit those sub-tags. */
  runtime?: AgentRuntime;
}): string {
  // Resolve all three forms into a single legacy `$description` placeholder
  // (template still uses $description in this phase) plus the bilingual
  // pair for forward-compat. Phase 2 will split the template.
  const legacy = (agent.description || '').trim();
  const isChinese = /[一-鿿]/.test(legacy);
  const zh = (agent.description_zh || '').trim() || (legacy && isChinese ? legacy : '');
  const en = (agent.description_en || '').trim() || (legacy && !isChinese ? legacy : '');
  const display = legacy || zh || en;
  const isCli = agent.runtime?.kind === 'cli';
  // Pick the right template + the placeholder set it expects. The CLI
  // template doesn't reference `$workflow` (workflow is hidden for CLI
  // agents) but does reference the runtime cli + model so the LLM can
  // talk concretely about which CLI it is.
  const body = isCli
    ? prompts.load('chat_agent_setup_cli', {
        // Runtime cli + model are deliberately NOT passed: the LLM is
        // told to stay CLI-agnostic in the description, and surfacing
        // the current binding tempts it to name the CLI inline (which
        // forbiddenly bakes a brand into the description).
        name: agent.name || '',
        description_zh: zh || '(not provided)',
        description_en: en || '(not provided)',
        interactive: agent.interactive === true ? 'true' : 'false',
      })
    : prompts.load('chat_agent_setup', {
        name: agent.name || '',
        description: display || '(not provided)',
        description_zh: zh || '(not provided)',
        description_en: en || '(not provided)',
        workflow: (agent.workflow || '').trim() || '(not provided)',
        interactive: agent.interactive === true ? 'true' : 'false',
      });
  return `${body}\n\n---\n\n${buildLanguageDirective()}`;
}

export interface AgentEditResult {
  ok: boolean;
  message?: string;
  error?: string;
  updated?: ExtractedFields;
}

export async function sendToAgentEditChat(userId: string, agentId: string, content: string): Promise<AgentEditResult> {
  const agent = await getAgent(agentId);
  if (!agent) return { ok: false, error: 'agent not found' };
  if (agent.source !== 'custom') return { ok: false, error: t('errors.builtin_agent_not_editable') };

  const meta = await loadAgentChatMeta(userId, agentId);
  const sessionId = meta.session_id || defaultAgentEditSessionId(userId, agentId);

  const systemPrompt = buildAgentEditSystemPrompt(agent);

  await _appendAgentChatMessage(userId, agentId,
    { time: nowIso(), role: 'user', content });

  const { chatWithModel } = require('../model/client');
  const result = await chatWithModel({
    userId, message: content, sessionId, systemPrompt,
    agentName: 'orkas_chat', timeout: 300,
  });

  if (!result.ok) {
    const errMsg = `模型响应失败: ${result.error || 'unknown'}`;
    await _appendAgentChatMessage(userId, agentId,
      { time: nowIso(), role: 'assistant', content: errMsg });
    return { ok: false, message: errMsg, error: result.error || '' };
  }

  const { cleanText, fields } = extractAgentFieldBlocks(result.text);
  const updated: ExtractedFields = {};
  if (Object.keys(fields).length) {
    await updateCustomAgent(agentId, fields);
    Object.assign(updated, fields);
  }

  await _appendAgentChatMessage(userId, agentId,
    { time: nowIso(), role: 'assistant', content: cleanText });
  await saveAgentChatMeta(userId, agentId, { session_id: sessionId });

  return { ok: true, message: cleanText, updated };
}

const MAX_AGENT_PROCESS_ITEMS = 300;

export async function* streamSendToAgentEditChat(
  userId: string, agentId: string, content: string,
  opts: { abortSignal?: AbortSignal } = {},
): AsyncGenerator<any, void, unknown> {
  const agent = await getAgent(agentId);
  if (!agent) {
    yield { type: 'error', text: 'agent not found' };
    yield { type: 'done' };
    return;
  }
  if (agent.source !== 'custom') {
    yield { type: 'error', text: '内置智能体不可通过对话编辑' };
    yield { type: 'done' };
    return;
  }

  const meta = await loadAgentChatMeta(userId, agentId);
  const sessionId = meta.session_id || defaultAgentEditSessionId(userId, agentId);

  const systemPrompt = buildAgentEditSystemPrompt(agent);

  await _appendAgentChatMessage(userId, agentId,
    { time: nowIso(), role: 'user', content });

  const { streamChatWithModel } = await import('../model/client');
  let finalText: string | null = null;
  let errMsg: string | null = null;
  // Running assistant delta buffer. On user abort the IPC layer's `break`
  // triggers `return()` at the current yield, which skips the post-loop
  // append — finally salvages whatever was already rendered.
  let streamingText = '';
  const updated: ExtractedFields = {};
  const processItems: any[] = [];

  try {
    for await (let event of streamChatWithModel({
      userId, message: content, sessionId, systemPrompt,
      agentName: 'orkas_chat',
      cacheRetention: 'short',
      ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    }) as AsyncIterable<any>) {
      const etype = event.type;
      if (etype === 'delta' && typeof event.text === 'string') {
        streamingText += event.text;
      }
      // Domain events from field-block extraction are synthesized *before*
      // the transformed `final` yields, so they land in the process rail
      // above the assistant reply — same ordering as tool_start lines in
      // main chat. Populated only on the final-event branch below.
      const synthesizedProgress: string[] = [];
      if (etype === 'final') {
        const raw = event.text || '';
        const { cleanText, fields } = extractAgentFieldBlocks(raw);
        if (Object.keys(fields).length) {
          await updateCustomAgent(agentId, fields);
          Object.assign(updated, fields);
          for (const k of ['name', 'workflow'] as const) {
            if (fields[k] !== undefined) {
              synthesizedProgress.push(t('process.agent.update_field', { field: k }));
            }
          }
          // Collapse description / description_zh / description_en into one
          // user-facing progress event — the user sees "简介更新" regardless
          // of which language slot the LLM filled this turn.
          const descTouched = fields.description !== undefined
            || fields.description_zh !== undefined
            || fields.description_en !== undefined;
          if (descTouched) {
            synthesizedProgress.push(t('process.agent.update_field', { field: 'description' }));
          }
          if (fields.skill_list !== undefined) {
            synthesizedProgress.push(fields.skill_list.length
              ? t('process.agent.update_skills', { list: fields.skill_list.join(', ') })
              : t('process.agent.clear_skills'));
          }
          if (fields.inputs !== undefined) {
            synthesizedProgress.push(fields.inputs.length
              ? t('process.agent.update_inputs', { list: fields.inputs.map((i) => i.id).join(', ') })
              : t('process.agent.clear_inputs'));
          }
          if (fields.interactive !== undefined) {
            synthesizedProgress.push(t('process.agent.update_interactive', { value: String(fields.interactive) }));
          }
        }
        finalText = cleanText;
        event = { type: 'final', text: cleanText, updated };
      } else if (etype === 'error') {
        errMsg = `模型响应失败: ${event.text || 'unknown'}`;
      }

      for (const text of synthesizedProgress) {
        if (processItems.length < MAX_AGENT_PROCESS_ITEMS) {
          processItems.push({ type: 'progress', text });
        }
        yield { type: 'progress', text };
      }

      if (processItems.length < MAX_AGENT_PROCESS_ITEMS) {
        if (etype === 'progress' && event.text) {
          processItems.push({ type: 'progress', text: event.text });
        } else if (etype === 'event') {
          const inner = event.event || {};
          if (inner.stream && inner.stream !== 'assistant') {
            processItems.push({ type: 'event', event: inner });
          }
        }
      }
      yield event;
    }

  } catch (err) {
    log.error('stream failed:', err);
    const msg = (err as Error).message || String(err);
    errMsg = `模型响应失败: ${msg}`;
    yield { type: 'error', text: msg };
  } finally {
    // Must live in finally: on user abort the IPC layer breaks out of the
    // for-await, which triggers `return()` on this generator — bypassing any
    // append placed after the loop. Keeping it here covers normal finish,
    // caught errors, and abort-driven returns alike.
    const saved = processItems.length ? processItems : null;
    try {
      if (finalText !== null) {
        await _appendAgentChatMessage(userId, agentId,
          { time: nowIso(), role: 'assistant', content: finalText, ...(saved ? { process: saved } : {}) });
        await saveAgentChatMeta(userId, agentId, { session_id: sessionId });
      } else if (errMsg) {
        const partial = streamingText.trim();
        const content = partial ? `${streamingText}\n\n${errMsg}` : errMsg;
        await _appendAgentChatMessage(userId, agentId,
          { time: nowIso(), role: 'assistant', content, ...(saved ? { process: saved } : {}) });
      } else if (streamingText.trim() || processItems.length) {
        const content = streamingText.trim()
          ? `${streamingText}\n\n（回复已中断）`
          : '（回复已中断）';
        await _appendAgentChatMessage(userId, agentId,
          { time: nowIso(), role: 'assistant', content, ...(saved ? { process: saved } : {}) });
      }
    } catch (e) {
      log.warn(`persist agent chat assistant failed agent=${agentId}: ${(e as Error).message}`);
    }
  }
}

export function isValidAgentId(id: unknown): boolean {
  return typeof id === 'string' && id.length > 0 && safeId(id);
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Quick-create agent from main chat
// ─────────────────────────────────────────────────────────────────────────

/**
 * Turn parsed `<agent>` container fields (from `extractAgentFieldBlocks`)
 * into a brand-new custom agent. Returns null if the mandatory fields
 * (name + workflow) are missing or the underlying create/update calls
 * fail — caller decides how to surface the failure to the user.
 *
 * Same container format as the agent-edit chat — parsing is shared
 * (`extractAgentFieldBlocks`), only the outcome differs: agent-edit
 * updates an existing agent, this one creates a fresh one.
 */
export async function createAgentFromBlocks(fields: ExtractedFields): Promise<Agent | null> {
  const name = (fields.name || '').trim();
  const workflow = (fields.workflow || '').trim();
  if (!name || !workflow) return null;
  const description = (fields.description || '').trim();
  const description_zh = (fields.description_zh || '').trim();
  const description_en = (fields.description_en || '').trim();

  const created = await createCustomAgent({
    name, description, description_zh, description_en, workflow,
    ...(typeof fields.interactive === 'boolean' ? { interactive: fields.interactive } : {}),
  });
  if (!created) return null;
  // Fold optional skill_list + inputs in via updateCustomAgent so the
  // closure expansion / input validation happens in one place.
  const updates: UpdateAgentFields = {};
  if (Array.isArray(fields.skill_list)) updates.skill_list = fields.skill_list;
  if (Array.isArray(fields.inputs)) updates.inputs = fields.inputs;
  if (Object.keys(updates).length) {
    const updated = await updateCustomAgent(created.agent_id, updates);
    return updated || created;
  }
  return created;
}
