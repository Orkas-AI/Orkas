/**
 * T0 event extractors: form_left_blank / tool_failure / skill_* attribution.
 * (The plan-rail retry / skip / agent_dispatched builders were deleted
 * 2026-08-16 — their emitting UI went with the G8b plan-rail removal.)
 *
 * Pure builders — each function takes the structured event payload and
 * returns one (or more) `SignalInput`. The caller (IPC handler / bus
 * turn-end hook) emits.
 *
 * Why not just inline JSON literals at the chokepoints: keeping the field
 * shape here means schema evolution (e.g. adding `extractor_version` to
 * every signal) is a one-file change; chokepoint callers just hand over
 * raw payloads.
 */

import type { SignalInput, SkillSystem, SkillInvokeTrigger } from '../types';
import { EXTRACTOR_VERSION } from '../types';

// ── form_left_blank ─────────────────────────────────────────────────────

export interface FormFieldDef {
  id: string;
  required?: boolean;
  default?: unknown;
  type?: string;
}

/**
 * Emit one signal per field that the user "didn't change" on submit.
 *
 *   - required field with empty value → `was_required=true`
 *   - non-required field whose value matches `default` → `was_required=false`
 *
 *  The phase-1 patch suggester reads these to recommend dropping fields
 *  the user never touches.
 */
export function buildFormLeftBlankSignals(args: {
  cid: string;
  aid: string;
  turn_id: string;
  msg_id: string;
  fields: FormFieldDef[];
  values: Record<string, unknown>;
}): SignalInput[] {
  const out: SignalInput[] = [];
  for (const field of args.fields) {
    const submitted = args.values[field.id];
    const isBlank = _looksBlank(submitted);
    const isDefault = !isBlank && _equals(submitted, field.default);
    if (!isBlank && !isDefault) continue;
    out.push({
      type: 'form_left_blank',
      source: 'event',
      cid: args.cid,
      aid: args.aid,
      turn_id: args.turn_id,
      context_ref: { msg_ids: [args.msg_id] },
      extractor_version: EXTRACTOR_VERSION.event,
      metadata: {
        input_id: field.id,
        was_required: !!field.required,
        used_default: isDefault,
      },
    });
  }
  return out;
}

// ── tool_failure ────────────────────────────────────────────────────────

/** A tool call returned `isError=true` that the agent didn't subsequently
 *  recover from in the same turn. Caller decides recovery semantics. */
export function buildToolFailureSignal(args: {
  cid: string;
  aid: string | null;
  turn_id: string;
  tool_name: string;
  error_excerpt: string;
  msg_ids?: string[];
}): SignalInput {
  return {
    type: 'tool_failure',
    source: 'event',
    cid: args.cid,
    aid: args.aid,
    turn_id: args.turn_id,
    context_ref: { msg_ids: args.msg_ids || [] },
    extractor_version: EXTRACTOR_VERSION.event,
    metadata: {
      tool_name: args.tool_name,
      error_excerpt: args.error_excerpt.slice(0, 200),
    },
  };
}

// ── skill_advertised / skill_invoked ────────────────────────────────────

/** One signal per (system) per turn carrying every advertised skill id from
 *  that catalog. The bus drains its per-turn buffer at turn-end and groups
 *  by `system` so a single advertised signal covers all of A.custom (or
 *  A.platform / B); consumers union over signals to get the full advertised
 *  set for the turn. */
export function buildSkillAdvertisedSignal(args: {
  cid: string;
  aid: string | null;
  turn_id: string;
  system: SkillSystem;
  skill_ids: string[];
  msg_ids?: string[];
}): SignalInput {
  return {
    type: 'skill_advertised',
    source: 'event',
    cid: args.cid,
    aid: args.aid,
    turn_id: args.turn_id,
    context_ref: { msg_ids: args.msg_ids || [] },
    extractor_version: EXTRACTOR_VERSION.skill_attribution,
    delta: { system: args.system, skill_ids: args.skill_ids.slice() },
  };
}

/** Emitted at turn-end when a `skill_invoked` happened AND the turn ended
 *  with a non-transient, non-aborted error. One signal per (turn, system,
 *  skill_id) — same granularity as `skill_invoked` so consumers can JOIN
 *  the two directly. `error_kind` is hardcoded `'permanent'` for v0; a
 *  future session-jsonl scanner could refine to `'mixed'` when some tool
 *  calls in the same turn succeeded. */
export function buildSkillIneffectiveSignal(args: {
  cid: string;
  aid: string | null;
  turn_id: string;
  system: SkillSystem;
  skill_id: string;
  error_excerpt: string;
  msg_ids?: string[];
}): SignalInput {
  return {
    type: 'skill_ineffective',
    source: 'event',
    cid: args.cid,
    aid: args.aid,
    turn_id: args.turn_id,
    context_ref: { msg_ids: args.msg_ids || [] },
    extractor_version: EXTRACTOR_VERSION.skill_attribution,
    delta: { system: args.system, skill_id: args.skill_id },
    metadata: {
      error_excerpt: args.error_excerpt.slice(0, 200),
      error_kind: 'permanent',
    },
  };
}

/** Emitted when the agent's `read_file` resolves to a SKILL.md path inside
 *  one of the three skill roots. Same turn can produce multiple invoked
 *  signals for distinct skills; consumers de-dup by (turn_id, system, skill_id). */
export function buildSkillInvokedSignal(args: {
  cid: string;
  aid: string | null;
  turn_id: string;
  system: SkillSystem;
  skill_id: string;
  trigger: SkillInvokeTrigger;
  msg_ids?: string[];
}): SignalInput {
  return {
    type: 'skill_invoked',
    source: 'event',
    cid: args.cid,
    aid: args.aid,
    turn_id: args.turn_id,
    context_ref: { msg_ids: args.msg_ids || [] },
    extractor_version: EXTRACTOR_VERSION.skill_attribution,
    delta: { system: args.system, skill_id: args.skill_id, trigger: args.trigger },
  };
}

// ── helpers ─────────────────────────────────────────────────────────────

function _looksBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function _equals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => x === b[i]);
  }
  return false;
}
