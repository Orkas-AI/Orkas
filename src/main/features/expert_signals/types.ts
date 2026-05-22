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
  | 'edit'               // T1: user message token-diffed significantly from agent's last text
  | 'skill_advertised'   // T0: skills entered system prompt index at turn start (per system)
  | 'skill_invoked'      // T0: agent read_file'd a SKILL.md body during the turn
  | 'skill_ineffective'  // T0: skill_invoked in a turn that ended with a non-transient, non-aborted error
  | 'agent_dispatched';  // T0: commander dispatched ready plan steps (candidates + dispatched)

/** Which skill catalog produced a `skill_advertised` / `skill_invoked` signal.
 *  Three values, not two — `A.custom` (cloud/skills/) and `A.platform`
 *  (local/marketplace/skills/) live at different roots and patch suggester
 *  treats them differently (cloud edit vs marketplace republish). `B` is
 *  the agent's own SkillStore (`cloud/agents/<aid>/skills/`). */
export type SkillSystem = 'A.custom' | 'A.platform' | 'B';

/** How a skill body was reached. Reserved enum — phase 2 template system
 *  may add `subagent_load`. */
export type SkillInvokeTrigger = 'read_file';

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
  skill_attribution: 'skill_attribution@1.0',
  agent_dispatch:    'agent_dispatch@1.0',
} as const;

export interface SignalDelta {
  /** Levenshtein-ish character distance between pre and post text. */
  edit_distance?: number;
  /** Patterns that matched (e.g. `['不对', '应该']`). */
  matched_patterns?: string[];
  /** Coarse classifier for downstream rerank. */
  edit_type?: 'minor' | 'major_rewrite';
  /** Skill source system for skill_advertised / skill_invoked. */
  system?: SkillSystem;
  /** skill_advertised: the full set of ids advertised by this `system` in this turn. */
  skill_ids?: string[];
  /** skill_invoked: which skill was read. (`skill_ids` is plural for advertised; this is singular for invoked.) */
  skill_id?: string;
  /** skill_invoked: how the body was reached. */
  trigger?: SkillInvokeTrigger;
  /** agent_dispatched: ready steps the commander considered this dispatch round (aids). */
  candidates?: string[];
  /** agent_dispatched: subset actually woken in this dispatch round. */
  dispatched?: string[];
  /** agent_dispatched: the parallel_group key (null = solo step). */
  parallel_group?: string | null;
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
  /** The agent message id this signal **reacts to or is produced by**.
   *  - agent-side (`tool_failure / silence / skill_advertised / skill_invoked`):
   *    the agent's own final message id for that turn.
   *  - user-reaction (`correction / reject / accept / edit`):
   *    the previous agent message id being reacted to.
   *  - dispatch (`agent_dispatched`): the commander msg id that produced the
   *    plan_set decision.
   *  - `form_left_blank`: the agent msg id that posted the form.
   *  - `retry / skip`: the source agent msg id of the output being retried
   *    (since 2026-05-19; was synthetic `<cid>:plan:<step>` before — break
   *    rebased; consumers count repeat retries via `metadata.step_index`).
   *  Direct JOIN on `turn_id` recovers cross-signal causality
   *  (skill_invoked × correction, retry × tool_failure, …). See
   *  `docs/plans/expert-signals-skill-attribution.md` §3.4. */
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
