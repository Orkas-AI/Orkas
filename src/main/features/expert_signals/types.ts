/**
 * Expert signals — shared types.
 *
 * Signals are user-behavior records produced at known chokepoints (bus
 * turn-end / retry-skip IPC / form submit / silence timer). They feed
 * downstream reflection / patch suggester / critic (phase 1+). Each signal
 * is a single jsonl line under `<uid>/local/signals/<yyyy-mm-dd>.jsonl`.
 *
 * See `docs/plans/expert-signals-phase-0.md` for the rule catalog.
 */

/** Phase 0 signal kinds (T0 system events + T1 text rules).
 *  Phase 1 adds T2 semantic kinds (accept_with_caveat / domain_constraint_revealed / …).
 *  When adding a new T0/T1 kind: extend this union, add an extractor case,
 *  add a positive + negative fixture (CLAUDE.md §9). */
export type SignalType =
  | 'retry'              // T0: plan rail "Retry" clicked
  | 'skip'               // T0: plan rail "Skip" clicked
  | 'form_left_blank'    // T0: required field unfilled / default unchanged on submit
  | 'silence'            // T0: agent message followed by ≥ N min of no user response
  | 'tool_failure'       // T0: session jsonl has tool_result.isError=true unrecovered
  | 'accept'             // T1: silent or explicit acceptance of agent output
  | 'correction'         // T1: user message matched correction patterns
  | 'reject'             // T1: user message matched rejection patterns
  | 'edit';              // T1: user message token-diffed significantly from agent's last text

/** Source layer of the extractor. Phase 0 is all `event`; phase 1 adds
 *  semantic and `event_then_semantic` (LLM-corrected event signal). */
export type SignalSource = 'event' | 'semantic' | 'event_then_semantic';

/** Per-signal extractor version stamp. Bump per extractor when the rule
 *  changes meaningfully so downstream consumers can re-process / segregate
 *  by version. */
export const EXTRACTOR_VERSION = {
  event: 'event@1.0',
  text:  'text@1.0',
  silence: 'silence@1.0',
} as const;

export interface SignalDelta {
  /** Levenshtein-ish character distance between pre and post text. */
  edit_distance?: number;
  /** Patterns that matched (e.g. `['不对', '应该']`). */
  matched_patterns?: string[];
  /** Coarse classifier for downstream rerank. */
  edit_type?: 'minor' | 'major_rewrite';
}

export interface SignalContextRef {
  /** Group-chat message ids that contextualize this signal. Downstream uses
   *  this to reconstruct an episode without storing the full text here. */
  msg_ids: string[];
}

export interface SignalTextSlice {
  /** sha1 of the full text — for dedup / fingerprinting. */
  text_hash?: string;
  /** First 200 chars; full text remains in `<cid>.jsonl`. */
  text_excerpt?: string;
  /** For text-class signals: the user message that triggered the rule. */
  user_msg?: string;
}

export interface Signal {
  /** sig_<uuid>. */
  id: string;
  /** ISO 8601 timestamp at emit time. */
  ts: string;
  type: SignalType;
  source: SignalSource;
  cid: string;
  /** Agent-id the signal is attributed to. `null` = commander-scope. */
  aid: string | null;
  /** Bus turn id; signals from the same turn share this so consumers can
   *  group-by to recover "the correction + edit + accept from this turn". */
  turn_id: string;
  pre?: SignalTextSlice;
  post?: SignalTextSlice;
  delta?: SignalDelta;
  context_ref: SignalContextRef;
  /** Tag of the extractor that produced this signal (see EXTRACTOR_VERSION). */
  extractor_version: string;
  /** Optional kind-specific scratchpad. Avoid putting full text here. */
  metadata?: Record<string, unknown>;
}

/** Filter shape for querySignals. All fields optional; combine = AND. */
export interface SignalFilter {
  since?: string;           // ISO; inclusive
  until?: string;           // ISO; exclusive
  types?: SignalType[];
  aid?: string | null;
  cid?: string;
  turn_id?: string;
  limit?: number;           // default 1000; hard cap 10_000
}

/** New-signal input — `id` and `ts` are filled by emit. */
export type SignalInput = Omit<Signal, 'id' | 'ts'>;
