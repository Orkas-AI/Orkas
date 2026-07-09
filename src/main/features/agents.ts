/**
 * Agents — listing, custom CRUD, marketplace installs, inline edit chat.
 *
 * Mirrors the skills module shape. Two sources:
 *   marketplace — <uid>/local/marketplace/agents/<id>/agent.json
 *   custom      — <uid>/cloud/agents/<id>/agent.json
 *
 * Schema (one JSON per agent):
 *   { agent_id, name, description, workflow, created_at, updated_at }
 *
 * The inline "edit" chat lets the LLM refine an agent by emitting one
 * `<agent>...</agent>` container per turn, whose children are the fields
 * to update: `<name>` / `<description>` / `<workflow>` / `<skills>` /
 * `<inputs>`. Each child is a full-replacement update for that field.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import type { AgentTool } from '#core-agent';

import {
  userAgentsDir, userSkillsDir, userAgentChatDir, userSessionFile, WS_ROOT,
  agentDir, agentDefinitionFile, agentRuntimeStatsFile,
  userMarketplaceAgentsDir, userMarketplaceAgentDir, userMarketplaceSkillsDir,
  userAgentRuntimeConfigFile, chatAttachmentDir,
} from '../paths';
import { evictSession } from '../model/core-agent/session-store';
import { getActiveUserId } from './users';
import { createLogger } from '../logger';
import { t, buildLanguageDirective, descriptionLang } from '../i18n';
import { getLanguage } from './config';
import { getWorkspacePath } from './user_workspace';
import { buildAttachmentManifest } from './chat_attachments';
import { addAgentEntry, listAgentEntries, removeAgentEntry, replaceAgentEntry } from './memory';
import {
  normalizeAgentRuntimeStatsFile,
  recordAgentRuntimeStatsForDevice,
  type AgentRuntimeStatsBucket,
} from './agent_runtime_stats';
import { getCurrentDevice } from '../util/device';

const log = createLogger('agents');

// Custom agents / skills roots — resolved from the active uid every call.
function CUSTOM_AGENTS_DIR(): string { return userAgentsDir(getActiveUserId()); }
function CUSTOM_SKILLS_DIR(): string { return userSkillsDir(getActiveUserId()); }
import { prompts } from '../prompts/loader';
import { buildRuntimeDatetimeBlock } from '../prompts/runtime_context';
import { findOuterTagRanges } from '../util/markdown-prose-code';
import {
  nowIso, genAgentId, safeId,
  readJson, writeJson,
  appendJsonlAtomic, invalidateLineCount, readJsonl,
} from '../storage';
import {
  listSkillSpecsForAgentMetadata,
  normalizeKnownSkillRefsForDisplay,
  openSkillReadRoots,
  resolveSkillAllowlistRefs,
  searchOpenTierSkills,
  type SkillAllowlistRef,
} from '../model/core-agent/skill-registry';
import { readDisabledSets, setAgentEnabled } from './component_enabled';
import { renameAgentInMembers } from './group_chat/state';
import { validateAgentSpec, ValidationReport as QualityReport } from '../quality';
import { persistReport as persistQualityReport } from '../quality/report';
import {
  DEFAULT_MARKETPLACE_CATEGORY_CODE,
  normalizeMarketplaceCategoryCode,
} from './marketplace_biz';
import { normalizeInstallVersion } from './marketplace_installs';
import { NAME_DISPLAY_MAX_UNITS, nameDisplayWidth } from '../util/name-limit';

export type AgentSource = 'marketplace' | 'custom';
type AgentSourceInput = AgentSource | 'builtin';
export type AgentPrioritySource = 'builtin' | 'platform' | 'custom';

export type AgentInputType = 'text' | 'textarea' | 'select' | 'multiselect' | 'number' | 'boolean' | 'file' | 'directory';

export interface AgentInputOption {
  value: string;
  label: string;
}

/** Declarative schema for an agent's user-facing input parameters.
 * Populated by the agent-edit LLM (or commander quick-create) via the
 * `<inputs>` child of the `<agent>` update container; consumed at run
 * time by the agent itself per `chat_agent_in_group.md` § inputs_schema
 * mandatory-confirmation trigger (it emits a fenced `agent-input-form` block when fields
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

export interface AgentProfileEntry {
  title: string;
  description?: string;
  tool?: string;
  source?: string;
  scope?: string;
  updated_at?: string;
  kept?: boolean;
}

export interface AgentProfileStat {
  key: string;
  value: string | number;
  unit?: string;
  label?: string;
}

export interface AgentProfileRecent {
  title: string;
  when?: string;
  project?: string;
}

export interface AgentProfileScope {
  accepts?: string[];
  rejects?: string[];
}

/** Structured, display-facing profile for richer agents. Old agents can omit
 *  it entirely and still render from description/workflow/skills. New specs
 *  persist knowhow / standards as top-level fields; `profile` is the
 *  normalized read shape consumed by UI/runtime. */
export interface AgentProfile {
  role?: string;
  dispatch?: string;
  knowhow?: string[];
  standards?: string[];
  /** Legacy/read-only compatibility. New authoring must use top-level
   *  `workflow` markdown instead of profile.workflow. */
  workflow?: AgentProfileEntry[];
  scope?: AgentProfileScope;
  stats?: AgentProfileStat[];
  recent?: AgentProfileRecent[];
  /** Display-only memory assembled from the per-agent memory store on read.
   *  New authoring must not generate agent.json profile.memory. */
  memory?: AgentProfileEntry[];
  assets?: string[];
  serving?: string[];
}

export type AgentRuntimeStats = AgentRuntimeStatsBucket;

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
  /** Skill ids/names this agent declares as workflow dependencies.
   * Runtime group-chat agents use this as an upper bound, then inject only
   * dependencies also named in `workflow`. Undefined means no upper bound;
   * [] means explicit zero skills.
   * Maintained exclusively by the agent-edit LLM via the `<skills>` child of
   * the `<agent>` container. Not exposed in the UI. */
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
  /** Rich display profile for "AI employee" style agents. This is optional
   *  compatibility data: marketplace/new agents can provide it explicitly,
   *  while legacy agents keep using description/workflow. */
  profile?: AgentProfile;
  /** Runtime-derived counters. Stored outside agent.json so the definition is
   *  not rewritten on every dispatch; merged into list/detail reads. */
  runtime_stats?: AgentRuntimeStats;
  /** Execution backend. Missing / `kind === 'in_process'` (the default)
   *  means the agent runs through `core-agent` like every existing
   *  agent. `kind === 'cli'` routes the worker turn through
   *  `features/local_agents/runner.ts` to spawn a local coding CLI
   *  (claude code / codex / openclaw / opencode / hermes). The field is
   *  set at create time from the modal's runtime selector and edited
   *  via the dedicated `chat_agent_setup_cli.md` prompt; the LLM
   *  doesn't author it directly. */
  runtime?: AgentRuntime;
  /** Marketplace category code. Empty string only for legacy/manual specs.
   *  Maintained by hidden create defaults and by the agent-edit LLM's `<category>` sub-tag. */
  category: string;
  /** Connector instance ids previously selected for this agent. Runtime
   *  group-chat agents now share the commander's connector visibility; this is
   *  retained as UI/compatibility metadata. Maintained by the agent edit UI,
   *  NOT by the agent-edit LLM. */
  enabled_connectors?: string[];
  /** Output rendering preference — agent-level hint injected into the worker
   *  system prompt at dispatch time. Four user-facing values, progressive
   *  capability disclosure:
   *    - `'auto'`: default. The model chooses the lightest useful
   *      presentation: plain text/Markdown, inline dashboard, or interactive app.
   *    - `'text'`: blocks `:::dashboard` + `create_artifact`. The plain-reply
   *      hard constraint.
   *    - `'dashboard'`: allows `:::dashboard` blocks; still blocks `create_artifact`.
   *    - `'artifact'`: allows both `:::dashboard` and `create_artifact`.
   *  Legacy aliases kept for back-compat: `'markdown_only'` (old name for
   *  `'text'`) and `'allow_artifacts'` (old name for `'artifact'`).
   *  Missing field = auto. Authored by the agent edit UI dropdown, NOT the
   *  agent-edit LLM. See `bus.ts::buildOutputFormatHint`. */
  output_format?: OutputFormat;
  source: AgentSource;
  created_at: string;
  updated_at: string;
  /** **Computed at load time, not persisted.** Filled by `listAgents` /
   *  `getAgent` from `features/component_enabled.ts`. Defaults to true
   *  unless the user has explicitly disabled the agent. Don't write this
   *  field back to disk. */
  enabled: boolean;
  /** Marketplace author uid. Kept optional for install/reconcile compatibility; global UI
   *  surfaces must not render it. */
  create_uid?: string;
  /** Marketplace install version for `source==='marketplace'`. Read from `_install.json` so the
   *  agents-tab card can render a `v1.0.0` chip alongside the category. Custom agents leave
   *  this undefined (version is a publish concept, not authored locally). */
  version?: string;
  /** Marketplace install freshness read from `_install.json`. Renderer marketplace uses this
   *  to decide whether the server listing is newer than the local install. */
  marketplace_published_at?: number;
  marketplace_updated_at?: number;
  /** Server-side fresh-install seed flag mirrored from marketplace metadata. */
  default_install?: boolean;
  /** Dev-only publishing metadata mirrored from marketplace metadata. */
  is_open_source?: boolean;
  /** Marketplace review lifecycle status mirrored from marketplace metadata. */
  status?: string;
  /** Install provenance for marketplace-root agents. `builtin` means the
   *  packaged fallback copy, which wins conflict arbitration over platform
   *  marketplace installs and custom agents. */
  seed_source?: string;
}

export interface AgentRaw {
  agent_id?: string;
  _v?: unknown;
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
  category?: unknown;
  status?: unknown;
  state?: unknown;
  enabled_connectors?: unknown;
  output_format?: unknown;
  profile?: unknown;
  role?: unknown;
  dispatch?: unknown;
  knowhow?: unknown;
  standards?: unknown;
  flow?: unknown;
  workflow_steps?: unknown;
  doYes?: unknown;
  doNo?: unknown;
  stats?: unknown;
  runtime_stats?: unknown;
  recent?: unknown;
  memory?: unknown;
  assets?: unknown;
  serving?: unknown;
}

/** Agent output rendering preference. Four user-facing values
 *  (`'auto' | 'text' | 'dashboard' | 'artifact'`); the create modal defaults
 *  to `'auto'`. Legacy values are accepted and canonicalized on read/write:
 *  `'markdown_only'` → `'text'`, `'allow_artifacts'` → `'artifact'`.
 *  Missing field on disk = auto. */
export type OutputFormat = 'auto' | 'text' | 'dashboard' | 'artifact' | 'markdown_only' | 'allow_artifacts';
const _OUTPUT_FORMAT_VALUES = new Set<OutputFormat>(['auto', 'text', 'dashboard', 'artifact', 'markdown_only', 'allow_artifacts']);

function _canonicalOutputFormat(v: unknown): Exclude<OutputFormat, 'markdown_only' | 'allow_artifacts'> | null {
  if (v === 'markdown_only') return 'text';
  if (v === 'allow_artifacts') return 'artifact';
  if (v === 'auto' || v === 'text' || v === 'dashboard' || v === 'artifact') return v;
  return null;
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

// Avatar tokens are validated against the catalog allow-list
// (src/main/data/avatars.json is the single source of truth).
// renderer/modules/avatar.js pulls from the same file, so frontend and
// backend never duplicate it.
import * as avatars from './avatars';

function _applyMarketplaceInstallMeta(agent: Agent, dir: string): void {
  try {
    const metaFile = path.join(dir, '_install.json');
    if (!fs.existsSync(metaFile)) return;
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (!meta || typeof meta !== 'object') return;
    agent.version = normalizeInstallVersion(meta.version);
    if (typeof meta.published_at === 'number') agent.marketplace_published_at = meta.published_at;
    if (typeof meta.updated_at === 'number') agent.marketplace_updated_at = meta.updated_at;
    if (typeof meta.default_install === 'boolean') agent.default_install = meta.default_install;
    if (typeof meta.is_open_source === 'boolean') agent.is_open_source = meta.is_open_source;
    if (typeof meta.status === 'string') agent.status = meta.status;
    else if (typeof meta.state === 'string') agent.status = meta.state;
    if (typeof meta.seed_source === 'string') agent.seed_source = meta.seed_source;
  } catch (err) {
    log.warn(`marketplace agent install metadata unreadable dir=${dir}: ${(err as Error).message}`);
  }
}

export function agentPrioritySource(agent: Pick<Agent, 'source' | 'seed_source'>): AgentPrioritySource {
  if (agent.source === 'custom') return 'custom';
  return agent.seed_source === 'builtin' ? 'builtin' : 'platform';
}

export function agentPriorityRank(agent: Pick<Agent, 'source' | 'seed_source'>): number {
  switch (agentPrioritySource(agent)) {
    case 'builtin': return 0;
    case 'platform': return 1;
    case 'custom': return 2;
    default: return 99;
  }
}

export interface AgentChatMeta { session_id?: string; [k: string]: unknown }

// ─────────────────────────────────────────────────────────────────────────
// 1. Builtin agent sync (startup)
// ─────────────────────────────────────────────────────────────────────────

// `syncBuiltinAgents` / `hashTree` / `_isMarketplaceInstalled` removed — marketplace installs
// now write to `<uid>/local/marketplace/agents/` directly.

// ─────────────────────────────────────────────────────────────────────────
// 2. Read / list
// ─────────────────────────────────────────────────────────────────────────

function normalizeAgentSource(source: AgentSourceInput): AgentSource {
  return source === 'builtin' ? 'marketplace' : source;
}

function isMarketplaceSource(source: AgentSourceInput): boolean {
  return normalizeAgentSource(source) === 'marketplace';
}

/** Resolve where a given source's agents live on disk. */
function agentBaseDir(source: AgentSourceInput): string {
  const uid = getActiveUserId();
  return isMarketplaceSource(source) ? userMarketplaceAgentsDir(uid) : userAgentsDir(uid);
}

/** Helpers replacing the removed `builtinAgentDir` / `builtinAgentDefinitionFile`.
 *  Same shape but per-user (marketplace installs are per-user, not per-machine). */
function _platformAgentDir(agentId: string): string {
  return userMarketplaceAgentDir(getActiveUserId(), agentId);
}
function _platformAgentSpecFile(agentId: string): string {
  return path.join(_platformAgentDir(agentId), 'agent.json');
}

const INPUT_ID_RE = /^[a-z_][a-z0-9_]{0,31}$/;
const ALLOWED_INPUT_TYPES: readonly AgentInputType[] = ['text', 'textarea', 'select', 'multiselect', 'number', 'boolean', 'file', 'directory'];

// Reserved agent display names — collide with the commander role surfaced in
// the chat-recipient chip and the sidebar tab. The bus router also keys
// "commander" as a member id, so we guard localized display names and the
// English form. Comparison is case-insensitive after stripping all whitespace;
// whitespace itself is rejected by the charset guard below.
const RESERVED_AGENT_NAMES = new Set(['指挥官', '总指挥', 'コマンダー', '司令官', 'commander']);
function _agentNameKey(name: string): string {
  return String(name || '').replace(/\s+/g, '').toLowerCase();
}
function assertAgentNameAllowed(name: string): void {
  const key = _agentNameKey(name);
  if (!key) return; // empty handled elsewhere (defaults to t('agent.default_name'))
  if (/\s/.test(String(name))) assertAgentNameCharsetValid(name);
  if (RESERVED_AGENT_NAMES.has(key)) {
    const err: any = new Error(`agent name "${name}" is reserved`);
    err.code = 'E_AGENT_NAME_RESERVED';
    throw err;
  }
  assertAgentNameCharsetValid(name);
}

// Agent names must round-trip through the @-mention regex used by the
// router (`router.ts::TOKEN_CLASS = [A-Za-z0-9_一-鿿-]`) — slashes,
// backslashes, dots, parens, control chars etc. either truncate the
// match (e.g. `@Agent/SkillSomeName` only matches `Agent`) or escape the
// alternation arm at the regex stage. We additionally cap length. Any
// whitespace is rejected because UIs render names raw — stray whitespace
// looks like a typo nobody can see to fix.
const NAME_TOKEN_RE = /^[A-Za-z0-9_一-鿿-]+$/;
function assertAgentNameCharsetValid(name: string): void {
  if (name == null) return;
  const trimmed = String(name);
  if (!trimmed.trim()) return;
  if (trimmed !== trimmed.trim()) {
    const err: any = new Error(`agent name has leading or trailing whitespace`);
    err.code = 'E_AGENT_NAME_INVALID';
    throw err;
  }
  if (nameDisplayWidth(trimmed) > NAME_DISPLAY_MAX_UNITS) {
    const err: any = new Error(`agent name longer than ${NAME_DISPLAY_MAX_UNITS} display units`);
    err.code = 'E_AGENT_NAME_TOO_LONG';
    throw err;
  }
  if (!NAME_TOKEN_RE.test(trimmed)) {
    // Surface the offending literal + the specific bad chars so a streamed
    // error feeds the LLM enough signal to self-correct on the next turn,
    // instead of repeating the same forbidden character.
    const SINGLE_TOKEN_CHAR_RE = /[A-Za-z0-9_一-鿿-]/;
    const bad: string[] = [];
    const seen = new Set<string>();
    for (const ch of trimmed) {
      if (ch === ' ') continue;
      if (SINGLE_TOKEN_CHAR_RE.test(ch)) continue;
      if (!seen.has(ch)) { seen.add(ch); bad.push(ch); }
    }
    const detail = bad.length
      ? `forbidden character${bad.length > 1 ? 's' : ''}: ${bad.map(c => `\`${c}\``).join(' ')}`
      : 'spaces are not allowed';
    const err: any = new Error(`agent name "${trimmed}" contains unsupported characters — ${detail}. Allowed: ASCII letters / digits / \`_\` / \`-\` / CJK U+4E00–U+9FFF. Forbidden include spaces, \`/\` \`\\\` \`.\` \`,\` \`(\` \`)\` \`:\` \`!\` \`?\`, full-width punctuation, kana, hangul, extended-CJK, emoji.`);
    err.code = 'E_AGENT_NAME_INVALID';
    throw err;
  }
}

/** Reject names already in use by another agent (custom OR marketplace).
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
      // The prompt (chat_agent_in_group.md) explicitly allows the runtime
      // form to render an "empty form" (one without a default selection).
      // The old logic dropped the whole field on a missing/invalid
      // default, so all-empty fields → no form rendered → the raw
      // `<agent-input-form>` XML got rendered by markdown as unknown
      // HTML, breaking the user's styling. Graceful fallback: use
      // options[0].value (matching the browser's default-first-option
      // behavior for `<select>`).
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

function _plainObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function _cleanProfileString(v: unknown, max = 320): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const text = String(v).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function _firstProfileString(obj: Record<string, unknown>, keys: string[], max = 320): string {
  for (const k of keys) {
    const v = _cleanProfileString(obj[k], max);
    if (v) return v;
  }
  return '';
}

function _profileStringList(raw: unknown, limit = 16, max = 160): string[] | undefined {
  const arr = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const item of arr) {
    const text = _cleanProfileString(item, max);
    if (!text) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out.length ? out : undefined;
}

function _profileEntries(raw: unknown, limit = 16): AgentProfileEntry[] | undefined {
  const input = Array.isArray(raw)
    ? raw
    : (_plainObj(raw)
        ? Object.entries(raw as Record<string, unknown>).map(([key, value]) => {
            const obj = _plainObj(value);
            return obj ? { title: key, ...obj } : { title: key, description: value };
          })
        : []);
  const out: AgentProfileEntry[] = [];
  for (const item of input) {
    if (typeof item === 'string' || typeof item === 'number') {
      const title = _cleanProfileString(item, 220);
      if (title) out.push({ title });
    } else {
      const obj = _plainObj(item);
      if (!obj) continue;
      const title = _firstProfileString(obj, ['title', 't', 'name', 'n', 'label', 'k'], 220);
      const description = _firstProfileString(obj, ['description', 'd', 'summary', 'detail', 'body'], 520);
      if (!title && !description) continue;
      const entry: AgentProfileEntry = { title: title || description };
      if (description && description !== entry.title) entry.description = description;
      const tool = _firstProfileString(obj, ['tool', 'skill', 'action'], 120);
      const source = _firstProfileString(obj, ['source', 'from'], 160);
      const scope = _firstProfileString(obj, ['scope', 'visibility'], 120);
      const updatedAt = _firstProfileString(obj, ['updated_at', 'updatedAt', 'when'], 80);
      if (tool) entry.tool = tool;
      if (source) entry.source = source;
      if (scope) entry.scope = scope;
      if (updatedAt) entry.updated_at = updatedAt;
      if (obj.kept === false || obj.enabled === false) entry.kept = false;
      out.push(entry);
    }
    if (out.length >= limit) break;
  }
  return out.length ? out : undefined;
}

function _profileTextList(raw: unknown, limit = 16, max = 220): string[] | undefined {
  const input = Array.isArray(raw)
    ? raw
    : (_plainObj(raw) ? Object.entries(raw as Record<string, unknown>).map(([key, value]) => {
        const obj = _plainObj(value);
        if (!obj) return value ?? key;
        return obj.title ?? obj.name ?? obj.t ?? obj.label ?? obj.description ?? obj.d ?? key;
      }) : []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    let text = _cleanProfileString(item, max);
    if (!text) {
      const obj = _plainObj(item);
      if (!obj || obj.kept === false || obj.enabled === false) continue;
      text = _firstProfileString(obj, ['title', 't', 'name', 'n', 'label', 'k', 'description', 'd', 'summary', 'detail', 'body'], max);
    }
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out.length ? out : undefined;
}

function _profileStats(raw: unknown, limit = 8): AgentProfileStat[] | undefined {
  const arr = Array.isArray(raw) ? raw : [];
  const out: AgentProfileStat[] = [];
  for (const item of arr) {
    const obj = _plainObj(item);
    if (!obj) continue;
    const key = _firstProfileString(obj, ['key', 'k', 'label', 'title'], 80);
    const rawValue = obj.value ?? obj.v ?? obj.count;
    const value = (typeof rawValue === 'number' && Number.isFinite(rawValue))
      ? rawValue
      : _cleanProfileString(rawValue, 80);
    if (!key || value === '') continue;
    const stat: AgentProfileStat = { key, value };
    const unit = _firstProfileString(obj, ['unit', 'u'], 32);
    const label = _firstProfileString(obj, ['label'], 80);
    if (unit) stat.unit = unit;
    if (label && label !== key) stat.label = label;
    out.push(stat);
    if (out.length >= limit) break;
  }
  return out.length ? out : undefined;
}

function _profileRecent(raw: unknown, limit = 8): AgentProfileRecent[] | undefined {
  const arr = Array.isArray(raw) ? raw : [];
  const out: AgentProfileRecent[] = [];
  for (const item of arr) {
    const obj = _plainObj(item);
    if (!obj) continue;
    const title = _firstProfileString(obj, ['title', 't', 'name'], 220);
    if (!title) continue;
    const recent: AgentProfileRecent = { title };
    const when = _firstProfileString(obj, ['when', 'time', 'updated_at', 'updatedAt'], 80);
    const project = _firstProfileString(obj, ['project', 'proj'], 140);
    if (when) recent.when = when;
    if (project) recent.project = project;
    out.push(recent);
    if (out.length >= limit) break;
  }
  return out.length ? out : undefined;
}

function _profileValue(profile: Record<string, unknown>, raw: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(profile, k)) return profile[k];
  }
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) return raw[k];
  }
  return undefined;
}

function normalizeAgentProfile(raw: AgentRaw | null | undefined): AgentProfile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const outer = raw as Record<string, unknown>;
  const embedded = _plainObj(raw.profile) || {};
  const profile: AgentProfile = {};

  const role = _cleanProfileString(_profileValue(embedded, outer, ['role']), 140);
  const dispatch = _cleanProfileString(_profileValue(embedded, outer, ['dispatch']), 520);
  if (role) profile.role = role;
  if (dispatch) profile.dispatch = dispatch;

  const knowhow = _profileTextList(
    Object.prototype.hasOwnProperty.call(outer, 'knowhow') ? outer.knowhow : embedded.knowhow,
    16,
  );
  const standards = _profileTextList(
    Object.prototype.hasOwnProperty.call(outer, 'standards') ? outer.standards : embedded.standards,
    16,
  );
  if (knowhow) profile.knowhow = knowhow;
  if (standards) profile.standards = standards;

  const scopeObj = _plainObj(embedded.scope) || {};
  const accepts = _profileStringList(
    scopeObj.accepts ?? scopeObj.accept ?? embedded.doYes ?? outer.doYes,
    16,
  );
  const rejects = _profileStringList(
    scopeObj.rejects ?? scopeObj.reject ?? embedded.doNo ?? outer.doNo,
    16,
  );
  if (accepts || rejects) {
    profile.scope = {};
    if (accepts) profile.scope.accepts = accepts;
    if (rejects) profile.scope.rejects = rejects;
  }

  const stats = _profileStats(_profileValue(embedded, outer, ['stats']), 8);
  const recent = _profileRecent(_profileValue(embedded, outer, ['recent']), 8);
  const assets = _profileStringList(_profileValue(embedded, outer, ['assets']), 12);
  const serving = _profileStringList(_profileValue(embedded, outer, ['serving']), 12);
  if (stats) profile.stats = stats;
  if (recent) profile.recent = recent;
  if (assets) profile.assets = assets;
  if (serving) profile.serving = serving;

  return Object.keys(profile).length ? profile : undefined;
}

function normalizeAgentRuntimeStats(raw: unknown): AgentRuntimeStats | undefined {
  const stats = normalizeAgentRuntimeStatsFile(raw);
  return (
    stats.attempts
    || stats.successes
    || stats.deliveries
    || stats.failures
    || stats.errors
    || stats.total_duration_ms
    || stats.successful_duration_ms
    || stats.updated_at
  )
    ? stats
    : undefined;
}

export function normalizeAgent(raw: AgentRaw | null | undefined, source: AgentSourceInput): Agent | null {
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
    category: typeof raw.category === 'string' ? raw.category : '',
    ...(typeof raw.status === 'string' ? { status: raw.status } : (
      typeof raw.state === 'string' ? { status: raw.state } : {}
    )),
    source: normalizeAgentSource(source),
    created_at: raw.created_at || '',
    updated_at: raw.updated_at || '',
    // Defaults to enabled; overlaid by listAgents / getAgent from the
    // per-user enabled-overrides map. Don't read this field from raw JSON —
    // it is never persisted.
    enabled: true,
  };
  const profile = normalizeAgentProfile(raw);
  if (profile) agent.profile = profile;
  const runtimeStats = normalizeAgentRuntimeStats(raw.runtime_stats);
  if (runtimeStats) agent.runtime_stats = runtimeStats;
  // skill_list is authoring metadata / compatibility state. Anything else
  // (string, object, null) is treated as "unset" so malformed JSON does not
  // produce misleading dependency metadata.
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
  // enabled_connectors is UI/compatibility metadata. Runtime group-chat agents
  // share the commander's connector visibility; filtering keeps malformed JSON
  // from injecting weird ids into the detail UI.
  if (Array.isArray(raw.enabled_connectors)) {
    const filtered = raw.enabled_connectors
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter((v) => v.length > 0 && safeId(v));
    if (filtered.length) agent.enabled_connectors = filtered;
  }
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
  // output_format: enum-coerce + legacy alias canonicalization. Missing /
  // unknown collapses to "no field set" (downstream reads default to 'auto').
  const outputFormat = _canonicalOutputFormat(raw.output_format);
  if (outputFormat && outputFormat !== 'auto') {
    agent.output_format = outputFormat;
  }
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

interface AgentRuntimeLocalConfig {
  version: 1;
  project_dirs: Record<string, { path: string; updated_at?: string }>;
}

export interface AgentCliProjectDirInfo {
  agent_id: string;
  is_coding: boolean;
  /** `workspace` means no per-agent override; `custom` means the user picked a directory. */
  mode: 'workspace' | 'custom';
  /** Display path. For a missing custom dir this remains the selected path. */
  path: string;
  /** Actual cwd used by dispatch. Falls back to workspace when a custom dir vanished. */
  effective_path: string;
  workspace_path: string;
  custom_path?: string;
  exists: boolean;
}

function _emptyAgentRuntimeConfig(): AgentRuntimeLocalConfig {
  return { version: 1, project_dirs: {} };
}

function _readAgentRuntimeConfig(uid: string): AgentRuntimeLocalConfig {
  const file = userAgentRuntimeConfigFile(uid);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = _emptyAgentRuntimeConfig();
    const dirs = raw && typeof raw === 'object' ? (raw as any).project_dirs : null;
    if (dirs && typeof dirs === 'object') {
      for (const [agentId, entry] of Object.entries(dirs)) {
        if (!safeId(agentId) || !entry || typeof entry !== 'object') continue;
        const p = typeof (entry as any).path === 'string' ? (entry as any).path.trim() : '';
        if (!p) continue;
        out.project_dirs[agentId] = {
          path: path.resolve(p),
          ...(typeof (entry as any).updated_at === 'string' ? { updated_at: (entry as any).updated_at } : {}),
        };
      }
    }
    return out;
  } catch {
    return _emptyAgentRuntimeConfig();
  }
}

function _writeAgentRuntimeConfig(uid: string, cfg: AgentRuntimeLocalConfig): void {
  const file = userAgentRuntimeConfigFile(uid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function _deleteAgentRuntimeConfigEntry(uid: string, agentId: string): void {
  const cfg = _readAgentRuntimeConfig(uid);
  if (!Object.prototype.hasOwnProperty.call(cfg.project_dirs, agentId)) return;
  delete cfg.project_dirs[agentId];
  _writeAgentRuntimeConfig(uid, cfg);
}

function _dirExists(dirPath: string): boolean {
  try { return fs.statSync(dirPath).isDirectory(); }
  catch { return false; }
}

/** Resolve the per-agent project directory shown on the detail page and
 *  used to initialise each conversation's coding cwd. Stored overrides are
 *  local-only because absolute paths are machine-specific. Missing config =
 *  effective workspace for the conversation/project scope. */
export function getCliProjectDirInfoForAgent(
  userId: string,
  agent: Pick<Agent, 'agent_id' | 'runtime'>,
  projectId?: string,
): AgentCliProjectDirInfo {
  const workspacePath = getWorkspacePath(userId, projectId);
  const cli = agent.runtime?.kind === 'cli' ? agent.runtime.cli : '';
  const isCoding = cliIsCodingAgent(cli);
  const entry = isCoding ? _readAgentRuntimeConfig(userId).project_dirs[agent.agent_id] : undefined;
  const customPath = entry?.path ? path.resolve(entry.path) : '';
  const customExists = !!customPath && _dirExists(customPath);
  return {
    agent_id: agent.agent_id,
    is_coding: isCoding,
    mode: customPath ? 'custom' : 'workspace',
    path: customPath || workspacePath,
    effective_path: customExists ? customPath : workspacePath,
    workspace_path: workspacePath,
    ...(customPath ? { custom_path: customPath } : {}),
    exists: customPath ? customExists : true,
  };
}

export async function getAgentCliProjectDirInfo(
  userId: string,
  agentId: string,
  projectId?: string,
): Promise<AgentCliProjectDirInfo | null> {
  if (!safeId(agentId)) return null;
  const agent = await getAgent(agentId);
  if (!agent) return null;
  return getCliProjectDirInfoForAgent(userId, agent, projectId);
}

/** Set or clear the detail-page project directory for an external coding
 *  agent. `dirPath=''` clears the override and returns to workspace mode. */
export async function setAgentCliProjectDir(
  userId: string,
  agentId: string,
  dirPath: string,
): Promise<AgentCliProjectDirInfo | null> {
  if (!safeId(agentId)) return null;
  const agent = await getAgent(agentId);
  if (!agent) return null;
  const cli = agent.runtime?.kind === 'cli' ? agent.runtime.cli : '';
  if (!cliIsCodingAgent(cli)) {
    const err: any = new Error('agent is not an external coding agent');
    err.code = 'E_AGENT_NOT_CODING_CLI';
    throw err;
  }

  const cfg = _readAgentRuntimeConfig(userId);
  const trimmed = String(dirPath || '').trim();
  if (!trimmed) {
    delete cfg.project_dirs[agentId];
  } else {
    const resolved = path.resolve(trimmed);
    if (!_dirExists(resolved)) {
      const err: any = new Error(t('errors.dir_not_exists'));
      err.code = 'E_DIR_NOT_EXISTS';
      throw err;
    }
    cfg.project_dirs[agentId] = { path: resolved, updated_at: nowIso() };
  }
  _writeAgentRuntimeConfig(userId, cfg);
  return getCliProjectDirInfoForAgent(userId, agent);
}

interface AgentListCache { stamp: string; data: Agent[] }
let _agentListCache: AgentListCache | null = null;

function _invalidateAgentListCache(opts: { markDirty?: boolean } = {}): void {
  _agentListCache = null;
  if (opts.markDirty === false) return;
  // Notify the sync engine (lazy-require — stripped in the open-source build builds). Every cache-invalidate
  // is also a disk-mutation point, so co-locating the dirty signal here covers all the
  // existing call sites without sprinkling sync calls across the file. The relPath here is
  // informational only — the engine ignores it and walks `cloud/` itself.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = null as { markDirty?: (domain: string, relPath: string) => void };
    sync?.markDirty?.('agents', 'cloud/agents');
  } catch { /* features/sync stripped */ }
}

/** Public re-export of `_invalidateAgentListCache` for cross-module callers (sync engine).
 *  **Why exposed**: `listAgents` caches the disk spec list keyed on the two source dirs'
 *  `mtimeMs`. Local create/update/delete go through this module and call `_invalidateAgentListCache`
 *  inline. But the sync engine writes (and `unlink`s) files directly under `<uid>/cloud/agents/<aid>/`,
 *  which updates the AGENT dir's mtime but NOT the parent (`CUSTOM_AGENTS_DIR`). The parent's
 *  mtime stays unchanged, the cache stamp stays valid, and `listAgents` returns ghosts of the
 *  agents sync just deleted. The sync bridge calls this so the next `listAgents` re-scans. */
export function invalidateAgentListCache(): void {
  _invalidateAgentListCache({ markDirty: false });
}

/** Drop only the in-memory list cache. Marketplace reconcile updates live under
 *  `<uid>/local/marketplace/agents`, not cloud-synced custom agents, so it must not mark the
 *  `agents` sync domain dirty just to make the next list call re-read disk. */
export function clearAgentListCache(): void {
  _invalidateAgentListCache({ markDirty: false });
}

/** Toggle the active user's enabled override for an agent. Wrapping the
 *  raw setter so the IPC handler stays one-line and the per-uid resolution
 *  happens here. The disk-spec cache doesn't need invalidating (enabled is
 *  overlaid outside it), but we no-op'd that explicitly to avoid surprise. */
export function setAgentEnabledForActiveUser(agentId: string, enabled: boolean): void {
  setAgentEnabled(getActiveUserId(), agentId, enabled);
}

function _agentDirStamp(): string {
  let stamp = '';
  for (const d of [CUSTOM_AGENTS_DIR(), userMarketplaceAgentsDir(getActiveUserId())]) {
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
    const sources: Array<[AgentSource, string]> = [['marketplace', userMarketplaceAgentsDir(getActiveUserId())], ['custom', CUSTOM_AGENTS_DIR()]];
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
        if (isMarketplaceSource(source)) {
          // Marketplace-installed agents carry `_install.json` with version + freshness.
          // Author uid may also be present there for install/reconcile compatibility, but the
          // global UI intentionally does not surface it.
          _applyMarketplaceInstallMeta(norm, path.join(dir, e.name));
        }
        if (seen.has(norm.agent_id)) {
          if (source === 'custom') {
            log.warn(`id conflict: marketplace and custom both define "${norm.agent_id}" — marketplace wins, rename one`);
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
  const displaySkillSpecs = await _skillSpecsForDisplay();
  return specs
    .map((a) => ({ ...a, enabled: !disabledAgentIds.has(a.agent_id) }))
    .map((a) => _withDisplaySkillRefs(a, displaySkillSpecs))
    .map((a) => _withAgentMemoryEntries(getActiveUserId(), a))
    .map((a) => _withAgentRuntimeStats(getActiveUserId(), a));
}

/**
 * Look up an agent by id. Marketplace/builtin wins on id collision.
 * Returns normalized agent or null.
 */
export async function getAgent(agentId: string | null | undefined): Promise<Agent | null> {
  if (!agentId) return null;
  for (const source of ['marketplace', 'custom'] as AgentSource[]) {
    const f = isMarketplaceSource(source)
      ? _platformAgentSpecFile(agentId)
      : agentDefinitionFile(getActiveUserId(), agentId);
    if (!fs.existsSync(f)) continue;
    try {
      const data = await readJson<AgentRaw>(f);
      const norm = normalizeAgent(data, source);
      if (norm) {
        if (isMarketplaceSource(source)) {
          _applyMarketplaceInstallMeta(norm, path.dirname(f));
        }
        const { agents: disabledAgentIds } = readDisabledSets(getActiveUserId());
        norm.enabled = !disabledAgentIds.has(norm.agent_id);
        return _withAgentRuntimeStats(
          getActiveUserId(),
          _withAgentMemoryEntries(getActiveUserId(), _withDisplaySkillRefs(norm, await _skillSpecsForDisplay())),
        );
      }
    } catch { /* ignore */ }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Custom CRUD
// ─────────────────────────────────────────────────────────────────────────

/** spec.json path for the active user's custom agent. Platform agents go
 *  through `_platformAgentSpecFile` directly. */
function customAgentFile(agentId: string): string {
  return agentDefinitionFile(getActiveUserId(), agentId);
}

export interface CreateAgentOptions {
  name?: string;
  /** Single-language seed; routed into the current UI language slot. Use
   *  `description_zh` / `description_en` directly only when both languages
   *  are explicitly known. */
  description?: string;
  description_zh?: string;
  description_en?: string;
  workflow?: string;
  icon?: string;
  color?: string;
  interactive?: boolean;
  /** Optional structured display profile. Legacy callers omit this and keep
   *  the old description/workflow-only shape. */
  profile?: AgentProfile;
  knowhow?: string[];
  standards?: string[];
  /** Picked at create time from the modal's runtime selector. Stored as
   *  authored — `normalizeAgent` validates on read. */
  runtime?: AgentRuntime;
  /** Marketplace category code. Empty string / omitted remains tolerated for legacy/manual specs. */
  category?: string;
  /** Output rendering preference picked in the create-modal dropdown. Validated against
   *  `_OUTPUT_FORMAT_VALUES` before persist — unknown values silently drop the field
   *  (= default auto semantics). The modal sends `'auto'` by default; omitted = field
   *  stays unset on disk and is treated as auto at dispatch time. */
  output_format?: OutputFormat;
}

/** Route a single `description` input into the current UI language slot.
 *  Explicit `description_zh` / `description_en` always win. Returns the
 *  pair of resolved values (already trimmed; `''` when nothing to set). */
function resolveBilingualDescription(
  legacy: string | undefined,
  zh: string | undefined,
  en: string | undefined,
): { description_zh: string; description_en: string } {
  const l = (legacy || '').trim();
  const z = (zh || '').trim();
  const e = (en || '').trim();
  const lang = descriptionLang(getLanguage());
  return {
    description_zh: z || (l && lang === 'zh' ? l : ''),
    description_en: e || (l && lang !== 'zh' ? l : ''),
  };
}

async function _skillSpecsForDisplay(): Promise<SkillAllowlistRef[]> {
  try { return await listSkillSpecsForAgentMetadata(getActiveUserId()); }
  catch (err) {
    log.warn(`skill display-name map unavailable: ${(err as Error).message}`);
    return [];
  }
}

async function _normalizeWorkflowSkillIds(workflow: string): Promise<string> {
  const text = String(workflow || '');
  if (!text) return text;
  return normalizeKnownSkillRefsForDisplay(text, await _skillSpecsForDisplay());
}

function _withDisplaySkillRefs(agent: Agent, specs: SkillAllowlistRef[]): Agent {
  const workflow = normalizeKnownSkillRefsForDisplay(agent.workflow || '', specs);
  return workflow === agent.workflow ? agent : { ...agent, workflow };
}

function _withAgentMemoryEntries(userId: string, agent: Agent): Agent {
  if (!agent.agent_id) return agent;
  if (isCliAgent(agent)) return agent;
  const res = listAgentEntries(userId, agent.agent_id);
  const fileEntries = res.entries || [];
  if (!fileEntries.length) return agent;
  const existing = agent.profile?.memory || [];
  const seen = new Set(existing.map((entry) => (entry.title || entry.description || '').trim()).filter(Boolean));
  const memory = [...existing];
  for (const text of fileEntries) {
    const trimmed = String(text || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    memory.push({ title: trimmed, source: 'agent_memory' });
  }
  return {
    ...agent,
    profile: {
      ...(agent.profile || {}),
      memory,
    },
  };
}

function _agentMemoryUnsupportedResult(error: string) {
  return { ok: false, error, entries: [], usage: { current: 0, limit: 0, entries_current: 0, entries_limit: 0 } };
}

function _agentMemoryNotSupportedForExternalResult() {
  return _agentMemoryUnsupportedResult('agent memory is not supported for external CLI agents');
}

async function _resolveAgentMemoryTarget(agentId: string): Promise<{
  source: AgentSource;
  file: string;
  data: AgentRaw;
} | null> {
  for (const source of ['marketplace', 'custom'] as AgentSource[]) {
    const file = isMarketplaceSource(source)
      ? _platformAgentSpecFile(agentId)
      : customAgentFile(agentId);
    if (!fs.existsSync(file)) continue;
    try {
      const data = await readJson<AgentRaw>(file);
      const norm = normalizeAgent(data, source);
      if (norm?.agent_id === agentId) return { source, file, data };
    } catch {
      /* try the next source */
    }
  }
  return null;
}

function _readAgentRuntimeStats(userId: string, agentId: string): AgentRuntimeStats | undefined {
  if (!safeId(agentId)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(agentRuntimeStatsFile(userId, agentId), 'utf8'));
    return normalizeAgentRuntimeStats(raw);
  } catch {
    return undefined;
  }
}

function _withAgentRuntimeStats(userId: string, agent: Agent): Agent {
  const runtimeStats = _readAgentRuntimeStats(userId, agent.agent_id);
  return runtimeStats ? { ...agent, runtime_stats: runtimeStats } : agent;
}

function bumpAgentSpecRevision(data: AgentRaw): void {
  data._v = (Number(data._v) || 0) + 1;
}

/**
 * Create a custom agent. The call shape keeps historical optional fields, but
 * the quality gate requires a usable name plus at least one description variant
 * before the spec is written.
 */
export async function createCustomAgent(
  { name = '', description = '', description_zh, description_en, workflow = '', icon, color, interactive, profile, knowhow, standards, runtime, category, output_format }: CreateAgentOptions = {},
): Promise<Agent | null> {
  assertAgentNameAllowed(name);
  await assertAgentNameUnique(String(name || '').trim());
  fs.mkdirSync(CUSTOM_AGENTS_DIR(), { recursive: true });
  let agentId: string;
  do { agentId = genAgentId(); }
  while (fs.existsSync(_platformAgentSpecFile(agentId))
      || fs.existsSync(customAgentFile(agentId)));
  // mkdir <aid>/ first so writeJson on agent.json has a parent.
  fs.mkdirSync(agentDir(getActiveUserId(), agentId), { recursive: true });
  const desc = resolveBilingualDescription(description, description_zh, description_en);
  const normalizedWorkflow = await _normalizeWorkflowSkillIds(String(workflow || ''));
  const data: AgentRaw = {
    agent_id: agentId,
    name: String(name || '').trim() || t('agent.default_name'),
    description_zh: desc.description_zh,
    description_en: desc.description_en,
    workflow: normalizedWorkflow,
    created_at: nowIso(),
    updated_at: nowIso(),
    _v: 1,
    status: 'approved',
  };
  // Only emit `category` to disk when supplied; empty string is omitted so existing agents
  // don't get spurious "category: ''" lines through resave. Candidate membership is dynamic,
  // so this layer only normalizes the code shape.
  const cleanCategory = typeof category === 'string' && category.trim()
    ? normalizeMarketplaceCategoryCode(category)
    : '';
  if (cleanCategory) data.category = cleanCategory;
  if (avatars.isKnownIcon(icon)) data.icon = icon;
  if (avatars.isKnownColor(color)) data.color = color;
  if (typeof interactive === 'boolean') data.interactive = interactive;
  const cleanProfile = normalizeAgentProfile({ profile, knowhow, standards });
  if (cleanProfile?.knowhow) data.knowhow = cleanProfile.knowhow;
  if (cleanProfile?.standards) data.standards = cleanProfile.standards;
  // Persist `output_format` only when the caller supplied a non-auto value the
  // enum recognizes. Auto is the implicit default, so leaving it off keeps
  // agent specs clean while dispatch still injects automatic layout rules.
  const cleanOutputFormat = _canonicalOutputFormat(output_format);
  if (cleanOutputFormat && cleanOutputFormat !== 'auto') {
    data.output_format = cleanOutputFormat;
  }
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
      data.inputs = [_buildProjectDirInput()];
    }
  }
  // Quality validation gate. EXTREME findings (missing required fields / red
  // flags in workflow text / etc.) block the write; MEDIUM warnings pass
  // through but are persisted for UI surfacing. Persist runs in both branches
  // so the latest report on disk always matches the most recent intent.
  const report = validateAgentSpec({ agentJson: data });
  void persistQualityReport({
    uid: getActiveUserId(), kind: 'agent', id: agentId, report,
  });
  if (!report.ok) {
    // Roll back the freshly-mkdir'd directory so a rejected create doesn't
    // leave behind an empty <aid>/ that would later confuse `listAgents`.
    try { fs.rmSync(agentDir(getActiveUserId(), agentId), { recursive: true, force: true }); }
    catch { /* tolerate cleanup failure */ }
    throw new Error(_validationErrorMessage(report));
  }

  await writeJson(customAgentFile(agentId), data);
  _invalidateAgentListCache();
  log.info(`created id=${agentId} name=${data.name}`);
  return normalizeAgent(data, 'custom');
}

/** Build a single-line error message from a failed report. Used to surface
 *  validation rejection up the create/update path's existing throw flow. */
function _validationErrorMessage(report: QualityReport): string {
  const top = report.violations.find((v) => v.level === 'EXTREME');
  if (!top) return 'validation failed';
  return `validation failed (${top.rule}): ${top.suggested_fix}`;
}

/** Required-input schema injected on every external coding agent. The
 *  field id `project_dir` is a contract — the dispatch path looks for
 *  exactly this id when extracting the cwd from a form submission.
 *  Built at injection time so the persisted `label` follows the user's
 *  current UI language (single-language per agent.json — bilingual lives
 *  only in the locale table, not in the persisted schema). */
export const PROJECT_DIR_INPUT_ID = 'project_dir';
function _buildProjectDirInput(): AgentInput {
  return {
    id: PROJECT_DIR_INPUT_ID,
    type: 'directory',
    label: t('agent.cli.project_dir.label'),
    required: true,
    default: '',
  };
}

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
   *   null  → drop the dependency metadata
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
  /** Legacy compatibility input:
   *   object → extract knowhow / standards into top-level fields
   *   null   → drop legacy profile plus top-level knowhow / standards
   *   omitted → untouched */
  profile?: AgentProfile | null;
  /** Three-way update for display capabilities. Stored as top-level agent.json
   *  fields; `profile` is only a legacy compatibility input. */
  knowhow?: string[] | null;
  standards?: string[] | null;
  /** Three-way update:
   *   AgentRuntime → replace (validated; in_process collapses to "drop")
   *   null         → drop runtime (revert to in_process default)
   *   omitted      → untouched
   *  Authored by the create modal + edit UI, not the LLM edit prompt. */
  runtime?: AgentRuntime | null;
  /** Marketplace category code. Empty string drops the field; omitted = untouched.
   *  Authored by hidden create defaults or by the agent-edit LLM via the `<category>` sub-tag.
   *  Missing model output is repaired to the default category on create. */
  category?: string;
  /** Three-way update:
   *   array (possibly empty) → replace (filtered to non-empty strings)
   *   null  → drop the field
   *   omitted → untouched
   *  UI/compatibility metadata authored by the agent edit UI, NOT the
   *  agent-edit LLM. */
  enabled_connectors?: string[] | null;
  /** Three-way update:
   *   OutputFormat string → set (one of the constrained enum values)
   *   null                 → drop (revert to default 'auto')
   *   omitted              → untouched
   *  Authored by the agent edit UI dropdown. */
  output_format?: OutputFormat | null;
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
  await _applyAgentUpdates(data, agentId, updates);

  // Quality gate (same policy as createCustomAgent): EXTREME blocks the
  // write so the on-disk spec doesn't regress; MEDIUM persists but writes
  // through.
  const report = validateAgentSpec({ agentJson: data });
  void persistQualityReport({
    uid: getActiveUserId(), kind: 'agent', id: agentId, report,
  });
  if (!report.ok) {
    throw new Error(_validationErrorMessage(report));
  }

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

/** Pure mutator: apply `updates` onto a raw agent spec object. Shared by
 *  `updateCustomAgent` and the dev-mode built-in update path so the field
 *  semantics stay identical regardless of source. Throws on reserved-name
 *  collision (matches existing custom behavior). */
function _stripEmbeddedProfileKeys(data: AgentRaw, keys: string[]): void {
  const embedded = _plainObj(data.profile);
  if (!embedded) return;
  let changed = false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(embedded, key)) {
      delete embedded[key];
      changed = true;
    }
  }
  if (!changed) return;
  if (Object.keys(embedded).length) data.profile = embedded;
  else delete data.profile;
}

function _setAgentTextListField(
  data: AgentRaw,
  key: 'knowhow' | 'standards',
  value: string[] | null | undefined,
): void {
  _stripEmbeddedProfileKeys(data, [key]);
  if (value === null) {
    delete (data as Record<string, unknown>)[key];
    return;
  }
  if (Array.isArray(value)) {
    const clean = _profileTextList(value, 16);
    if (clean) (data as Record<string, unknown>)[key] = clean;
    else delete (data as Record<string, unknown>)[key];
  }
}

function _applyLegacyProfileUpdate(data: AgentRaw, value: AgentProfile | null | undefined): void {
  _stripEmbeddedProfileKeys(data, ['knowhow', 'standards', 'workflow', 'flow', 'workflow_steps', 'memory']);
  if (value === null) {
    delete data.profile;
    delete (data as Record<string, unknown>).knowhow;
    delete (data as Record<string, unknown>).standards;
    return;
  }
  const cleanProfile = normalizeAgentProfile({ profile: value });
  if (cleanProfile?.knowhow) data.knowhow = cleanProfile.knowhow;
  else delete data.knowhow;
  if (cleanProfile?.standards) data.standards = cleanProfile.standards;
  else delete data.standards;
}

async function _applyAgentUpdates(
  data: AgentRaw, agentId: string, updates: UpdateAgentFields,
): Promise<void> {
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
    if ('profile' in (updates || {})) delete (updates as any).profile;
    if ('knowhow' in (updates || {})) delete (updates as any).knowhow;
    if ('standards' in (updates || {})) delete (updates as any).standards;
  }
  for (const k of ['name', 'workflow'] as const) {
    if (Object.prototype.hasOwnProperty.call(updates || {}, k)) {
      const v = (updates as any)[k];
      const next = typeof v === 'string' ? v : '';
      (data as any)[k] = k === 'workflow' ? await _normalizeWorkflowSkillIds(next) : next;
    }
  }
  // First migrate any persisted legacy `description` into the bilingual pair
  // (lossless, content-based for historical data). Then apply incoming
  // updates: explicit `description_zh` / `description_en` write through;
  // single `description` routes to the current UI language slot unless that
  // slot was explicitly set this turn.
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
        const lang = descriptionLang(getLanguage());
        if (lang === 'zh' && !hasZh) data.description_zh = legacy;
        if (lang !== 'zh' && !hasEn) data.description_en = legacy;
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
      // Scope metadata to this agent while preserving enabled external-package
      // refs, so another agent's private (`ownerAgent`) skill resolves as
      // unknown and gets dropped.
      const specs = await listSkillSpecsForAgentMetadata(getActiveUserId(), { forAgentId: agentId });
      const { ids, unknown } = resolveSkillAllowlistRefs(specs, raw);
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
  if (Object.prototype.hasOwnProperty.call(updates || {}, 'enabled_connectors')) {
    const v = (updates as { enabled_connectors?: string[] | null }).enabled_connectors;
    if (v === null) {
      delete (data as { enabled_connectors?: unknown }).enabled_connectors;
    } else if (Array.isArray(v)) {
      const ids = v
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && safeId(s));
      (data as { enabled_connectors?: string[] }).enabled_connectors = ids;
    }
  }
  if (Object.prototype.hasOwnProperty.call(updates || {}, 'output_format')) {
    const v = (updates as { output_format?: OutputFormat | null }).output_format;
    const clean = _canonicalOutputFormat(v);
    if (v === null || clean === 'auto') {
      // 'auto' is the implicit default; don't write it to disk so spec
      // diffs stay clean and unset agents don't suddenly get a field.
      delete (data as { output_format?: unknown }).output_format;
    } else if (clean) {
      (data as { output_format?: OutputFormat }).output_format = clean;
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
  if (Object.prototype.hasOwnProperty.call(updates || {}, 'profile')) {
    _applyLegacyProfileUpdate(data, updates.profile);
  }
  if (Object.prototype.hasOwnProperty.call(updates || {}, 'knowhow')) {
    _setAgentTextListField(data, 'knowhow', updates.knowhow);
  }
  if (Object.prototype.hasOwnProperty.call(updates || {}, 'standards')) {
    _setAgentTextListField(data, 'standards', updates.standards);
  }
  // category: explicit empty-string drops the field; any non-empty string is normalized to a
  // safe code shape. Candidate membership is prompt-time dynamic, not a static backend list.
  if (Object.prototype.hasOwnProperty.call(updates || {}, 'category')) {
    const v = (updates as any).category;
    const trimmed = typeof v === 'string' ? v.trim() : '';
    if (!trimmed) delete (data as any).category;
    else (data as any).category = normalizeMarketplaceCategoryCode(trimmed);
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
    if (wantsProjectDir) data.inputs = [_buildProjectDirInput(), ...without];
    else if (without.length) data.inputs = without;
    else delete data.inputs;
  }
  if (!data.name) data.name = t('agent.default_name');
  bumpAgentSpecRevision(data);
  data.updated_at = nowIso();
}

/** Edit-chat dispatcher: routes to custom write for custom agents, and to
 *  the dev-only built-in dual-write (src + data) for built-in agents in
 *  dev mode. Returns null if the id resolves to neither, or if a built-in
 *  write is attempted outside dev mode. */
export async function updateAgentSpec(
  agentId: string, updates: UpdateAgentFields,
): Promise<Agent | null> {
  if (!agentId) return null;
  if (fs.existsSync(customAgentFile(agentId))) {
    return updateCustomAgent(agentId, updates);
  }
  if (fs.existsSync(_platformAgentSpecFile(agentId))) {
    return null;
  }
  return null;
}

/** True iff `agentId` resolves to a built-in spec (the runtime data tree).
 *  Mirrors `isBuiltinSkill`. */
export function isBuiltinAgent(agentId: string): boolean {
  if (!agentId) return false;
  return fs.existsSync(_platformAgentSpecFile(agentId));
}

/** Internal: shared apply + cache invalidation for the dev module. */
export async function _applyAgentUpdatesAndInvalidate(
  data: AgentRaw, agentId: string, updates: UpdateAgentFields,
): Promise<Agent | null> {
  await _applyAgentUpdates(data, agentId, updates);
  _invalidateAgentListCache();
  return normalizeAgent(data, 'marketplace');
}

/**
 * Append a single learned skill id to the agent's skill_list metadata. Skips
 * the unknown-id filter `updateCustomAgent` does — System B (self-evolution
 * `SkillStore`) skills live in a different directory from System A
 * (`SkillLoader`) and would be dropped.
 *
 * No-op when:
 *   - agent missing / is builtin
 *   - agent.skill_list is undefined (no explicit dependency list to extend)
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
  bumpAgentSpecRevision(data);
  data.updated_at = nowIso();
  await writeJson(f, data);
  _invalidateAgentListCache();
  log.info(`appended skill "${skillId}" to agent ${agentId}.skill_list`);
  return true;
}

export async function addCustomAgentMemory(agentId: string, content: string) {
  if (!agentId || !safeId(agentId)) return { ok: false, error: 'invalid agent_id', entries: [], usage: { current: 0, limit: 0 } };
  const target = await _resolveAgentMemoryTarget(agentId);
  if (!target) return { ok: false, error: 'agent not found or read-only', entries: [], usage: { current: 0, limit: 0 } };
  if (_normalizeRuntime(target.data.runtime)?.kind === 'cli') return _agentMemoryNotSupportedForExternalResult();
  const res = addAgentEntry(getActiveUserId(), agentId, content);
  if (res.ok) _invalidateAgentListCache();
  return res;
}

export async function removeCustomAgentMemory(agentId: string, oldText: string) {
  if (!agentId || !safeId(agentId)) return { ok: false, error: 'invalid agent_id', entries: [], usage: { current: 0, limit: 0 } };
  const target = await _resolveAgentMemoryTarget(agentId);
  if (!target) return { ok: false, error: 'agent not found or read-only', entries: [], usage: { current: 0, limit: 0 } };
  if (_normalizeRuntime(target.data.runtime)?.kind === 'cli') return _agentMemoryNotSupportedForExternalResult();

  const fileRes = removeAgentEntry(getActiveUserId(), agentId, oldText);
  if (fileRes.ok) {
    _invalidateAgentListCache();
    return fileRes;
  }
  if (target.source !== 'custom') return fileRes;

  const data = target.data;
  const profile = normalizeAgentProfile(data);
  const memory = profile?.memory || [];
  const needle = String(oldText || '').trim();
  const nextMemory = memory.filter((entry) => {
    const text = `${entry.title || ''}\n${entry.description || ''}`.trim();
    return !needle || !text.includes(needle);
  });
  if (nextMemory.length === memory.length) return fileRes;

  const rawProfile = _plainObj((data as any).profile) || {};
  if (nextMemory.length) {
    (data as any).profile = { ...rawProfile, memory: nextMemory };
  } else {
    const { memory: _removed, ...rest } = rawProfile;
    if (Object.keys(rest).length) (data as any).profile = rest;
    else delete (data as any).profile;
  }
  bumpAgentSpecRevision(data);
  data.updated_at = nowIso();
  await writeJson(target.file, data);
  _invalidateAgentListCache();
  return listAgentEntries(getActiveUserId(), agentId);
}

export async function updateCustomAgentMemory(agentId: string, oldText: string, content: string) {
  if (!agentId || !safeId(agentId)) return { ok: false, error: 'invalid agent_id', entries: [], usage: { current: 0, limit: 0 } };
  const target = await _resolveAgentMemoryTarget(agentId);
  if (!target) return { ok: false, error: 'agent not found or read-only', entries: [], usage: { current: 0, limit: 0 } };
  if (_normalizeRuntime(target.data.runtime)?.kind === 'cli') return _agentMemoryNotSupportedForExternalResult();
  const res = replaceAgentEntry(getActiveUserId(), agentId, oldText, content);
  if (res.ok) _invalidateAgentListCache();
  return res;
}

export async function recordAgentRuntimeStats(
  agentId: string,
  result: { duration_ms?: unknown; durationMs?: unknown; success?: unknown; aborted?: unknown; errored?: unknown; status?: unknown } = {},
): Promise<{ ok: boolean; error?: string; stats?: AgentRuntimeStats }> {
  if (!agentId || !safeId(agentId)) return { ok: false, error: 'invalid agent_id' };
  const agent = await getAgent(agentId);
  if (!agent) return { ok: false, error: 'agent not found' };

  const userId = getActiveUserId();
  const raw = await readJson(agentRuntimeStatsFile(userId, agentId));
  const device = getCurrentDevice();
  const statsFile = recordAgentRuntimeStatsForDevice(raw, device.id || device.name, result, nowIso());
  await writeJson(agentRuntimeStatsFile(userId, agentId), statsFile);
  _invalidateAgentListCache();
  return { ok: true, stats: normalizeAgentRuntimeStats(statsFile) };
}

export async function deleteCustomAgent(agentId: string): Promise<boolean> {
  if (!agentId) return false;
  const dir = agentDir(getActiveUserId(), agentId);
  if (!fs.existsSync(dir)) return false;
  // Wipe the whole `agents/<aid>/` directory in one shot — agent.json,
  // meta/, and skills/ all live inside it, so we no longer need separate
  // cascades for metacognition.purgeAgent / SkillStore.delete.
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
      const sessionId = defaultAgentEditSessionId(agentId);
      try { evictSession(sessionId); } catch { /* cache may not hold it */ }
      const sessionJsonl = userSessionFile(uid, sessionId);
      try { await fsp.unlink(sessionJsonl); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(`session unlink user=${uid} agent=${agentId}: ${(err as Error).message}`);
        }
      }
      try { _deleteAgentRuntimeConfigEntry(uid, agentId); }
      catch (err) { log.warn(`runtime config cleanup user=${uid} agent=${agentId}: ${(err as Error).message}`); }
    }
  }

  // Metacognition + evolved skills are already wiped by the
  // `rm -rf agents/<aid>/` above — meta / skills sub-directories live
  // inside that tree. No separate purge is needed.

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
// quick-create; see the "Create agent" section of
// `chat_agent_setup.md` / `chat_commander.md`.
const AGENT_CHILD_RE = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);

const AGENT_CATEGORY_CODE_RE = /^[a-z][a-z0-9_-]{0,79}$/;

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
  /** Parsed from independent `<knowhow>` / `<standards>` line lists.
   *  JSON arrays and legacy `<profile>` remain accepted for compatibility. */
  knowhow?: string[];
  standards?: string[];
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
  /** Parsed from `<category>` inside `<agent>`. Candidate membership is
   *  prompt-time dynamic; parsing only enforces a safe code shape. */
  category?: string;
}

function _parseAgentBlock(inner: string): ExtractedFields {
  const fields: ExtractedFields = {};
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
  const profileM = inner.match(AGENT_CHILD_RE('profile'));
  if (profileM) {
    const trimmed = profileM[1].trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        const profile = normalizeAgentProfile({ profile: parsed });
        if (profile?.knowhow) fields.knowhow = profile.knowhow;
        if (profile?.standards) fields.standards = profile.standards;
      } catch (err) {
        log.warn(`<profile> JSON parse failed: ${(err as Error).message}`);
      }
    }
  }
  const parseTextListBody = (body: string, tag: 'knowhow' | 'standards'): string[] | undefined => {
    const trimmed = body.trim();
    if (trimmed === '' || trimmed === '[]') return [];
    if (/^[\[{]/.test(trimmed)) {
      try {
        return _profileTextList(JSON.parse(trimmed), 16);
      } catch (err) {
        log.warn(`<${tag}> JSON parse failed: ${(err as Error).message}`);
        return undefined;
      }
    }
    const out: string[] = [];
    const seen = new Set<string>();
    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '');
      const text = _cleanProfileString(line, 220);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(text);
      if (out.length >= 16) break;
    }
    return out.length ? out : undefined;
  };

  const knowhowM = inner.match(AGENT_CHILD_RE('knowhow'));
  if (knowhowM) {
    const knowhow = parseTextListBody(knowhowM[1], 'knowhow');
    if (knowhow) fields.knowhow = knowhow;
    else if (knowhowM[1].trim() === '' || knowhowM[1].trim() === '[]') fields.knowhow = [];
  }
  const standardsM = inner.match(AGENT_CHILD_RE('standards'));
  if (standardsM) {
    const standards = parseTextListBody(standardsM[1], 'standards');
    if (standards) fields.standards = standards;
    else if (standardsM[1].trim() === '' || standardsM[1].trim() === '[]') fields.standards = [];
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
  const catM = inner.match(AGENT_CHILD_RE('category'));
  if (catM) {
    const v = catM[1].trim().toLowerCase();
    if (AGENT_CATEGORY_CODE_RE.test(v)) fields.category = v;
  }
  return fields;
}

/**
 * Extract every `<agent>...</agent>` container in emission order. Each
 * block is parsed independently; a malformed sub-tag in one block does
 * not affect the others. Returns `blocks: []` when no container exists.
 */
export function extractAgentFieldBlocks(
  text: string,
): { cleanText: string; blocks: ExtractedFields[] } {
  if (!text || text.indexOf('<agent') < 0) return { cleanText: text, blocks: [] };
  const ranges = findOuterTagRanges(text, 'agent');
  if (!ranges.length) return { cleanText: text, blocks: [] };
  const blocks: ExtractedFields[] = [];
  let cleaned = '';
  let cursor = 0;
  for (const [s, e] of ranges) {
    cleaned += text.slice(cursor, s);
    const block = text.slice(s, e);
    if (block.endsWith('</agent>')) {
      const openEnd = block.indexOf('>');
      if (openEnd >= 0) {
        const inner = block.slice(openEnd + 1, block.length - '</agent>'.length);
        blocks.push(_parseAgentBlock(inner));
      }
    }
    cursor = e;
  }
  cleaned += text.slice(cursor);
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText: cleaned, blocks };
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

function defaultAgentEditSessionId(agentId: string): string {
  return `agent-${agentId}`;
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
  // Custom agents always allow clearing; built-in chat dirs only exist when
  // dev mode has been editing them — allow clearing those too.
  if (!agent) return false;
  if (agent.source !== 'custom' && !false) return false;
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
  const sessionId = defaultAgentEditSessionId(agentId);
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
 * Includes knowhow / standards / inputs / skill metadata so the editor can
 * preserve and complete the richer agent structure.
 */
export function buildAgentEditSystemPrompt(agent: {
  name?: string;
  /** Legacy single-language seed; auto-routed via Chinese-character heuristic. */
  description?: string;
  description_zh?: string;
  description_en?: string;
  workflow?: string;
  skill_list?: string[];
  inputs?: AgentInput[];
  profile?: AgentProfile;
  knowhow?: string[];
  standards?: string[];
  category?: string;
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
  const profile = normalizeAgentProfile({
    profile: agent.profile,
    knowhow: agent.knowhow,
    standards: agent.standards,
  });
  const knowhowText = profile?.knowhow?.length ? profile.knowhow.join('\n') : '(not provided)';
  const standardsText = profile?.standards?.length ? profile.standards.join('\n') : '(not provided)';
  const inputsJson = Array.isArray(agent.inputs) ? JSON.stringify(agent.inputs, null, 2) : '(not provided)';
  const skillsText = Array.isArray(agent.skill_list) ? agent.skill_list.join('\n') : '(not provided)';
  const body = isCli
    ? prompts.load('chat_agent_setup_cli', {
        // Runtime cli + model are deliberately NOT passed: the LLM is
        // told to stay CLI-agnostic in the description, and surfacing
        // the current binding tempts it to name the CLI inline (which
        // forbiddenly bakes a brand into the description).
        name: agent.name || '',
        description_zh: zh || '(not provided)',
        description_en: en || '(not provided)',
        inputs_json: inputsJson,
        category: agent.category || '(not provided)',
        interactive: agent.interactive === true ? 'true' : 'false',
      })
    : prompts.load('chat_agent_setup', {
        name: agent.name || '',
        description: display || '(not provided)',
        description_zh: zh || '(not provided)',
        description_en: en || '(not provided)',
        workflow: (agent.workflow || '').trim() || '(not provided)',
        skills: skillsText || '(not provided)',
        inputs_json: inputsJson,
        knowhow_text: knowhowText,
        standards_text: standardsText,
        category: agent.category || '(not provided)',
        interactive: agent.interactive === true ? 'true' : 'false',
      });
  const tail = buildLanguageDirective(getLanguage());
  return `${body}\n\n---\n\n${tail}\n\n---\n\n${buildRuntimeDatetimeBlock()}`;
}

export interface AgentEditResult {
  ok: boolean;
  message?: string;
  error?: string;
  updated?: ExtractedFields;
}

function agentEditAttachmentCid(agentId: string): string {
  return `agent-edit-${agentId}`;
}

async function buildAgentEditMessageWithAttachments(
  userId: string,
  agentId: string,
  content: string,
  attachments?: string[],
): Promise<{
  message: string;
  images: Array<{ data: string; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }>;
  attachmentNames: string[];
  attachmentCid: string;
  attachmentMetadata: { hasAttachments: boolean; attachmentTypes: string[] };
}> {
  const attachmentNames = Array.isArray(attachments)
    ? attachments.filter((n): n is string => typeof n === 'string' && !!n.trim())
    : [];
  const attachmentCid = agentEditAttachmentCid(agentId);
  if (!attachmentNames.length) {
    return {
      message: content,
      images: [],
      attachmentNames,
      attachmentCid,
      attachmentMetadata: { hasAttachments: false, attachmentTypes: [] },
    };
  }
  const { manifest, images, metadata } = await buildAttachmentManifest(userId, attachmentCid, attachmentNames);
  return {
    message: manifest ? `${manifest}\n${content}` : content,
    images,
    attachmentNames,
    attachmentCid,
    attachmentMetadata: metadata,
  };
}

function _trimText(raw: unknown, max = 2000): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s.length > max ? s.slice(0, max) : s;
}

function _clampLimit(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function buildAgentEditSkillSearchTool(uid: string): AgentTool {
  return {
    name: 'skill_search',
    description: [
      'Find skills contributed by the user\'s global skill folders when the listed skills do not cover the agent being authored.',
      'Returns each match\'s name, source, and SKILL.md path; read_file that path before referencing the skill in an agent workflow.',
      'Matching is keyword-based over names + descriptions, which may be English — if a user-language query returns nothing, retry once with English keywords before concluding none exist.',
      'This does NOT search the marketplace catalog and installs nothing.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Capability text matched against skill names and descriptions. Leave empty to list available global skills. Use the user language when possible.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (1-20). Default: 8.',
        },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const query = _trimText(input?.query, 300);
      const limit = _clampLimit(input?.limit, 8, 1, 20);
      try {
        const { skills: disabledSkillIds } = readDisabledSets(uid);
        const res = await searchOpenTierSkills(uid, query, limit, disabledSkillIds);
        return { content: JSON.stringify({ ok: true, query, ...res }) };
      } catch (err) {
        return { content: JSON.stringify({ ok: false, error: (err as Error).message || 'skill search failed' }), isError: true };
      }
    },
  };
}

function agentEditExtraTools(userId: string): AgentTool[] {
  return [buildAgentEditSkillSearchTool(userId)];
}

function agentEditReadOnlyRoots(userId: string, attachmentCid?: string): string[] {
  const roots = [
    userMarketplaceSkillsDir(userId),
    userSkillsDir(userId),
  ];
  try {
    roots.push(...openSkillReadRoots(userId));
  } catch (err) {
    log.warn(`agent edit open skill read roots unavailable: ${(err as Error).message}`);
  }
  if (attachmentCid) roots.push(chatAttachmentDir(userId, attachmentCid));
  return roots;
}

export async function sendToAgentEditChat(
  userId: string,
  agentId: string,
  content: string,
  opts: { attachments?: string[]; modelText?: string } = {},
): Promise<AgentEditResult> {
  const agent = await getAgent(agentId);
  if (!agent) return { ok: false, error: 'agent not found' };
  if (agent.source !== 'custom' && !false) {
    return { ok: false, error: t('errors.builtin_agent_not_editable') };
  }

  const meta = await loadAgentChatMeta(userId, agentId);
  const sessionId = meta.session_id || defaultAgentEditSessionId(agentId);

  const systemPrompt = buildAgentEditSystemPrompt(agent);
  const modelText = typeof opts.modelText === 'string' ? opts.modelText.trim() : '';
  const modelContent = modelText || content;
  const attachmentCtx = await buildAgentEditMessageWithAttachments(userId, agentId, modelContent, opts.attachments);
  const readOnlyRoots = agentEditReadOnlyRoots(
    userId,
    attachmentCtx.attachmentNames.length ? attachmentCtx.attachmentCid : undefined,
  );

  await _appendAgentChatMessage(userId, agentId,
    {
      time: nowIso(), role: 'user', content,
      ...(modelText ? { model_text: modelText } : {}),
      ...(attachmentCtx.attachmentNames.length ? { attachments: attachmentCtx.attachmentNames, attachment_cid: attachmentCtx.attachmentCid } : {}),
    });

  const { chatWithModel } = require('../model/client');
  // Read-only access to the builtin skills root so the LLM can `read_file`
  // the `agent-creator` skill (the canonical authoring rules pointer in
  // `chat_agent_setup.md`). No write side — every mutation goes through
  // the `<agent>` container parser post-stream.
  const result = await chatWithModel({
    userId, message: attachmentCtx.message, sessionId, systemPrompt,
    agentName: 'orkas_chat', timeout: 300,
    readOnlyExtraRoots: readOnlyRoots,
    extraTools: agentEditExtraTools(userId),
    attachmentMetadata: attachmentCtx.attachmentMetadata,
    ...(attachmentCtx.attachmentNames.length ? { images: attachmentCtx.images } : {}),
  });

  if (!result.ok) {
    const errMsg = `Model response failed: ${result.error || 'unknown'}`;
    await _appendAgentChatMessage(userId, agentId,
      { time: nowIso(), role: 'assistant', content: errMsg });
    return { ok: false, message: errMsg, error: result.error || '' };
  }

  const { cleanText, blocks } = extractAgentFieldBlocks(result.text);
  // Inline edit chat is bound to one agent; apply only the first block.
  const fields = blocks[0] || {};
  const updated: ExtractedFields = {};
  if (Object.keys(fields).length) {
    await updateAgentSpec(agentId, fields);
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
  opts: { abortSignal?: AbortSignal; attachments?: string[]; modelText?: string } = {},
): AsyncGenerator<any, void, unknown> {
  const agent = await getAgent(agentId);
  if (!agent) {
    yield { type: 'error', text: 'agent not found' };
    yield { type: 'done' };
    return;
  }
  if (agent.source !== 'custom' && !false) {
    yield { type: 'error', text: t('errors.builtin_agent_not_editable') };
    yield { type: 'done' };
    return;
  }

  const meta = await loadAgentChatMeta(userId, agentId);
  const sessionId = meta.session_id || defaultAgentEditSessionId(agentId);

  const systemPrompt = buildAgentEditSystemPrompt(agent);
  const modelText = typeof opts.modelText === 'string' ? opts.modelText.trim() : '';
  const modelContent = modelText || content;
  const attachmentCtx = await buildAgentEditMessageWithAttachments(userId, agentId, modelContent, opts.attachments);
  const readOnlyRoots = agentEditReadOnlyRoots(
    userId,
    attachmentCtx.attachmentNames.length ? attachmentCtx.attachmentCid : undefined,
  );

  await _appendAgentChatMessage(userId, agentId,
    {
      time: nowIso(), role: 'user', content,
      ...(modelText ? { model_text: modelText } : {}),
      ...(attachmentCtx.attachmentNames.length ? { attachments: attachmentCtx.attachmentNames, attachment_cid: attachmentCtx.attachmentCid } : {}),
    });

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
      userId, message: attachmentCtx.message, sessionId, systemPrompt,
      agentName: 'orkas_chat',
      cacheRetention: 'short',
      readOnlyExtraRoots: readOnlyRoots,
      extraTools: agentEditExtraTools(userId),
      attachmentMetadata: attachmentCtx.attachmentMetadata,
      ...(attachmentCtx.images.length ? { images: attachmentCtx.images } : {}),
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
        const { cleanText, blocks } = extractAgentFieldBlocks(raw);
        // Inline edit chat is bound to one agent; apply only the first block.
        const fields = blocks[0] || {};
        if (Object.keys(fields).length) {
          await updateAgentSpec(agentId, fields);
          Object.assign(updated, fields);
          for (const k of ['name', 'workflow', 'category'] as const) {
            if (fields[k] !== undefined) {
              synthesizedProgress.push(t('process.agent.update_field', { field: k }));
            }
          }
          if (fields.knowhow !== undefined) {
            synthesizedProgress.push(t('process.agent.update_field', { field: 'knowhow' }));
          }
          if (fields.standards !== undefined) {
            synthesizedProgress.push(t('process.agent.update_field', { field: 'standards' }));
          }
          // Collapse description / description_zh / description_en into one
          // user-facing progress event — the user sees "description updated"
          // regardless of which language slot the LLM filled this turn.
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
        errMsg = `Model response failed: ${event.text || 'unknown'}`;
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
    errMsg = `Model response failed: ${msg}`;
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
          ? `${streamingText}\n\n(reply interrupted)`
          : '(reply interrupted)';
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
  const category = fields.category
    ? normalizeMarketplaceCategoryCode(fields.category)
    : DEFAULT_MARKETPLACE_CATEGORY_CODE;
  if (!name || !workflow) return null;
  const description = (fields.description || '').trim();
  const description_zh = (fields.description_zh || '').trim();
  const description_en = (fields.description_en || '').trim();

  const created = await createCustomAgent({
    name, description, description_zh, description_en, workflow, category,
    ...(fields.knowhow ? { knowhow: fields.knowhow } : {}),
    ...(fields.standards ? { standards: fields.standards } : {}),
    ...(typeof fields.interactive === 'boolean' ? { interactive: fields.interactive } : {}),
  });
  if (!created) return null;
  // Fold optional skill_list + inputs in via updateCustomAgent so the
  // closure expansion / input validation happens in one place.
  const updates: UpdateAgentFields = {};
  if (Array.isArray(fields.skill_list)) updates.skill_list = fields.skill_list;
  if (Array.isArray(fields.inputs)) updates.inputs = fields.inputs;
  if (Array.isArray(fields.knowhow)) updates.knowhow = fields.knowhow;
  if (Array.isArray(fields.standards)) updates.standards = fields.standards;
  if (Object.keys(updates).length) {
    const updated = await updateCustomAgent(created.agent_id, updates);
    return updated || created;
  }
  return created;
}
