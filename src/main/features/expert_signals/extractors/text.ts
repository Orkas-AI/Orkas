/**
 * T1 text-rule extractors: accept (silent + explicit) / correction / reject / edit.
 *
 * Pure functions: input is the agent's last final text + the user's reply
 * text + context (cid/aid/turn_id/msg_ids); output is `SignalInput[]` ready
 * to hand to `emitSignal`. No FS, no IO, no LLM.
 *
 * Why pure: the bus.ts turn-end hook owns chokepoint identity (uid + cid +
 * actor + turn_id); the extractor only needs raw text. Keeps extractors
 * testable with simple fixtures and the chokepoint logic small.
 */

import * as crypto from 'node:crypto';

import type { SignalInput, SignalContextRef } from '../types';
import { EXTRACTOR_VERSION } from '../types';

// NOTE on `#core-agent`: this extractor used to re-export `detectUserCorrection`
// for convenience, but a top-level `import { detectUserCorrection } from '#core-agent'`
// transitively loads pi-ai at module-evaluation time and trips
// `ERR_PACKAGE_PATH_NOT_EXPORTED` (PC/CLAUDE.md §3). The caller (`turn_hooks.ts`)
// runs the heuristic via dynamic `await import('#core-agent')` and passes the
// boolean in as `correction_detected` — no import here.

// ── User-message classifier patterns ────────────────────────────────────

/** Explicit-acceptance patterns. Kept narrow on purpose — only phrases
 *  whose ONLY semantic role is acceptance count. "好" alone is too noisy
 *  (matches "好像 / 好处 / 好奇"); anchor on a terminator (punctuation,
 *  whitespace, or EOL) right after the accept word. */
const ACCEPT_EXPLICIT_RE = [
  /^好的?(?:[，。！.!\s]|$)/,
  /^OK(?:[，。！.!\s]|$)/i,
  /^对的?(?:[，。！.!\s]|$)/,
  /^可以(?:[，。！.!\s]|$)/,
  /^收到(?:[，。！.!\s]|$)/,
  /\bok[,!.]?\s*(thanks|thx)?\s*$/i,
  /\b(sounds|looks)\s+good\b/i,
  /\bperfect\b/i,
];

/** Reject patterns — stronger than correction; user wants the whole attempt
 *  discarded. Some words ("重新") also fire correction; that's intentional —
 *  a single message can carry both signals, downstream merges by turn_id. */
const REJECT_RE = [
  /重新(做|来|开始)/,
  /算了/,
  /不要(这个|这样|做了)/,
  /放弃/,
  /\bstart\s+over\b/i,
  /\bnevermind\b/i,
  /\bforget\s+(it|that)\b/i,
];

// ── Public extractor ────────────────────────────────────────────────────

export interface TextExtractInput {
  cid: string;
  aid: string | null;
  turn_id: string;
  /** Agent's most recent final text in this conv (string before the user
   *  reply). Empty string when this is the conv's very first user turn. */
  agent_last_text: string;
  /** User's current message text (the one that closed the turn). */
  user_msg: string;
  /** Message ids contextualizing this signal (typically [agent_msg_id, user_msg_id]). */
  msg_ids: string[];
  /** Pre-computed `detectUserCorrection` result. Pass through from the
   *  bus turn-end hook so the same boolean drives both the `correction`
   *  signal here AND the RunMetrics `userCorrections+=1` in runner.ts —
   *  no double-judgment, no drift between the two. */
  correction_detected: boolean;
}

/**
 * Extract zero or more text-class signals from a (agent_text, user_msg)
 * pair. Caller (bus.ts turn-end hook) is responsible for picking which
 * pair to feed; this function does not look at history.
 *
 * Multiple signal types can fire simultaneously (e.g. user says "不对，
 * 重新做" → correction + reject). Downstream merges by turn_id.
 *
 * `accept(silent)` is NOT emitted here — it's a delayed signal that fires
 * only when N minutes pass with no further user message. Bus owns that
 * timer; see `silence.ts` for the analogous handling.
 */
export function extractTextSignals(input: TextExtractInput): SignalInput[] {
  const out: SignalInput[] = [];
  const userMsg = input.user_msg || '';
  if (!userMsg.trim()) return out;

  const ref: SignalContextRef = { msg_ids: input.msg_ids };
  const base = {
    cid: input.cid,
    aid: input.aid,
    turn_id: input.turn_id,
    source: 'event' as const,
    extractor_version: EXTRACTOR_VERSION.text,
    context_ref: ref,
  };
  const post = { user_msg: _truncate(userMsg, 200) };
  const pre = input.agent_last_text ? {
    text_hash: _sha1(input.agent_last_text),
    text_excerpt: _truncate(input.agent_last_text, 200),
  } : undefined;

  if (input.correction_detected) {
    out.push({
      ...base, type: 'correction', pre, post,
      delta: { matched_patterns: ['correction-heuristic'] },
    });
  }

  const rejectMatches = _matchedPatterns(userMsg, REJECT_RE);
  if (rejectMatches.length) {
    out.push({
      ...base, type: 'reject', pre, post,
      delta: { matched_patterns: rejectMatches },
    });
  }

  const acceptMatches = _matchedPatterns(userMsg, ACCEPT_EXPLICIT_RE);
  // Don't double-emit accept on a message that's also correction / reject —
  // those signals are stronger; an "好的" prefix doesn't override "重新做".
  if (acceptMatches.length && !input.correction_detected && !rejectMatches.length) {
    out.push({
      ...base, type: 'accept', pre, post,
      delta: { matched_patterns: acceptMatches },
      metadata: { variant: 'explicit' },
    });
  }

  // Edit signal: only when there's an agent_last_text to diff against AND
  // the user message isn't already covered by correction / reject (which
  // already encode "user pushed back").
  if (input.agent_last_text && !input.correction_detected && !rejectMatches.length) {
    const editClassification = _classifyEdit(input.agent_last_text, userMsg);
    if (editClassification) {
      out.push({
        ...base, type: 'edit', pre, post,
        delta: editClassification,
      });
    }
  }

  return out;
}

// ── Internals ───────────────────────────────────────────────────────────

/** Classify the user message as an edit of the agent's last text, or skip
 *  (returns null) if it looks like a fresh turn / question rather than an
 *  edit.
 *
 *  Heuristics (intentionally simple; phase 1 LLM pass can correct false
 *  positives — see plan §3.3 P0 source 'event_then_semantic'):
 *    - user msg length is within [30%, 200%] of agent's text → plausibly
 *      a rewrite (not a one-liner question)
 *    - char-level Levenshtein distance > 20 (skip near-identical echoes)
 *    - common prefix or sequence with agent text > 10 chars (some overlap;
 *      a fully fresh question would have ~0 overlap)
 */
function _classifyEdit(agentText: string, userMsg: string): { edit_distance: number; edit_type: 'minor' | 'major_rewrite' } | null {
  const aLen = agentText.length;
  const uLen = userMsg.length;
  if (uLen < aLen * 0.3 || uLen > aLen * 2) return null;
  const dist = _levenshtein(agentText.slice(0, 400), userMsg.slice(0, 400));
  if (dist <= 20) return null;
  if (_overlapChars(agentText, userMsg) < 10) return null;
  return {
    edit_distance: dist,
    edit_type: dist < aLen * 0.4 ? 'minor' : 'major_rewrite',
  };
}

/** Pattern→match list (returns the pattern's source string for each hit). */
function _matchedPatterns(text: string, patterns: RegExp[]): string[] {
  const out: string[] = [];
  for (const re of patterns) {
    if (re.test(text)) out.push(re.source);
  }
  return out;
}

/** Standard iterative two-row Levenshtein. Bounded to 400 chars in caller. */
function _levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Length of the longest common prefix-style overlap. Crude but fast —
 *  good enough for the edit classifier's "some shared text" check. */
function _overlapChars(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function _sha1(s: string): string {
  return 'sha1:' + crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function _truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}
