/**
 * Group-chat router — `@` parsing + default-recipient resolution.
 *
 * Pure functions. No IO. The bus calls this on every outbound message to
 * decide who's in the recipient list. Form / agent-container parsers also
 * live here (moved from features/agent_input_form.ts and features/agents.ts
 * so the bus can apply them in one pass).
 */

import {
  Actor, COMMANDER_ID, USER_ID, RESERVED_IDS,
} from './state';
import { safeId } from '../../storage';

// ── Mention parsing ──────────────────────────────────────────────────────

// `@token` where token is `[A-Za-z0-9_一-鿿-]+` — ASCII word chars
// plus CJK Unified Ideographs so users can `@张三` an agent by name. Token
// boundaries:
//   - leading: start-of-string or any non-token char
//   - trailing: matched greedily up to the first non-token char
// Email addresses (`foo@example.com`) shouldn't trip this — the leading
// boundary disqualifies them since `o` is in the char class.
//
// Multi-word display names ("Software Requirements Analyst") fall outside
// this char class — for those we build a per-call regex that prepends an
// alternation of known names (longest-first so the multi-word match wins
// over its single-word prefix). The fallback char class still covers
// unknown / partial tokens so behavior degrades gracefully when no name
// list is available.
const TOKEN_CLASS = '[A-Za-z0-9_一-鿿-]+';
const FALLBACK_MENTION_RE = /(^|[^A-Za-z0-9_一-鿿-])@([A-Za-z0-9_一-鿿-]+)/gu;

function _escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _buildMentionRe(names?: readonly string[]): RegExp {
  if (!names || !names.length) return new RegExp(FALLBACK_MENTION_RE.source, 'gu');
  // Longest-first so multi-word names anchor before any single-word prefix
  // shared with another name. Two agents named "Foo" and "Foo Bar" both
  // match correctly when the longer alternative is tried first.
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const namedAlt = sorted.map(_escapeForRegex).join('|');
  return new RegExp(`(^|[^A-Za-z0-9_一-鿿-])@(${namedAlt}|${TOKEN_CLASS})`, 'gu');
}

/** Scan a message body for `@token` mentions. Deduped, in first-occurrence
 *  order.
 *
 *  `fromKind` 决定是否把 `@` 当 dispatch 信号:
 *    - `'user'` (或 undefined,向后兼容) — 走完整扫描;真人用户敲 `@A` 是真心要找 A
 *    - `'commander'` / `'agent'` — 直接返回 `[]`;LLM 散文里 `**@A**` `@A / @B`
 *      这类是训练数据带来的 markdown 装饰习惯,系统不识别为派活信号。LLM 派活
 *      的唯一通道是 `dispatch_to` (单 agent) 或 `plan_set` (多 actor) 工具。
 *  详见 docs/plans/dispatch-via-tool-call.md 与 CLAUDE.md §5。
 *
 *  `names` 启用多词名字精确匹配:用户敲 "@Software Requirements Analyst" 这种
 *  带空格的显示名,fallback 字符类只能截到 "@Software"(白名单不含空格);names
 *  里有该 agent 名时 alternation 会一次匹完整段。caller 应传入 roster +
 *  registry 的所有 agent name(原文,大小写敏感保留)。
 */
export function parseMentions(
  text: string,
  opts?: { fromKind?: Actor['kind']; names?: readonly string[] },
): string[] {
  if (!text) return [];
  if (opts?.fromKind && opts.fromKind !== 'user') return [];
  const re = _buildMentionRe(opts?.names);
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[2];
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * Build an `@<name>` token for output (user bubbles, dispatch prefixes,
 * `@<id>` → `@<name>` rewrites, form-submission text, pendingDispatch
 * synthesis — every place code constructs an at-mention that ends up in a
 * persisted message).
 *
 * Whitespace inside `name` is preserved verbatim. The parser side
 * (`_buildMentionRe`) handles multi-word names via a longest-first named-alt
 * regex, so stripping whitespace at construction time only mangles the
 * display ("Agent Skill X" → "AgentSkillX") without buying any routing
 * safety. Lookup-key normalisation (lower + strip-whitespace) lives in
 * `_normalizeNameKey` and is its own concern — do not conflate with this.
 *
 * **Use this helper everywhere you would otherwise write `` `@${name}` ``**:
 * having a single construction point is the only durable fix for the
 * recurring "agent name with spaces gets mangled" class of bug
 * (commits `ebf76e80` → `2eeee2f6` → `98ff0d2d` → form-submission round —
 * each round only patched the discovered call site, leaving siblings to
 * resurface the same regression). Future contributors who reach for the
 * helper inherit the invariant for free; reviewing for inline
 * `'@' + name.replace(/\s+/g, '')` is still recommended but no longer
 * load-bearing once every existing site is migrated.
 */
export function buildMention(name: string): string {
  return `@${String(name || '').trim()}`;
}

// ── Routing ──────────────────────────────────────────────────────────────

export interface RouteResolution {
  /** Final recipient list (deduped, may include the sender's @-targets). */
  to: string[];
  /** Tokens that didn't resolve to any known actor. UI may surface these. */
  unknown: string[];
}

export interface ResolveOpts {
  fromKind: Actor['kind'];
  fromId: string;
  text: string;
  /** Current member roster — used to map tokens to known actor ids. */
  members: Actor[];
  /** Map of agent_name → agent_id for agents the LLM can `@` by display
   *  name instead of opaque id. Case-insensitive lookup; key may be any
   *  enabled agent's `name` (commander prompt instructs use of names, not
   *  ids, since `@a83d30d995fd` is hostile UX). */
  agentNameToId?: Map<string, string>;
  /** Original-case display names (with internal spaces preserved). Required
   *  for the mention parser to greedy-match multi-word names like "Software
   *  Requirements Analyst" — `agentNameToId` keys are normalized (lower +
   *  whitespace stripped) so they can't be regex-matched against raw text.
   *  Caller passes the registry's agent.name strings verbatim. */
  agentDisplayNames?: readonly string[];
  /** Optional resolver for an unknown token (post name + member checks):
   *  if it returns a real agent_id, the router treats it as resolved (and
   *  the bus will auto-add the actor). Mostly a fallback for raw-id @
   *  mentions in case the LLM falls back to ids. */
  resolveUnknown?: (token: string) => string | null;
}

/**
 * Decide who a message goes to.
 *
 * Default routing (no `@` mentions):
 *   user      → [commander]
 *   commander → [user]
 *   agent     → [user]
 *
 * With `@<token>` mentions: resolve every token; route to the union. If
 * no token resolves, fall through to the default recipient (so a stray
 * "@nobody" still reaches commander instead of the void).
 */
/** Normalize a token / agent name for lookup: lowercase + strip all
 *  whitespace. The mention-regex already disallows whitespace inside tokens
 *  (so the user can never type `@张 三`); the lowercase + strip pair makes
 *  match keys robust to display names that contain spaces ("Writing Helper"
 *  → "writinghelper") and to Latin-script case differences. */
function _normalizeNameKey(s: string): string {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

export function resolveRecipients(opts: ResolveOpts): RouteResolution {
  // Build the name list for the mention parser — roster agents + registry
  // display names + reserved aliases. Without this, multi-word names get
  // truncated at the first whitespace by the fallback regex (see日志:
  // user typed "@Socratic Learning Coach 运行" and got `mentions: ['Socratic']`
  // → unknown_token → fell back to commander default routing).
  const namesForParser: string[] = [];
  for (const m of opts.members) {
    if (m.kind === 'agent' && m.name) namesForParser.push(m.name);
  }
  if (opts.agentDisplayNames) namesForParser.push(...opts.agentDisplayNames);
  // Reserved-actor aliases — let `@指挥官` / `@用户` route too. Cheap (4 strings).
  namesForParser.push('指挥官', '用户', 'commander', 'user');
  const tokens = parseMentions(opts.text, { fromKind: opts.fromKind, names: namesForParser });
  const memberIds = new Set(opts.members.map((m) => m.id));
  // Build a case + space-insensitive name lookup once. Member display
  // names take precedence over the global agent registry — the roster is
  // what's actually visible in the conversation, not the registry.
  const memberNameToId = new Map<string, string>();
  for (const m of opts.members) {
    if (m.kind === 'agent' && m.name) {
      memberNameToId.set(_normalizeNameKey(m.name), m.id);
    }
  }
  const resolved: string[] = [];
  const unknown: string[] = [];
  for (const tok of tokens) {
    if (RESERVED_IDS.has(tok) || memberIds.has(tok)) {
      resolved.push(tok);
      continue;
    }
    // Try name → id (in current roster first, then global registry).
    const key = _normalizeNameKey(tok);
    const fromMembers = memberNameToId.get(key);
    if (fromMembers) { resolved.push(fromMembers); continue; }
    const fromGlobal = opts.agentNameToId?.get(key);
    if (fromGlobal) { resolved.push(fromGlobal); continue; }
    // Fallback: treat as a raw agent_id (for the rare LLM that emits ids).
    const r = opts.resolveUnknown?.(tok);
    if (r && safeId(r)) { resolved.push(r); continue; }
    unknown.push(tok);
  }

  if (resolved.length) {
    // De-dupe (someone might @ the same actor twice).
    return { to: Array.from(new Set(resolved)), unknown };
  }

  // Tokens were present but none resolved synchronously — return empty
  // `to` and let the caller (bus) try async resolution against the agent
  // registry. Falling back to a sender-default here would cause the bus
  // to add BOTH the default recipient AND the async-resolved agent into
  // `to`, ending up with mixed routing like `to=['user', '<agent>']`.
  if (tokens.length > 0) {
    return { to: [], unknown };
  }

  // No `@` mentions at all → default route based on sender role.
  //   - user → commander (orchestrator picks up the request)
  //   - commander → user (its replies are user-facing summaries)
  //   - agent → user (default surface output to the human; agents only
  //     reach commander via an explicit `@<commander-name>` mention)
  // See `chat_agent_in_group.md` § 群聊机制 + `chat_commander.md`.
  let def: string;
  if (opts.fromKind === 'user') def = COMMANDER_ID;
  else def = USER_ID;
  return { to: [def], unknown };
}

// ── Form payload + agent-container parsers (moved here so bus can apply
//    them in one pass on every actor's final text). ─────────────────────

import * as crypto from 'node:crypto';
import {
  type AgentInput,
  validateAgentInputs,
  type ExtractedFields,
} from '../agents';
import { createLogger } from '../../logger';

const log = createLogger('group_chat.router');

export interface ChatFormPayload {
  form_id: string;
  /** `agent_id` of the agent that owns this form. The submission is routed
   *  back to this id (the bus will @-prefix on the user's behalf). */
  agent_id: string;
  fields: AgentInput[];
  submitted: boolean;
  values?: Record<string, unknown>;
  submitted_at?: string;
}

// Form block regexes. Primary protocol is XML `<agent-input-form>...</agent-input-form>`
// — symmetric with the `<agent-input-submission>` reply tag, token-stable
// (LLMs never split hyphenated XML tag names mid-token), and markdown
// won't accidentally render it as a code block on a parse miss.
//
// Legacy fenced ```agent-input-form block is kept as a fallback so old
// jsonl history (chats/<cid>.jsonl + visibility/<aid>.jsonl) still
// renders correctly. The fenced form had a token-split bug where some
// models emitted "```agent\n-input-form" — the tolerant `[\s\-]*` keeps
// covering that until legacy data ages out.
const FORM_XML_RE = /(?:^|\n)[ \t]*<agent-input-form>[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*<\/agent-input-form>[ \t]*(?=\n|$)/;
const FORM_FENCE_RE_LEGACY = /(?:^|\n)```\s*agent[\s\-]*input[\s\-]*form[ \t]*\r?\n([\s\S]*?)\n```(?=\n|$)/;

export interface ExtractFormResult {
  cleanText: string;
  form?: { agent_id: string; fields: AgentInput[] };
}

/** Strip an `agent-input-form` block (XML primary, legacy fence fallback)
 *  from an actor's final text. The bus calls this after every agent turn
 *  (commander never emits forms; forms are an agent → user channel). */
export function extractFormFromFinal(text: string, defaultAgentId?: string): ExtractFormResult {
  if (!text || typeof text !== 'string') return { cleanText: text || '' };
  // Cheap pre-filter — skip both regexes unless plausibly present.
  const hasXml = text.includes('<agent-input-form>');
  const hasLegacy = !hasXml && /```\s*agent[\s\-]*input[\s\-]*form/.test(text);
  if (!hasXml && !hasLegacy) return { cleanText: text };

  const re = hasXml ? FORM_XML_RE : FORM_FENCE_RE_LEGACY;
  const m = re.exec(text);
  if (!m) return { cleanText: text };

  const body = (m[1] || '').trim();
  if (!body) { log.warn('form block empty'); return { cleanText: text }; }

  let parsed: unknown;
  try { parsed = JSON.parse(body); }
  catch (err) { log.warn(`form JSON parse failed: ${(err as Error).message}`); return { cleanText: text }; }

  if (!parsed || typeof parsed !== 'object') {
    log.warn('form top-level not an object'); return { cleanText: text };
  }
  const obj = parsed as Record<string, unknown>;
  // agent_id is optional in agent-emitted forms; default to the emitting
  // agent so the renderer knows where to route the submission.
  let agentId = typeof obj.agent_id === 'string' ? obj.agent_id.trim() : '';
  if (!agentId && defaultAgentId) agentId = defaultAgentId;
  if (!agentId || !safeId(agentId)) {
    log.warn(`form agent_id invalid: ${JSON.stringify(obj.agent_id)}`); return { cleanText: text };
  }
  const fields = validateAgentInputs(obj.fields);
  if (!fields.length) {
    log.warn(`form has no valid fields (agent_id=${agentId})`); return { cleanText: text };
  }

  const cleanText = text.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { cleanText, form: { agent_id: agentId, fields } };
}

export function computeFormId(cid: string, msgId: string, agentId: string, fields: AgentInput[]): string {
  const h = crypto.createHash('sha1');
  h.update(cid); h.update('|');
  h.update(msgId); h.update('|');
  h.update(agentId); h.update('|');
  h.update(JSON.stringify(fields));
  return h.digest('hex').slice(0, 16);
}

// Submission tag — emitted by the renderer when the user submits a form.
// Routed back to the form's owning agent by the bus (the renderer prepends
// `@<aid>` on the user's behalf).
const SUBMISSION_RE =
  /<agent-input-submission\s+form_id="([a-f0-9]{8,64})"\s+agent_id="([a-z0-9_-]{1,64})"[^>]*>\s*([\s\S]*?)\s*<\/agent-input-submission>/i;

export interface DecodedSubmission {
  form_id: string;
  agent_id: string;
  values: Record<string, unknown>;
}

export function decodeSubmission(text: string): DecodedSubmission | null {
  if (!text) return null;
  const m = SUBMISSION_RE.exec(text);
  if (!m) return null;
  const [, form_id, agent_id, body] = m;
  if (!safeId(agent_id)) return null;
  let values: unknown;
  try { values = JSON.parse(body); }
  catch (err) { log.warn(`submission JSON parse failed: ${(err as Error).message}`); return null; }
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  return { form_id, agent_id, values: values as Record<string, unknown> };
}

/** Format a single submitted value for the human-readable summary that
 *  travels above the XML tag. Same logic as the legacy chat had — kept here
 *  so the renderer can call it without depending on agent_input_form.ts. */
export function formatValueForSummary(field: AgentInput, raw: unknown): string {
  const fallback = '(unfilled)';
  if (raw === undefined || raw === null) return fallback;
  if (field.type === 'boolean') return raw === true ? 'yes' : 'no';
  if (field.type === 'select') {
    const opt = (field.options || []).find((o) => o.value === raw);
    return opt ? opt.label : String(raw);
  }
  if (field.type === 'multiselect') {
    const arr = Array.isArray(raw) ? raw : [];
    if (!arr.length) return fallback;
    const opts = field.options || [];
    return arr.map((v) => opts.find((o) => o.value === v)?.label || String(v)).join('、');
  }
  if (field.type === 'file') {
    if (Array.isArray(raw)) {
      const names = raw.filter((x) => typeof x === 'string' && x);
      return names.length ? names.join('、') : fallback;
    }
    const s = typeof raw === 'string' ? raw : '';
    return s ? s : fallback;
  }
  if (field.type === 'number') return String(raw);
  const s = String(raw);
  return s.trim() ? s : fallback;
}

export function encodeSubmission(
  form: { form_id: string; agent_id: string; fields: AgentInput[] },
  values: Record<string, unknown>,
): string {
  const summaryLines = form.fields.map((f) => {
    const v = Object.prototype.hasOwnProperty.call(values, f.id) ? values[f.id] : f.default;
    return `- ${f.label}：${formatValueForSummary(f, v)}`;
  });
  const tag = `<agent-input-submission form_id="${form.form_id}" agent_id="${form.agent_id}">\n${JSON.stringify(values)}\n</agent-input-submission>`;
  return `${summaryLines.join('\n')}\n\n${tag}`;
}

// ── Agent-container parser (re-exported from features/agents) ────────────

export type { ExtractedFields };
export { extractAgentFieldBlocks } from '../agents';
