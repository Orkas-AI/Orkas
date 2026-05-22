/**
 * Chokepoint glue between bus.ts / IPC handlers and the signal extractors.
 *
 * Outer modules (bus, IPC) call these two functions; they do all the
 * emit / cache management internally. Keeps bus.ts free of extractor
 * imports and signal-shape knowledge.
 *
 * In-memory `_lastAgentMsg` cache pairs an agent's final message with the
 * next user reply for text-class signal extraction — avoids a per-user-msg
 * jsonl re-read. App restart clears the cache; the first user reply after
 * restart misses its text signals (acceptable v0 trade-off; phase 1+ can
 * backfill on boot if a consumer needs it).
 */

import { emitSignal } from './index';
import { extractTextSignals } from './extractors/text';
import { buildToolFailureSignal } from './extractors/event';
import {
  scheduleSilenceCheck,
  cancelSilenceCheck,
} from './extractors/silence';
import { createLogger } from '../../logger';

const log = createLogger('expert-signals:hooks');

// `#core-agent` must be loaded with dynamic `await import` — top-level
// static import triggers `ERR_PACKAGE_PATH_NOT_EXPORTED` from pi-ai (no
// `exports` field in its package.json). See PC/CLAUDE.md §3. Lazy singleton
// caches the resolved fn so we pay the import cost once per process.
let _detectFn: ((s: string) => boolean) | null = null;
async function _getDetectUserCorrection(): Promise<(s: string) => boolean> {
  if (_detectFn) return _detectFn;
  const ca = await import('#core-agent');
  _detectFn = ca.detectUserCorrection;
  return _detectFn;
}

interface LastAgentMsg {
  id: string;
  /** Sender actor id — `'commander'` or an agent id; `aid` for the signal
   *  is `null` for commander, the id otherwise. */
  from: string;
  text: string;
}

const _lastAgentMsg = new Map<string, LastAgentMsg>();
function _key(uid: string, cid: string): string { return `${uid}:${cid}`; }

/**
 * Bus calls this AFTER it has enqueued the actor's final message. Handles:
 *   - cache the agent text for the next user reply's text-signal pairing
 *   - emit `tool_failure` when this turn ended with an unrecovered error
 *   - schedule a silence check (cancelled by `onUserMessage` if user replies)
 *
 * v0 simplification: `tool_failure` uses the bus's `errText` summary as a
 * proxy for "unrecovered tool error"; phase 1 will scan the session jsonl
 * for fine-grained `tool_result.isError=true` entries with tool_name.
 */
export function onAgentTurnEnd(args: {
  uid: string;
  cid: string;
  actorId: string;
  isCommander: boolean;
  agentMsg: { id: string; text: string };
  errText?: string;
}): void {
  try {
    const aid = args.isCommander ? null : args.actorId;
    const turn_id = args.agentMsg.id;
    const trimmed = (args.agentMsg.text || '').trim();

    if (trimmed) {
      _lastAgentMsg.set(_key(args.uid, args.cid), {
        id: args.agentMsg.id,
        from: args.actorId,
        text: args.agentMsg.text,
      });
    }

    if (args.errText && args.errText.trim()) {
      emitSignal(args.uid, buildToolFailureSignal({
        cid: args.cid, aid, turn_id,
        tool_name: 'unknown',
        error_excerpt: args.errText,
        msg_ids: [args.agentMsg.id],
      }));
    }

    if (trimmed) {
      scheduleSilenceCheck({
        uid: args.uid, cid: args.cid, aid, turn_id,
        msg_ids: [args.agentMsg.id],
      });
    }
  } catch (err) {
    log.warn(`onAgentTurnEnd threw uid=${args.uid} cid=${args.cid}: ${(err as Error).message}`);
  }
}

/**
 * Bus calls this when a user message has been enqueued. Handles:
 *   - cancel any pending silence check (user replied)
 *   - run `detectUserCorrection` once and extract text-class signals against
 *     the cached last agent message
 *
 * Returns `correctionDetected` so the caller can wire it into the agent's
 * RunMetrics.userCorrections (see plan §6.1: same boolean, two consumers,
 * no double-judgment).
 */
export async function onUserMessage(args: {
  uid: string;
  cid: string;
  userMsg: { id: string; text: string };
}): Promise<{ correctionDetected: boolean }> {
  try {
    cancelSilenceCheck(args.uid, args.cid);
    const prev = _lastAgentMsg.get(_key(args.uid, args.cid));
    if (!prev) return { correctionDetected: false };

    const detect = await _getDetectUserCorrection();
    const correctionDetected = detect(args.userMsg.text);

    const signals = extractTextSignals({
      cid: args.cid,
      aid: prev.from === 'commander' ? null : prev.from,
      turn_id: prev.id,
      agent_last_text: prev.text,
      user_msg: args.userMsg.text,
      msg_ids: [prev.id, args.userMsg.id],
      correction_detected: correctionDetected,
    });
    for (const sig of signals) emitSignal(args.uid, sig);
    return { correctionDetected };
  } catch (err) {
    log.warn(`onUserMessage threw uid=${args.uid} cid=${args.cid}: ${(err as Error).message}`);
    return { correctionDetected: false };
  }
}

/** Test seam — clear in-memory cache between cases. */
export function _clearAgentMsgCache(): void {
  _lastAgentMsg.clear();
}
