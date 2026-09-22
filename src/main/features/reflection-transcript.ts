/** Reflection evidence from complete task conversations, bounded across the batch.
 * Canonical conversation records own dialogue; old session-only histories remain
 * readable. Cropping affects this projection only, never persisted messages.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { userSessionsDir, projectSessionsDir } from '../paths';
import { cloudSessionFileFor, listProjectIds } from '../util/project-layout';
import { createLogger } from '../logger';
import { estimateBudgetTokens, estimateBudgetTokenQuarters } from '../util/token-estimate';
import { historyMessageIndex, historyMessages, historyRecordText } from './chat-history-records';
import { listConversations, type Conversation } from './chats';
import { querySignalsForUser, type Signal, type SignalType } from './expert_signals';

const log = createLogger('reflection-transcript');

// ── Evidence caps ────────────────────────────────────────────────

export const MAX_CONVS = 5;
export const MAX_TOKENS = 150_000;
const SYSTEM_EVENT_TYPES: SignalType[] = ['form_left_blank', 'silence'];
export const estimateTokens = estimateBudgetTokens;

// ── Filesystem-based agent participation discovery ──────────────────────

/** Find all `gmember-<cid>-<agentId>.jsonl` files on disk and return
 *  `(cid, filepath)` for each. Bypasses `conv.agent_id` (the UI hint
 *  "starting agent") to catch convs the agent was dispatched into via
 *  `plan_set` — a real blind spot of the previous reflection design.
 *
 *  Returns empty when the sessions directory doesn't exist (fresh install
 *  / freshly-switched uid). Used both for transcript building and for the
 *  orchestrator's dirty-gate mtime probe.
 *
 *  Filename parsing uses `startsWith` + `endsWith` (not split-on-'-')
 *  because cids may contain dashes (UUID-shaped). `agentId` is a
 *  server-issued / `safeId`-validated identifier — no regex escape needed. */
export function listAgentGmemberFiles(
  uid: string,
  agentId: string,
): Array<{ cid: string; file: string }> {
  if (!agentId) return [];
  const prefix = 'gmember-';
  const suffix = `-${agentId}.jsonl`;
  const out: Array<{ cid: string; file: string }> = [];
  const dirs = [userSessionsDir(uid), ...listProjectIds(uid).map((pid) => projectSessionsDir(uid, pid))];
  for (const dir of dirs) {
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
      const cid = name.slice(prefix.length, -suffix.length);
      if (!cid) continue;
      out.push({ cid, file: path.join(dir, name) });
    }
  }
  return out;
}

// ── Internal types ──────────────────────────────────────────────────────

interface TranscriptEntry {
  ts: number;
  kind: 'user' | 'agent' | 'system';
  actor?: string;
  text: string;
}

interface ConvSection {
  conv: Conversation;
  entries: TranscriptEntry[];
}

// ── Message parsing ─────────────────────────────────────────────────────

/** Parse `<msg from="X" to="Y">...</msg>` wrapper used by group_chat. The
 *  wrapper carries the actual sender identity — `from="user"` is the human,
 *  `from="commander"` is commander dispatch, `from="<aid>"` is another agent.
 *  If no wrapper is detected (e.g. legacy edit chats), treat as a user
 *  message with the raw text. */
function parseMsgWrapper(raw: string): { from: string; inner: string } {
  const m = raw.match(/^<msg\s+from="([^"]+)"\s+to="[^"]*"[^>]*>([\s\S]*?)<\/msg>\s*$/);
  if (!m) return { from: 'user', inner: raw };
  return { from: m[1], inner: m[2].trim() };
}

/** Extract user-voice entries from a session jsonl. Filters to role=user
 *  text blocks where the `<msg>` wrapper says `from="user"` — drops
 *  commander dispatch / agent system messages. Skips tool_result blocks. */
function extractUserEntries(messages: any[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const m of messages) {
    if (!m || m.role !== 'user') continue;
    if (typeof m.ts !== 'number') continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const texts: string[] = [];
    for (const b of blocks) {
      if (!b || b.type !== 'text' || typeof b.text !== 'string') continue;
      const { from, inner } = parseMsgWrapper(b.text);
      if (from !== 'user') continue;
      const trimmed = inner.trim();
      if (trimmed) texts.push(trimmed);
    }
    if (texts.length) out.push({ ts: m.ts, kind: 'user', text: texts.join('\n') });
  }
  return out;
}

/** Extract agent-reply entries from a session jsonl. Filters to role=assistant
 *  text blocks only — drops thinking / tool_use / tool_result (those are
 *  intermediate work, not the final user-facing output). */
function extractAgentEntries(messages: any[]): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const m of messages) {
    if (!m || m.role !== 'assistant') continue;
    if (typeof m.ts !== 'number') continue;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const texts: string[] = [];
    for (const b of blocks) {
      if (!b || b.type !== 'text' || typeof b.text !== 'string') continue;
      const trimmed = b.text.trim();
      if (trimmed) texts.push(trimmed);
    }
    if (!texts.length) continue;
    const text = texts.join('\n');
    out.push({ ts: m.ts, kind: 'agent', text });
  }
  return out;
}

/** Render one signal as a synthetic system-event transcript entry. Returns
 *  null when the signal type isn't one of the inlined kinds (defensive —
 *  caller already filters by type). */
function renderSignalEntry(sig: Signal): TranscriptEntry | null {
  const ts = Date.parse(sig.ts);
  if (Number.isNaN(ts)) return null;
  const meta = (sig.metadata || {}) as Record<string, unknown>;
  switch (sig.type) {
    case 'form_left_blank': {
      const reqLabel = meta.was_required ? 'required field' : 'field';
      return { ts, kind: 'system', text: `user left ${reqLabel} "${meta.input_id ?? '?'}" blank on form submit` };
    }
    case 'silence':
      return { ts, kind: 'system', text: `agent message received no user response (silence threshold reached)` };
    default:
      return null;
  }
}

// ── Session IO ──────────────────────────────────────────────────────────

function readSessionJsonl(uid: string, sessionId: string): any[] {
  let file: string;
  try { file = cloudSessionFileFor(uid, sessionId); } catch { return []; }
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }
  const out: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed line */ }
  }
  return out;
}

// ── Rendering ───────────────────────────────────────────────────────────

function pad2(n: number): string { return String(n).padStart(2, '0'); }

function formatTs(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function renderEntry(e: TranscriptEntry): string {
  const ts = formatTs(e.ts);
  if (e.kind === 'system') return `[${ts} system event] ${e.text}`;
  return `[${ts} ${e.actor || e.kind}]\n${e.text}`;
}

function formatConvSection(section: ConvSection): string {
  const c = section.conv;
  const dateBase = c.created_at ? Date.parse(c.created_at) : section.entries[0]?.ts || Date.now();
  const datePart = new Date(dateBase).toISOString().slice(0, 10);
  const lines: string[] = [`### ${c.conversation_id} — ${c.title || '(untitled)'} (${datePart})`, ''];
  for (const e of section.entries) {
    lines.push(renderEntry(e));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// ── Top-level build ─────────────────────────────────────────────────────

export interface TranscriptResult {
  /** Markdown-ish transcript string. Empty when no activity matched. */
  text: string;
  /** The sources could not be read, so an empty `text` means "unknown", not
   *  "nothing happened". Callers must treat this as a transient failure worth
   *  retrying rather than as an examined-and-empty window. */
  unavailable?: boolean;
  /** Evidence existed, but no complete message fit the input budget. */
  capacityExceeded?: boolean;
  /** Sanity-check counters for callers / observability. */
  stats: {
    convsConsidered: number;
    convsIncluded: number;
    convsTruncated: number;
    estimatedTokens: number;
  };
}

/**
 * Build the activity transcript for one agent over a lookback window.
 * Returns `text: ''` (with `stats.convsIncluded === 0`) when nothing matches.
 *
 * @param uid       active user id
 * @param agentId   `_default` (no-agent / commander-only conversations) or a specific agent_id
 * @param sinceMs   selects recently active tasks; selected dialogue includes earlier messages
 * @param maxTokens safe conversation capacity after fixed prompt/tool/output reservations
 */
export async function buildTranscript(
  uid: string,
  agentId: string,
  sinceMs: number,
  maxTokens = MAX_TOKENS,
): Promise<TranscriptResult> {
  const isDefault = agentId === '_default';

  let convs: Conversation[] = [];
  try { convs = await listConversations(uid); }
  catch (err) {
    log.warn(`listConversations failed uid=${uid}: ${(err as Error).message}`);
    return { ..._empty(), unavailable: true };
  }

  // Cid → conv metadata lookup for both branches.
  const convsMap = new Map<string, Conversation>();
  for (const c of convs) convsMap.set(c.conversation_id, c);

  let matched: Conversation[];
  if (isDefault) {
    // _default = commander-only convs (no agent bound). These have no
    // gmember files; the gconv session is both user voice and "agent" reply.
    matched = convs.filter((c) => !c.agent_id);
  } else {
    // Specific agent: filesystem-scan gmember files to find every conv the
    // agent actually ran in — including ones it was dispatched into via
    // plan_set where conv.agent_id != agentId. Orphan gmember files (conv
    // deleted but sessions_sweep hasn't run) are skipped silently — sweep
    // cleans them on next activateUser.
    matched = [];
    let orphans = 0;
    for (const { cid } of listAgentGmemberFiles(uid, agentId)) {
      const conv = convsMap.get(cid);
      if (conv) matched.push(conv);
      else orphans += 1;
    }
    if (orphans > 0) log.debug(`buildTranscript: ${orphans} orphan gmember file(s) for agent=${agentId} (conv deleted, awaiting sweep)`);
  }
  if (!matched.length) return _empty();

  // Single signal query covers the whole window; we partition by cid below.
  // For `_default` we pass `aid: null` (any commander-scope signal outside
  // the SYSTEM_EVENT_TYPES whitelist is filtered out anyway, so a
  // permissive aid filter for _default is fine).
  let windowSignals: Signal[] = [];
  try {
    windowSignals = await querySignalsForUser(uid, {
      since: new Date(sinceMs).toISOString(),
      types: SYSTEM_EVENT_TYPES,
      ...(isDefault ? {} : { aid: agentId }),
    });
  } catch (err) {
    log.warn(`querySignals failed: ${(err as Error).message}`);
  }

  // Index metadata first; read canonical bodies only for the five selected tasks.
  // A present canonical file is authoritative even if all its rows were deleted.
  const candidates: Array<{ conv: Conversation; lastTs: number;
    source: Awaited<ReturnType<typeof historyMessageIndex>>; legacy?: TranscriptEntry[] }> = [];
  try {
    for (const conv of matched) {
      const source = await historyMessageIndex(uid, conv.conversation_id);
      const legacy = source.stamp ? undefined : legacyConversationEntries(uid, conv);
      const lastTs = source.stamp
        ? source.entries.reduce((last, row) => row.metadata.deleted_at ? last
          : Math.max(last, Date.parse(row.metadata.ts) || 0), 0)
        : legacy!.reduce((last, entry) => Math.max(last, entry.ts), 0);
      if (lastTs >= sinceMs && (source.entries.length || legacy?.length)) {
        candidates.push({ conv, lastTs, source, legacy });
      }
    }
    candidates.sort((a, b) => b.lastTs - a.lastTs || a.conv.conversation_id.localeCompare(b.conv.conversation_id));
    const sections: ConvSection[] = [];
    for (const candidate of candidates.slice(0, MAX_CONVS)) {
      const { conv, source } = candidate;
      const entries: TranscriptEntry[] = candidate.legacy ?? (await historyMessages(uid, conv.conversation_id,
        source.entries.filter((row) => !row.metadata.deleted_at).map((row) => row.index), source))
        .flatMap((message): TranscriptEntry[] => {
          const ts = Date.parse(message.ts);
          const text = historyRecordText(message);
          if (!Number.isFinite(ts) || !text.trim() || message.deleted_at) return [];
          return [{ ts, kind: message.from === 'user' ? 'user' : 'agent', actor: message.from, text }];
        });
      for (const signal of windowSignals) {
        if (signal.cid !== conv.conversation_id) continue;
        const entry = renderSignalEntry(signal);
        if (entry) entries.push(entry);
      }
      entries.sort((a, b) => a.ts - b.ts);
      if (entries.length) sections.push({ conv, entries });
    }
    return fitTranscript(sections, candidates.length, agentId, sinceMs, maxTokens);
  } catch {
    log.warn('Reflection conversation source unavailable');
    return { ..._empty(), unavailable: true };
  }
}

/** Legacy-only recovery: read all participating actors, never duplicate an
 * existing canonical conversation with injected private session history. */
function legacyConversationEntries(uid: string, conv: Conversation): TranscriptEntry[] {
  const gconv = readSessionJsonl(uid, conv.session_id);
  const entries = [...extractUserEntries(gconv),
    ...extractAgentEntries(gconv).map((entry) => ({ ...entry, actor: 'commander' }))];
  const directory = path.dirname(cloudSessionFileFor(uid, conv.session_id));
  const prefix = `gmember-${conv.conversation_id}-`;
  let names: string[] = [];
  try { names = fs.readdirSync(directory); } catch { return entries; }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.jsonl')) continue;
    const actor = name.slice(prefix.length, -6);
    entries.push(...extractAgentEntries(readSessionJsonl(uid, name.slice(0, -6)))
      .map((entry) => ({ ...entry, actor })));
  }
  return entries;
}

/** Oldest task first, then oldest whole message. Token scans are linear in
 * rendered input size; deletion never rescans all remaining message bodies. */
function fitTranscript(sections: ConvSection[], considered: number, agentId: string, sinceMs: number, maxTokens: number): TranscriptResult {
  if (!sections.length) return _empty();
  const budget = Number.isFinite(maxTokens) ? Math.max(0, Math.min(MAX_TOKENS, Math.floor(maxTokens))) : 0;
  const created = (section: ConvSection) => {
    const ts = Date.parse(section.conv.created_at);
    return Number.isFinite(ts) ? ts : section.entries[0].ts;
  };
  sections.sort((a, b) => created(a) - created(b) || a.conv.conversation_id.localeCompare(b.conv.conversation_id));
  const actor = agentId === '_default' ? 'commander' : agentId;
  const header = `## Task conversations for ${actor} (activity since ${_fmtSinceLabel(sinceMs)}; earlier dialogue included)\n\n`;
  const omission = '[Earlier messages omitted to fit the reflection input budget.]\n\n';
  const rows = sections.map((section) => {
    const heading = formatConvSection({ ...section, entries: [] }) + '\n\n';
    const messages = section.entries.map((entry) => renderEntry(entry) + '\n\n');
    return { heading, headingCost: estimateBudgetTokenQuarters(heading), messages,
      costs: messages.map((text) => estimateBudgetTokenQuarters(text)), start: 0 };
  });
  let quarters = estimateBudgetTokenQuarters(header) + rows.reduce((sum, row) =>
    sum + row.headingCost + row.costs.reduce((a, b) => a + b, 0), 0) - 2; // Final two newlines are not emitted.
  let removed = false;
  if (quarters > budget * 4) {
    quarters += estimateBudgetTokenQuarters(omission);
    for (const row of rows) {
      while (row.start < row.messages.length && quarters > budget * 4) {
        quarters -= row.costs[row.start++];
        removed = true;
        if (row.start === row.messages.length) quarters -= row.headingCost;
      }
      if (quarters <= budget * 4) break;
    }
  }
  const kept = rows.filter((row) => row.start < row.messages.length);
  const dropped = Math.max(0, considered - sections.length) + rows.filter((row) => row.start > 0).length;
  if (!kept.length) return { ..._result('', considered, 0, dropped), capacityExceeded: true };
  const text = (header + (removed ? omission : '') + kept.map((row) =>
    row.heading + row.messages.slice(row.start).join('')).join('')).trimEnd();
  return _result(text, considered, kept.length, dropped);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function _fmtSinceLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function _empty(): TranscriptResult {
  return { text: '', stats: { convsConsidered: 0, convsIncluded: 0, convsTruncated: 0, estimatedTokens: 0 } };
}

function _result(text: string, considered: number, included: number, truncated: number): TranscriptResult {
  const estimatedTokens = estimateTokens(text);
  if (truncated > 0) {
    log.info(`transcript: ${included}/${considered} convs included, ${truncated} omitted or cropped (caps), ~${estimatedTokens} tokens`);
  }
  return { text, stats: { convsConsidered: considered, convsIncluded: included, convsTruncated: truncated, estimatedTokens } };
}

// ── Test seam ───────────────────────────────────────────────────────────

export const _internals = {
  fitTranscript,
  parseMsgWrapper,
  extractUserEntries,
  extractAgentEntries,
  renderSignalEntry,
  formatConvSection,
  renderEntry,
  formatTs,
};
