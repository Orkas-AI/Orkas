/**
 * Build a chronological activity transcript for reflection.
 *
 * Replaces `reflection-digest.ts` per `docs/plans/reflection-redesign.md`.
 * Reads the target agent's recent conversations, time-interleaves user
 * voice (from gconv) with agent replies (from gmember), injects four
 * system-event signal types (retry / skip / form_left_blank / silence),
 * and applies a double cap (≤5 conversations AND ≤16K tokens).
 *
 * Output is a plain string for the reflection LLM prompt — no aggregation,
 * no structured fields, just light annotation. Reflection LLM judges raw
 * patterns from the text. T0/T1 signals other than the 4 inlined kinds are
 * NOT consumed here (those serve future critic / weekly-review consumers).
 *
 * Pure side-effect-free; safe to call from anywhere with active uid.
 */

import * as fs from 'node:fs';
import { userSessionFile } from '../paths';
import { createLogger } from '../logger';
import { listConversations, type Conversation } from './chats';
import { buildGmemberSessionId } from './group_chat/state';
import { querySignals, type Signal, type SignalType } from './expert_signals';

const log = createLogger('reflection-transcript');

// ── Caps (per plan §2.2) ────────────────────────────────────────────────

export const MAX_CONVS = 5;
export const MAX_TOKENS = 16_000;
export const MAX_AGENT_REPLY_CHARS = 800;
const SYSTEM_EVENT_TYPES: SignalType[] = ['retry', 'skip', 'form_left_blank', 'silence'];

// ── Token estimation (CJK-aware) ────────────────────────────────────────

/** Estimate token count. CJK chars count as ~0.7 token each; other chars
 *  as ~0.25 token (≈4 chars/token English heuristic). Empirically within
 *  ~10% of model tokenizers for mixed Chinese / English text. */
export function estimateTokens(text: string): number {
  // CJK Unified Ideographs (U+4E00–U+9FFF) + Hiragana (U+3040–U+309F)
  // + Katakana (U+30A0–U+30FF) + Hangul Syllables (U+AC00–U+D7AF).
  const cjkChars = (text.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars * 0.7 + otherChars / 4);
}

// ── Internal types ──────────────────────────────────────────────────────

interface TranscriptEntry {
  ts: number;
  kind: 'user' | 'agent' | 'system';
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
 *  intermediate work, not the final user-facing output). Caps each entry
 *  text at MAX_AGENT_REPLY_CHARS. */
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
    let text = texts.join('\n');
    if (text.length > MAX_AGENT_REPLY_CHARS) {
      text = text.slice(0, MAX_AGENT_REPLY_CHARS) + '…(truncated)';
    }
    out.push({ ts: m.ts, kind: 'agent', text });
  }
  return out;
}

/** Render one signal as a synthetic system-event transcript entry. Returns
 *  null when the signal type isn't one of the 4 inlined kinds (defensive —
 *  caller already filters by type). */
function renderSignalEntry(sig: Signal): TranscriptEntry | null {
  const ts = Date.parse(sig.ts);
  if (Number.isNaN(ts)) return null;
  const meta = (sig.metadata || {}) as Record<string, unknown>;
  switch (sig.type) {
    case 'retry':
      return { ts, kind: 'system', text: `user clicked retry on step #${meta.step_index ?? '?'}` };
    case 'skip':
      return { ts, kind: 'system', text: `user clicked skip on step #${meta.step_index ?? '?'}` };
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
  try { file = userSessionFile(uid, sessionId); } catch { return []; }
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
  return `[${ts} ${e.kind}]\n${e.text}`;
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
 * @param sinceMs   lower bound for activity inclusion (typically lastReflectedAt epoch ms)
 */
export async function buildTranscript(
  uid: string,
  agentId: string,
  sinceMs: number,
): Promise<TranscriptResult> {
  const isDefault = agentId === '_default';

  let convs: Conversation[] = [];
  try { convs = await listConversations(uid); }
  catch (err) {
    log.warn(`listConversations failed uid=${uid}: ${(err as Error).message}`);
    return _empty();
  }

  const matched = convs.filter((c) => {
    const a = c.agent_id || '';
    return isDefault ? !a : a === agentId;
  });
  if (!matched.length) return _empty();

  // Single signal query covers the whole window; we partition by cid below.
  // For `_default` we pass `aid: null` (commander-scope signals like
  // agent_dispatched are filtered out by the SYSTEM_EVENT_TYPES whitelist
  // anyway, so a permissive aid filter for _default is fine).
  let windowSignals: Signal[] = [];
  try {
    windowSignals = await querySignals({
      since: new Date(sinceMs).toISOString(),
      types: SYSTEM_EVENT_TYPES,
      ...(isDefault ? {} : { aid: agentId }),
    });
  } catch (err) {
    log.warn(`querySignals failed: ${(err as Error).message}`);
  }

  const sections: ConvSection[] = [];
  for (const conv of matched) {
    const gconvMsgs = readSessionJsonl(uid, conv.session_id);
    if (!gconvMsgs.length) continue;

    // Activity gate: skip conv whose newest msg predates the window.
    const maxTs = gconvMsgs.reduce((acc, m) => Math.max(acc, typeof m.ts === 'number' ? m.ts : 0), 0);
    if (maxTs < sinceMs) continue;

    const userEntries = extractUserEntries(gconvMsgs).filter((e) => e.ts >= sinceMs);

    let agentEntries: TranscriptEntry[];
    if (isDefault) {
      // No agent worker — commander's reply IS the response shown to user.
      agentEntries = extractAgentEntries(gconvMsgs).filter((e) => e.ts >= sinceMs);
    } else {
      const gmemberSid = buildGmemberSessionId(conv.conversation_id, agentId);
      const gmemberMsgs = readSessionJsonl(uid, gmemberSid);
      agentEntries = extractAgentEntries(gmemberMsgs).filter((e) => e.ts >= sinceMs);
    }

    const sigEntries = windowSignals
      .filter((s) => s.cid === conv.conversation_id)
      .map(renderSignalEntry)
      .filter((e): e is TranscriptEntry => e !== null)
      .filter((e) => e.ts >= sinceMs);

    const entries = [...userEntries, ...agentEntries, ...sigEntries]
      .sort((a, b) => a.ts - b.ts);

    if (!entries.length) continue;
    sections.push({ conv, entries });
  }

  if (!sections.length) return _empty();

  // Sort by most-recent-activity desc and apply MAX_CONVS cap.
  sections.sort((a, b) => _lastTs(b) - _lastTs(a));
  const convsConsidered = sections.length;
  let convsTruncated = Math.max(0, sections.length - MAX_CONVS);
  let kept = sections.slice(0, MAX_CONVS);

  // Render in chronological order (oldest first) and drop oldest sections
  // until token budget is met. Always keep at least one section (the most
  // recent) so a single oversized conv still produces output rather than ''.
  kept.sort((a, b) => _lastTs(a) - _lastTs(b));

  const sinceLabel = _fmtSinceLabel(sinceMs);
  const header = `## Activity since ${sinceLabel}`;

  while (kept.length > 1) {
    const full = `${header}\n\n${kept.map(formatConvSection).join('\n\n')}`;
    if (estimateTokens(full) <= MAX_TOKENS) {
      return _result(full, convsConsidered, kept.length, convsTruncated);
    }
    kept.shift();
    convsTruncated += 1;
  }

  // Single section remaining — emit even if it exceeds budget (logged).
  const full = `${header}\n\n${formatConvSection(kept[0])}`;
  const tokens = estimateTokens(full);
  if (tokens > MAX_TOKENS) {
    log.warn(`transcript exceeds token cap: ${tokens} > ${MAX_TOKENS} (single conv ${kept[0].conv.conversation_id} kept)`);
  }
  return _result(full, convsConsidered, kept.length, convsTruncated);
}

// ── Helpers ─────────────────────────────────────────────────────────────

function _lastTs(s: ConvSection): number {
  return s.entries[s.entries.length - 1].ts;
}

function _fmtSinceLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

function _empty(): TranscriptResult {
  return { text: '', stats: { convsConsidered: 0, convsIncluded: 0, convsTruncated: 0, estimatedTokens: 0 } };
}

function _result(text: string, considered: number, included: number, truncated: number): TranscriptResult {
  const estimatedTokens = estimateTokens(text);
  if (truncated > 0) {
    log.info(`transcript: ${included}/${considered} convs included, ${truncated} dropped (caps), ~${estimatedTokens} tokens`);
  }
  return { text, stats: { convsConsidered: considered, convsIncluded: included, convsTruncated: truncated, estimatedTokens } };
}

// ── Test seam ───────────────────────────────────────────────────────────

export const _internals = {
  parseMsgWrapper,
  extractUserEntries,
  extractAgentEntries,
  renderSignalEntry,
  formatConvSection,
  renderEntry,
  formatTs,
};
