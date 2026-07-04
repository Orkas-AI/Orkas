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
import { isTransientError } from '../../util/transient-errors';
import {
  buildSkillIneffectiveSignal,
  buildToolFailureSignal,
  buildSkillAdvertisedSignal,
  buildSkillInvokedSignal,
} from './extractors/event';
import {
  scheduleSilenceCheck,
  cancelSilenceCheck,
} from './extractors/silence';
import { createLogger } from '../../logger';
import type { SkillSystem, SkillInvokeTrigger } from './types';

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
 * Per-turn skill-attribution buffer. Bus.ts owns one of these per actor
 * turn (see `createSkillTurnBuffer`) and bridges its `record*` methods
 * into ChatOptions.{onSkillAdvertised,onSkillInvoked}. `drainAndEmit`
 * fires at turn-end, after we know the agent message id (= turn_id) but
 * before `onAgentTurnEnd` schedules silence + text-signal pairing.
 *
 * Why a dedicated buffer (not an ad-hoc local in bus.ts): the dedup +
 * skill_advertised group-by-system + signal emission logic shouldn't live
 * inline in bus.ts. Keeping it here matches the chokepoint discipline
 * (PC/CLAUDE.md §4 constraint 9): bus.ts gets callback shims; emit logic
 * stays in expert_signals/.
 */
export interface SkillTurnBuffer {
  recordAdvertised(skill_id: string, system: SkillSystem): void;
  recordInvoked(skill_id: string, system: SkillSystem, trigger: SkillInvokeTrigger): void;
  /** Drain the buffer at turn-end.
   *  - `errText` / `aborted`: when provided, the buffer emits one
   *    `skill_ineffective` per invoked (system, skill_id) iff `errText`
   *    is non-empty, NOT classified transient (network-class blip
   *    excluded), AND `!aborted` (user-stopped turns aren't the skill's
   *    fault). Omitting both keeps the legacy advertised+invoked emit
   *    behaviour. */
  drainAndEmit(args: {
    uid: string; cid: string; aid: string | null;
    turn_id: string; msg_ids: string[];
    errText?: string;
    aborted?: boolean;
  }): void;
}

export function createSkillTurnBuffer(): SkillTurnBuffer {
  // `Set<string>` keyed on `${system}::${skill_id}` — bus may call the
  // recorders multiple times (e.g. ChatOptions wired to two layers); dedup
  // keeps the emitted signal payload clean. Invoked uses the same shape
  // since same SKILL.md can be read more than once per turn.
  const advertised = new Set<string>();
  const invoked = new Set<string>();
  // Compact (system, id) key — `::` is safe because neither component
  // contains `::`: system labels are A.custom / A.platform / B; ids match
  // kebab/snake or 12-hex per CLAUDE.md §6.
  const enc = (sys: SkillSystem, id: string) => sys + '::' + id;
  const dec = (k: string): { system: SkillSystem; skill_id: string } => {
    const i = k.indexOf('::');
    return { system: k.slice(0, i) as SkillSystem, skill_id: k.slice(i + 2) };
  };

  return {
    recordAdvertised(skill_id, system) {
      if (!skill_id) return;
      advertised.add(enc(system, skill_id));
    },
    recordInvoked(skill_id, system /* trigger fixed to 'read_file' for v0 */) {
      if (!skill_id) return;
      invoked.add(enc(system, skill_id));
    },
    drainAndEmit({ uid, cid, aid, turn_id, msg_ids, errText, aborted }) {
      if (!turn_id) {
        // Without a turn id (= agent msg id) the signal can't be joined to
        // anything else — drop instead of emitting a useless record.
        return;
      }
      // skill_advertised: one signal per (system) carrying every id from
      // that catalog. Caller never asks for the dispatch_to msg ids of
      // each individual skill — the group-by-system rollup is the analyst-
      // friendly shape.
      const bySystem = new Map<SkillSystem, string[]>();
      for (const k of advertised) {
        const { system, skill_id } = dec(k);
        const list = bySystem.get(system) || [];
        list.push(skill_id);
        bySystem.set(system, list);
      }
      for (const [system, skill_ids] of bySystem) {
        emitSignal(uid, buildSkillAdvertisedSignal({
          cid, aid, turn_id, system, skill_ids, msg_ids,
        }));
      }
      // skill_invoked: one signal per distinct (system, skill_id). Trigger
      // is fixed to `read_file` in v0 (the only path we hook today); the
      // builder accepts an enum for future template / subagent loads.
      for (const k of invoked) {
        const { system, skill_id } = dec(k);
        emitSignal(uid, buildSkillInvokedSignal({
          cid, aid, turn_id, system, skill_id, trigger: 'read_file', msg_ids,
        }));
      }
      // skill_ineffective: skill was loaded and the turn ended with a
      // non-transient, non-aborted error. One signal per invoked skill
      // — over-attribute on purpose when multiple skills loaded in the
      // same failing turn; downstream consumers (skill_metrics) can
      // weight or filter. See `expert-signals-skill-ineffective.md`.
      const errExcerpt = (errText || '').trim();
      if (
        errExcerpt
        && !aborted
        && !isTransientError(errExcerpt)
        && invoked.size > 0
      ) {
        for (const k of invoked) {
          const { system, skill_id } = dec(k);
          emitSignal(uid, buildSkillIneffectiveSignal({
            cid, aid, turn_id, system, skill_id,
            error_excerpt: errExcerpt,
            msg_ids,
          }));
        }
      }
      advertised.clear();
      invoked.clear();
    },
  };
}

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
