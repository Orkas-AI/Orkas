/**
 * T0 event extractors: retry / skip / form_left_blank / tool_failure.
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

// ── retry / skip ────────────────────────────────────────────────────────

/** User clicked the plan rail "Retry" button on a failed step. */
export function buildRetrySignal(args: {
  cid: string;
  aid: string;
  turn_id: string;
  step_index: number;
  msg_ids?: string[];
}): SignalInput {
  return {
    type: 'retry',
    source: 'event',
    cid: args.cid,
    aid: args.aid,
    turn_id: args.turn_id,
    context_ref: { msg_ids: args.msg_ids || [] },
    extractor_version: EXTRACTOR_VERSION.event,
    metadata: { step_index: args.step_index },
  };
}

/** User clicked plan rail "Skip" — a weaker form of retry. */
export function buildSkipSignal(args: {
  cid: string;
  aid: string;
  turn_id: string;
  step_index: number;
  msg_ids?: string[];
}): SignalInput {
  return {
    type: 'skip',
    source: 'event',
    cid: args.cid,
    aid: args.aid,
    turn_id: args.turn_id,
    context_ref: { msg_ids: args.msg_ids || [] },
    extractor_version: EXTRACTOR_VERSION.event,
    metadata: { step_index: args.step_index },
  };
}

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

// ── agent_dispatched ────────────────────────────────────────────────────

/** Commander's dispatch decision for a single ready-group: which agent ids
 *  were considered (`candidates`) and which got woken (`dispatched`). In the
 *  current plan executor model the two are identical (plan_set already
 *  filtered) — kept distinct in schema so phase 1 commander LLM can record
 *  "considered but rejected" without a schema migration. */
export function buildAgentDispatchedSignal(args: {
  cid: string;
  turn_id: string;
  candidates: string[];
  dispatched: string[];
  parallel_group: string | null;
  msg_ids?: string[];
}): SignalInput {
  return {
    type: 'agent_dispatched',
    source: 'event',
    cid: args.cid,
    aid: null,
    turn_id: args.turn_id,
    context_ref: { msg_ids: args.msg_ids || [] },
    extractor_version: EXTRACTOR_VERSION.agent_dispatch,
    delta: {
      candidates: args.candidates.slice(),
      dispatched: args.dispatched.slice(),
      parallel_group: args.parallel_group,
    },
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
