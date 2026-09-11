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
import { splitMarkdownProseCode } from '../../util/markdown-prose-code';

// ── Mention parsing ──────────────────────────────────────────────────────

// `@token` where token is `[A-Za-z0-9_一-鿿-]+` — ASCII word chars
// plus CJK Unified Ideographs so users can mention agents whose display
// names use CJK characters. Token
// boundaries:
//   - leading: start-of-string, any non-token char, OR a CJK char. CJK is
//     in the token class (names) but deliberately NOT in the leading
//     boundary: Chinese prose puts no space before `@` (`然后@PptMaker`),
//     and blocking that silently dropped the mention — the message routed
//     to one agent with the second `@` as literal text (observed on-device
//     2026-08-23). Email addresses (`foo@example.com`) still don't trip
//     this: their local part ends in an ASCII word char, which stays in
//     the boundary's negated class.
//   - trailing: matched greedily up to the first non-token char
//
// Multi-word display names ("Software Requirements Analyst") fall outside
// this char class — for those we build a per-call regex that prepends an
// alternation of known names (longest-first so the multi-word match wins
// over its single-word prefix). The fallback char class still covers
// unknown / partial tokens so behavior degrades gracefully when no name
// list is available.
const TOKEN_CLASS = '[A-Za-z0-9_一-鿿-]+';
const LEADING_BOUNDARY = '(^|[^A-Za-z0-9_-])';
const FALLBACK_MENTION_RE = /(^|[^A-Za-z0-9_-])@([A-Za-z0-9_一-鿿-]+)/gu;
const RESERVED_ACTOR_ALIASES = ['指挥官', 'commander', '用户', 'user'] as const;

function _escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _buildMentionRe(names?: readonly string[], includeFallback = true): RegExp {
  if (!names || !names.length) return new RegExp(FALLBACK_MENTION_RE.source, 'gu');
  // Longest-first so multi-word names anchor before any single-word prefix
  // shared with another name. Two agents named "Foo" and "Foo Bar" both
  // match correctly when the longer alternative is tried first.
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const namedAlt = sorted.map(_escapeForRegex).join('|');
  if (!includeFallback) {
    return new RegExp(`${LEADING_BOUNDARY}@(${namedAlt})`, 'gu');
  }
  return new RegExp(`${LEADING_BOUNDARY}@(${namedAlt}|${TOKEN_CLASS})`, 'gu');
}

// Keep offsets intact so parsing and segmentation use the same prose boundary.
function routingMentionRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  for (const segment of splitMarkdownProseCode(text)) {
    if (segment.kind === 'code') ranges.push([offset, offset + segment.text.length]);
    offset += segment.text.length;
  }
  offset = 0;
  for (const line of text.split('\n')) {
    if (/^\s*>/.test(line)) ranges.push([offset, offset + line.length]);
    offset += line.length + 1;
  }
  return ranges;
}

/** Scan a message body for `@token` mentions. Deduped, in first-occurrence
 *  order.
 *
 *  `fromKind` decides whether `@` counts as a dispatch signal:
 *    - `'user'` (or undefined, for back-compat) — full scan; a real
 *      user typing `@A` actually means "send to A".
 *    - `'commander'` — return `[]` immediately; commander LLM prose like
 *      `**@A**` or `@A / @B` is training-data markdown decoration, not a
 *      dispatch signal. The commander dispatch channels are the
 *      `dispatch_to` (single agent) and `plan_set` (multi-actor) tools.
 *    - `'agent'` — ignore arbitrary agent mentions for the same reason, but
 *      still allow reserved user/commander aliases so an agent can explicitly
 *      escalate with `@commander` / `@指挥官`.
 *  See docs/plans/dispatch-via-tool-call.md and CLAUDE.md §5.
 *
 *  `names` enables exact multi-word name matching: when a user types
 *  "@Software Requirements Analyst", the fallback char class only
 *  captures "@Software" (the allow-list excludes spaces); when that
 *  agent name is in `names`, the alternation matches the full segment
 *  in one shot. Callers should pass every roster + registry agent name
 *  as-is (case-sensitive preserved).
 */
export function parseMentions(
  text: string,
  opts?: { fromKind?: Actor['kind']; names?: readonly string[] },
): string[] {
  if (!text) return [];
  const excluded = routingMentionRanges(text);
  if (opts?.fromKind === 'commander') return [];
  const reservedOnly = opts?.fromKind === 'agent';
  const re = reservedOnly
    ? _buildMentionRe(RESERVED_ACTOR_ALIASES, false)
    : _buildMentionRe(opts?.names);
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[1].length;
    if (excluded.some(([a, b]) => start >= a && start < b)) continue;
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
  /** Present for segmented sends, including an empty plan for mention-only text. */
  plan?: SegmentedMentions;
  /** Final recipient list (deduped, may include the sender's @-targets). */
  to: string[];
  /** Tokens that didn't resolve to any known actor. UI may surface these. */
  unknown: string[];
  /** True when routing came from an explicit @ mention rather than the
   *  sender-default route / conversation floor. */
  hadExplicitMention: boolean;
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
  /** The conversation floor (`StateFile.active_recipient`): the agent the
   *  commander handed the user off to, or the one the user picked on the
   *  composer chip. When a USER message carries no `@` mention, it routes
   *  here instead of the commander. Absent / commander ⇒ the default
   *  (user → commander). It also owns prose before the first mention;
   *  an opening `@<target>` replaces it.
   *
   *  VALIDATED BY THE CALLER: the bus checks the floor against the enabled
   *  agent registry before passing it (roster membership is a lazily written
   *  RECORD — first dispatch creates the row — never an eligibility gate;
   *  gating on it silently rerouted a chip-selected agent's first message to
   *  the commander, on-device 2026-08-23). A dead floor (deleted/disabled
   *  agent) must be cleared by the caller, not passed here. */
  activeRecipient?: string;
  /** Legacy input accepted for compatibility; a multi-default falls back to Commander. */
  activeRecipients?: readonly string[];
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
 *  (so users can never type a mention with internal whitespace); the
 *  lowercase + strip pair makes
 *  match keys robust to display names that contain spaces ("Writing Helper"
 *  → "writinghelper") and to Latin-script case differences. */
function _normalizeNameKey(s: string): string {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

export function resolveRecipients(opts: ResolveOpts): RouteResolution {
  // Build the name list for the mention parser — roster agents + registry
  // display names + reserved aliases. Without this, multi-word names get
  // truncated at the first whitespace by the fallback regex (observed
  // in logs: a user typed something like
  // "@Socratic Learning Coach <imperative>" and got `mentions: ['Socratic']`
  // → unknown_token → fell back to commander default routing).
  const namesForParser: string[] = [];
  for (const m of opts.members) {
    if (m.kind === 'agent' && m.name) namesForParser.push(m.name);
  }
  if (opts.agentDisplayNames) namesForParser.push(...opts.agentDisplayNames);
  // Reserved-actor aliases — also accept the Chinese forms
  // (`@指挥官` / `@用户`). Cheap (4 strings).
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
  const tokenToId = new Map<string, string>();
  const unknown: string[] = [];
  for (const tok of tokens) {
    const accept = (id: string) => { resolved.push(id); tokenToId.set(tok, id); };
    if (RESERVED_IDS.has(tok) || memberIds.has(tok)) {
      accept(tok);
      continue;
    }
    // Try name → id (in current roster first, then global registry).
    const key = _normalizeNameKey(tok);
    if (key === '指挥官') { accept(COMMANDER_ID); continue; }
    if (key === '用户') { accept(USER_ID); continue; }
    const fromMembers = memberNameToId.get(key);
    if (fromMembers) { accept(fromMembers); continue; }
    const fromGlobal = opts.agentNameToId?.get(key);
    if (fromGlobal) { accept(fromGlobal); continue; }
    // Fallback: treat as a raw agent_id (for the rare LLM that emits ids).
    const r = opts.resolveUnknown?.(tok);
    if (r && safeId(r)) { accept(r); continue; }
    unknown.push(tok);
  }

  if (resolved.length) {
    if (opts.fromKind === 'user') {
      const plan = segmentUserMentions(opts.text, {
        tokenToId: (token) => tokenToId.get(token) || null,
        recipientIds: new Set(resolved), names: namesForParser,
        commanderId: COMMANDER_ID,
        defaultRecipient: opts.activeRecipient || COMMANDER_ID,
      });
      if (plan) return { to: [...new Set(plan.segments.map((s) => s.actorId))], unknown, hadExplicitMention: true, plan };
    }
    // De-dupe (someone might @ the same actor twice).
    return { to: Array.from(new Set(resolved)), unknown, hadExplicitMention: true };
  }

  // Tokens were present but none resolved synchronously — return empty
  // `to` and let the caller (bus) try async resolution against the agent
  // registry. Falling back to a sender-default here would cause the bus
  // to add BOTH the default recipient AND the async-resolved agent into
  // `to`, ending up with mixed routing like `to=['user', '<agent>']`.
  if (tokens.length > 0) {
    return { to: [], unknown, hadExplicitMention: true };
  }

  // No `@` mentions at all → default route based on sender role.
  //   - user → the conversation floor (`activeRecipient`): the agent the
  //     commander handed off to, else the commander (orchestrator picks up
  //     the request). This is what lets a handed-off agent keep the user's
  //     follow-ups without re-`@`-ing every message.
  //   - commander → user (its replies are user-facing summaries)
  //   - agent → user (default surface output to the human; agents only
  //     reach commander via an explicit `@<commander-name>` mention)
  // See the "Group-chat mechanics" section of `chat_agent_in_group.md`
  // and `chat_commander.md`.
  let def: string;
  if (opts.fromKind === 'user') {
    // The caller (bus) has already validated the floor against the enabled
    // agent registry — see `activeRecipient` docs. No roster gate here:
    // membership is a record written at first dispatch, not eligibility.
    const floor = opts.activeRecipient;
    def = (floor && floor !== COMMANDER_ID && floor !== USER_ID)
      ? floor : COMMANDER_ID;
  } else {
    def = USER_ID;
  }
  return { to: [def], unknown, hadExplicitMention: false };
}

// ── D9 mention segmentation (task-board plan §4.2.1) ─────────────────────

export interface MentionSegment {
  /** Resolved assignee actor id. */
  actorId: string;
  /** This assignee's instruction: its own span (plus quote-only context), mention
   * token stripped. */
  instruction: string;
  /** 0-based index of the mention group this segment came from. ADJACENT
   * mentions (only whitespace between them) share one group; each further
   * group is a later written span. The dispatcher uses the group count to
   * decide whether the send has any cross-group ordering to honor. */
  group: number;
}

export interface SegmentedMentions {
  segments: MentionSegment[];
  /** Raw text before the first mention (trimmed). Prose belongs to the default
   * recipient; quote-only context is shared. */
  preamble: string;
}

/**
 * Split a user message into per-assignee instruction segments — the
 * deterministic core that replaces same-text broadcast (D9, re-adjudicated
 * 2026-08-27/D22). Rules:
 *   - each resolved mention opens a segment extending to the next mention or
 *     end of text; ADJACENT mentions (whitespace-only gap) share the
 *     following span; repeated agents in one adjacent group are deduplicated; repeated
 *     agents with separate descriptions keep their ordered segments; empty
 *     descriptions do not dispatch; mentions in code or blockquote lines
 *     never open segments (literal context, matching `parseMentions`);
 *   - commander mentions (via `commanderId` in `tokenToId`) open ordinary
 *     segments — an explicit `@指挥官 … @A …` send segments exactly like an
 *     all-agent send instead of broadcasting the full text (D22);
 *   - an unaddressed first instruction belongs to the current default recipient;
 *     quote-only preambles remain shared context;
 *   - cross-segment context flows through the serial `after` hand-off, not
 *     through prefix duplication.
 *
 * Returns null for one described mention or no mentions — the caller keeps the ordinary
 * single-recipient path. Mention-only input returns an empty plan so it
 * cannot create a fallback task. No LLM participates (§4.2 principle 1); the
 * composer preview bar is the user's misparse guard.
 */
export function segmentUserMentions(
  text: string,
  opts: {
    /** Raw mention token → actor id (null = unresolvable). */
    tokenToId: (token: string) => string | null;
    /** Only mentions resolving into this set open segments. */
    recipientIds: ReadonlySet<string>;
    /** Display names for exact multi-word mention matching. */
    names?: readonly string[];
    /** Commander actor id. When set, explicit commander mentions open
     * segments just like selected Agents. */
    commanderId?: string;
    /** Owner of an unaddressed first instruction; defaults to Commander. */
    defaultRecipient?: string;
  },
): SegmentedMentions | null {
  if (!text) return null;
  const excluded = routingMentionRanges(text);
  const inQuote = (pos: number) => excluded.some(([s, e]) => pos >= s && pos < e);

  const re = _buildMentionRe(opts.names);
  const spans: Array<{ start: number; end: number; id: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const token = m[2];
    if (!token) continue;
    const start = m.index + m[1].length; // the '@'
    if (inQuote(start)) continue;
    const id = opts.tokenToId(token);
    if (!id) continue;
    if (!opts.recipientIds.has(id) && id !== opts.commanderId) continue;
    spans.push({ start, end: start + 1 + token.length, id });
  }
  if (!spans.length) return null;

  const preamble = text.slice(0, spans[0].start).trim();
  const hasFirstInstruction = preamble.split('\n').some((line) => line.trim() && !/^\s*>/.test(line));
  if (spans.length < 2 && !hasFirstInstruction && text.slice(spans[0].end).trim()) return null;
  // Group adjacent mentions: `@A @B do X` — nothing but whitespace between
  // the spans — share the span that follows the group.
  const groups: Array<{ ids: string[]; bodyStart: number }> = [];
  for (let i = 0; i < spans.length; i += 1) {
    const prev = groups[groups.length - 1];
    const gapStart = i > 0 ? spans[i - 1].end : -1;
    const adjacent = i > 0 && /^\s*$/.test(text.slice(gapStart, spans[i].start));
    if (adjacent && prev) {
      prev.ids.push(spans[i].id);
      prev.bodyStart = spans[i].end;
    } else {
      groups.push({ ids: [spans[i].id], bodyStart: spans[i].end });
    }
  }
  const segments: MentionSegment[] = hasFirstInstruction
    ? [{ actorId: opts.defaultRecipient || opts.commanderId || COMMANDER_ID, instruction: preamble, group: 0 }]
    : [];
  // Body of group g runs from its bodyStart to the start of group g+1's
  // FIRST mention (or end of text).
  const groupFirstStart: number[] = [];
  {
    let spanIdx = 0;
    for (const grp of groups) {
      groupFirstStart.push(spans[spanIdx].start);
      spanIdx += grp.ids.length;
    }
  }
  for (let g = 0; g < groups.length; g += 1) {
    const end = g + 1 < groups.length ? groupFirstStart[g + 1] : text.length;
    const body = text.slice(groups[g].bodyStart, end).trim();
    const instruction = !hasFirstInstruction && preamble
      ? [preamble, body].filter(Boolean).join('\n') : body;
    if (!body) continue;
    for (const id of new Set(groups[g].ids)) {
      segments.push({ actorId: id, instruction, group: g + (hasFirstInstruction ? 1 : 0) });
    }
  }
  return { segments, preamble };
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
  /** Executor-created user forms use this to bind the form submission to
   *  the exact plan step it is allowed to complete. Agent forms omit it. */
  plan_step_index?: number;
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
// canonical jsonl history still renders correctly. The fenced form had a
// token-split bug where some
// models emitted "```agent\n-input-form" — the tolerant `[\s\-]*` keeps
// covering that until legacy data ages out.
const FORM_XML_RE = /(?:^|\n)[ \t]*<agent-input-form>[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*<\/agent-input-form>[ \t]*(?=\n|$)/;
const FORM_FENCE_RE_LEGACY = /(?:^|\n)```\s*agent[\s\-]*input[\s\-]*form[ \t]*\r?\n([\s\S]*?)\n```(?=\n|$)/;

export interface ExtractFormResult {
  cleanText: string;
  form?: { agent_id: string; fields: AgentInput[] };
}

export type PlanInteractionStatus = 'open' | 'closed';

export interface ExtractPlanInteractionResult {
  cleanText: string;
  status?: PlanInteractionStatus;
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

// Hand-back marker: an agent emits a reason-bearing marker to return control
// after a dispatched handoff or to escalate an explicit capability boundary.
// Legacy bare markers remain parseable for ledger/floor compatibility, but the
// bus must never infer a direct capability boundary from their presence alone.
// Display-only markup; stripped from the visible bubble. Tolerant of
// self-closing vs paired form, same as the plan-interaction marker.
const HANDBACK_RE =
  /<handback\b([^>]*)\/>|<handback\b([^>]*)>\s*<\/handback>/gi;
const HANDBACK_REASON_RE = /(?:^|\s)reason\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const HANDBACK_REASON_ASSIGNMENT_RE = /(?:^|\s)reason\s*=/gi;

export type HandbackReason = 'completed_handoff' | 'capability_boundary';

export interface ExtractHandbackResult {
  cleanText: string;
  handback?: true;
  reason?: HandbackReason;
}

/** Strip a `<handback />` marker from an agent's visible text and report
 *  whether it was present. The caller owns floor reset and any guarded
 *  commander continuation. */
export function extractHandbackFromFinal(text: string): ExtractHandbackResult {
  if (!text || typeof text !== 'string') return { cleanText: text || '' };
  if (!text.toLowerCase().includes('<handback')) return { cleanText: text };
  // The cheap substring check above also passes on look-alikes (`<handbackfoo>`,
  // `<handback-note>`, prose mentioning the token) — only the strict marker regex
  // should count as a real hand-back, otherwise control is wrongly returned to
  // the commander.
  const matches = Array.from(text.matchAll(HANDBACK_RE));
  if (!matches.length) return { cleanText: text };
  const reasons = new Set<HandbackReason>();
  let hasBareOrInvalidReason = false;
  for (const match of matches) {
    const attrs = match[1] ?? match[2] ?? '';
    const reasonAssignments = attrs.match(HANDBACK_REASON_ASSIGNMENT_RE)?.length ?? 0;
    const reasonMatch = HANDBACK_REASON_RE.exec(attrs);
    const rawReason = (reasonMatch?.[1] ?? reasonMatch?.[2] ?? '').trim();
    if (
      reasonAssignments === 1
      && (rawReason === 'completed_handoff' || rawReason === 'capability_boundary')
    ) {
      reasons.add(rawReason);
    } else {
      hasBareOrInvalidReason = true;
    }
  }
  const cleanText = text.replace(HANDBACK_RE, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // Multiple conflicting markers, or an explicit marker mixed with a legacy /
  // invalid one, are ambiguous. Strip them, but leave the reason undefined so
  // a direct turn fails closed instead of fabricating a capability boundary.
  const reason = !hasBareOrInvalidReason && reasons.size === 1
    ? reasons.values().next().value
    : undefined;
  return { cleanText, handback: true, ...(reason ? { reason } : {}) };
}

const PLAN_INTERACTION_RE =
  /<plan-interaction\b([^>]*)\/>|<plan-interaction\b([^>]*)>\s*<\/plan-interaction>/gi;

/** Strip the lightweight plan-interaction marker from an agent's visible
 *  final text. The marker is intentionally tiny: only status=open|closed
 *  matters, and the executor uses the latest valid marker in the reply. */
export function extractPlanInteractionFromFinal(text: string): ExtractPlanInteractionResult {
  if (!text || typeof text !== 'string') return { cleanText: text || '' };
  if (!text.includes('<plan-interaction')) return { cleanText: text };

  let status: PlanInteractionStatus | undefined;
  const cleanText = text.replace(PLAN_INTERACTION_RE, (_full, attrs1 = '', attrs2 = '') => {
    const attrs = String(attrs1 || attrs2 || '');
    const m = /\bstatus\s*=\s*["'](open|closed)["']/i.exec(attrs);
    if (m) status = m[1].toLowerCase() as PlanInteractionStatus;
    return '\n';
  }).replace(/\n{3,}/g, '\n\n').trim();

  return status ? { cleanText, status } : { cleanText: text };
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
 *  travels above the XML tag. Optional blanks are intentionally rendered as
 *  empty text, not "(unfilled)", so the user-visible replay mirrors the form. */
export function formatValueForSummary(field: AgentInput, raw: unknown): string {
  const fallback = '';
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

// ── Skill-container parser (re-exported from features/skills) ────────────

export type { SkillContainerExtracted, SkillContainerResult } from '../skills';
export { extractSkillContainers } from '../skills';
