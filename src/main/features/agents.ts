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

import {
  userAgentsDir, userSkillsDir, userAgentChatDir, userSessionFile, WS_ROOT,
  agentDir, agentDefinitionFile,
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
  listSkillSpecs,
  normalizeKnownSkillRefsForDisplay,
  resolveSkillAllowlistRefs,
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
import { NAME_DISPLAY_MAX_UNITS, nameDisplayWidth } from '../util/name-limit';

export type AgentSource = 'marketplace' | 'custom';
type AgentSourceInput = AgentSource | 'builtin';

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
  /** Marketplace category code. Empty string only for legacy/manual specs.
   *  Maintained by hidden create defaults and by the agent-edit LLM's `<category>` sub-tag. */
  category: string;
  /** Connector instance ids this agent is allowed to call. Three-state intentionally **diverges**
   *  from `skill_list`: `undefined` and `[]` both mean "no connectors" (collapsed to empty), only
   *  `string[]` non-empty grants access. Why stricter than skill_list's "undefined = no filter":
   *  connectors carry external side effects (sending emails, editing remote docs); a brand-new
   *  agent must opt in explicitly. Maintained by the agent edit UI, NOT by the agent-edit LLM. */
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
}

export interface AgentRaw {
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
  category?: unknown;
  status?: unknown;
  state?: unknown;
  enabled_connectors?: unknown;
  output_format?: unknown;
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
    if (typeof meta.version === 'string') agent.version = meta.version;
    if (typeof meta.published_at === 'number') agent.marketplace_published_at = meta.published_at;
    if (typeof meta.updated_at === 'number') agent.marketplace_updated_at = meta.updated_at;
    if (typeof meta.default_install === 'boolean') agent.default_install = meta.default_install;
    if (typeof meta.is_open_source === 'boolean') agent.is_open_source = meta.is_open_source;
    if (typeof meta.status === 'string') agent.status = meta.status;
    else if (typeof meta.state === 'string') agent.status = meta.state;
  } catch (err) {
    log.warn(`marketplace agent install metadata unreadable dir=${dir}: ${(err as Error).message}`);
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
  // enabled_connectors: only `string[]` carries through; missing / null / non-array all collapse
  // to "no connectors" (the field stays absent on the Agent object, which the runner treats as
  // empty). Filtering to safeId-ish strings keeps a malformed JSON from injecting weird ids.
  if (Array.isArray(raw.enabled_connectors)) {
    const filtered = raw.enabled_connectors.filter((v): v is string => typeof v === 'string' && v.length > 0);
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
  void opts;
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
    const sources: Array<[AgentSource, string]> = [['custom', CUSTOM_AGENTS_DIR()], ['marketplace', userMarketplaceAgentsDir(getActiveUserId())]];
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
          if (isMarketplaceSource(source)) {
            log.warn(`id conflict: custom and marketplace both define "${norm.agent_id}" — custom wins, rename one`);
          }
          continue;
        }
        seen.add(norm.agent_id);
        if (isMarketplaceSource(source)) {
          // Marketplace-installed agents carry `_install.json` with version + freshness.
          // Author uid may also be present there for install/reconcile compatibility, but the
          // global UI intentionally does not surface it.
          _applyMarketplaceInstallMeta(norm, path.join(dir, e.name));
        }
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
    .map((a) => _withDisplaySkillRefs(a, displaySkillSpecs));
}

/**
 * Look up an agent by id. Custom wins on name collision.
 * Returns normalized agent or null.
 */
export async function getAgent(agentId: string | null | undefined): Promise<Agent | null> {
  if (!agentId) return null;
  for (const source of ['custom', 'marketplace'] as AgentSource[]) {
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
        return _withDisplaySkillRefs(norm, await _skillSpecsForDisplay());
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
  try { return await listSkillSpecs(); }
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

/**
 * Create a custom agent. The call shape keeps historical optional fields, but
 * the quality gate requires a usable name plus at least one description variant
 * before the spec is written.
 */
export async function createCustomAgent(
  { name = '', description = '', description_zh, description_en, workflow = '', icon, color, interactive, runtime, category, output_format }: CreateAgentOptions = {},
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
  /** Marketplace category code. Empty string drops the field; omitted = untouched.
   *  Authored by hidden create defaults or by the agent-edit LLM via the `<category>` sub-tag.
   *  Missing model output is repaired to the default category on create. */
  category?: string;
  /** Three-way update:
   *   array (possibly empty) → replace (filtered to non-empty strings)
   *   null  → drop the field
   *   omitted → untouched
   *  Authored by the agent edit UI (connectors toggle list), NOT the agent-edit LLM. */
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
      const specs = await listSkillSpecs();
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
      const ids = v.filter((s): s is string => typeof s === 'string' && s.length > 0);
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
  data.updated_at = nowIso();
}

/** Edit-chat dispatcher: routes to custom write for custom agents. Platform
 *  and marketplace agents are read-only in OrkasOpen. */
export async function updateAgentSpec(
  agentId: string, updates: UpdateAgentFields,
): Promise<Agent | null> {
  if (!agentId) return null;
  if (fs.existsSync(customAgentFile(agentId))) {
    return updateCustomAgent(agentId, updates);
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
  if (!agent) return false;
  if (agent.source !== 'custom') return false;
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
}> {
  const attachmentNames = Array.isArray(attachments)
    ? attachments.filter((n): n is string => typeof n === 'string' && !!n.trim())
    : [];
  const attachmentCid = agentEditAttachmentCid(agentId);
  if (!attachmentNames.length) return { message: content, images: [], attachmentNames, attachmentCid };
  const { manifest, images } = await buildAttachmentManifest(userId, attachmentCid, attachmentNames);
  return {
    message: manifest ? `${manifest}\n${content}` : content,
    images,
    attachmentNames,
    attachmentCid,
  };
}

export async function sendToAgentEditChat(
  userId: string,
  agentId: string,
  content: string,
  opts: { attachments?: string[]; modelText?: string } = {},
): Promise<AgentEditResult> {
  const agent = await getAgent(agentId);
  if (!agent) return { ok: false, error: 'agent not found' };
  if (agent.source !== 'custom') {
    return { ok: false, error: t('errors.builtin_agent_not_editable') };
  }

  const meta = await loadAgentChatMeta(userId, agentId);
  const sessionId = meta.session_id || defaultAgentEditSessionId(agentId);

  const systemPrompt = buildAgentEditSystemPrompt(agent);
  const modelText = typeof opts.modelText === 'string' ? opts.modelText.trim() : '';
  const modelContent = modelText || content;
  const attachmentCtx = await buildAgentEditMessageWithAttachments(userId, agentId, modelContent, opts.attachments);

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
    readOnlyExtraRoots: [userMarketplaceSkillsDir(userId), userSkillsDir(userId)],
    ...(attachmentCtx.attachmentNames.length ? {
      images: attachmentCtx.images,
      readOnlyExtraRoots: [
        userMarketplaceSkillsDir(userId),
        userSkillsDir(userId),
        chatAttachmentDir(userId, attachmentCtx.attachmentCid),
      ],
    } : {}),
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
  if (agent.source !== 'custom') {
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
      readOnlyExtraRoots: [
        userMarketplaceSkillsDir(userId),
        userSkillsDir(userId),
        ...(attachmentCtx.attachmentNames.length ? [chatAttachmentDir(userId, attachmentCtx.attachmentCid)] : []),
      ],
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
