/**
 * Skill metrics — phase 1 consumer of expert_signals.
 *
 * Aggregates the four skill-related signal kinds emitted in phase 0
 * (`skill_advertised` / `skill_invoked` / `correction` + `edit` /
 * `skill_ineffective`) into a per-skill dashboard row. Surfaces three
 * indicators per Common/docs/evaluation/skill_dynamic_evaluation.md:
 *
 *   - **invocation_rate** = invoked / advertised
 *     "When the skill is in the system prompt, how often does the agent
 *     actually read it?"
 *   - **modified_after_hit_rate** = mod / invoked
 *     "When the skill is read, how often does the user react with a
 *     correction / edit in the same turn?"
 *   - **ineffective_rate** = ineffective / invoked
 *     "When the skill is read, how often does the turn end with a
 *     non-transient error?" (negative-transfer proxy via the new T0
 *     `skill_ineffective` signal — `expert-signals-skill-ineffective.md`.)
 *
 * Aggregation key is `(skill_id, skill_system)` — v0 ignores `aid`
 * (per-agent drill-down deferred). Rationale: the user's primary
 * question is "is this skill paying off?", which is a per-skill answer.
 * Per-agent breakdown can be re-added when actually requested.
 *
 * Display name resolution falls through `listSkills()` (covers A.custom +
 * A.platform via the SkillLoader cache); B-system skills (agent self-
 * evolved) fall back to `skill_id` since their id == name by convention
 * (CLAUDE.md §6).
 */

import { querySignals } from './expert_signals';
import { listSkills } from './skills';
import type { Signal } from './expert_signals/types';
import type { SkillSystem } from './expert_signals/types';
import { createLogger } from '../logger';

const log = createLogger('skill-metrics');

const DEFAULT_DAYS = 7;
const QUERY_HARD_LIMIT = 10_000;

export interface SkillMetricRow {
  skill_id: string;
  skill_system: SkillSystem;
  display_name: string;
  advertised: number;
  invoked: number;
  invocation_rate: number;            // invoked / max(advertised, 1)
  modified_after_hit: number;
  modified_after_hit_rate: number;    // modified_after_hit / max(invoked, 1)
  ineffective: number;
  ineffective_rate: number;           // ineffective / max(invoked, 1)
}

export interface SkillMetricsReport {
  range: { since: string; until: string };
  rows: SkillMetricRow[];
  total_signals_scanned: number;
}

export interface SkillMetricsOpts {
  /** Window size in days ending now. Defaults to 7. */
  sinceDays?: number;
}

export async function aggregateSkillMetrics(
  opts: SkillMetricsOpts = {},
): Promise<SkillMetricsReport> {
  const days = Math.max(1, opts.sinceDays ?? DEFAULT_DAYS);
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();

  let signals: Signal[];
  try {
    signals = await querySignals({
      since: sinceIso,
      until: untilIso,
      types: ['skill_advertised', 'skill_invoked', 'correction', 'edit', 'skill_ineffective'],
      limit: QUERY_HARD_LIMIT,
    });
  } catch (err) {
    log.warn(`querySignals failed: ${(err as Error).message}`);
    return { range: { since: sinceIso, until: untilIso }, rows: [], total_signals_scanned: 0 };
  }

  // Per-skill counts keyed by `${system}::${skill_id}` — `::` is safe
  // because neither system labels (A.custom / A.platform / B) nor skill
  // ids (kebab / snake / 12-hex per CLAUDE.md §6) contain it.
  const advert = new Map<string, number>();
  const invoke = new Map<string, number>();
  const ineffective = new Map<string, number>();
  // Per-turn JOIN side: which skills were invoked, and did the user
  // react with a correction/edit?
  const turnInvokes = new Map<string, Set<string>>();
  const turnHadReaction = new Set<string>();

  for (const sig of signals) {
    if (sig.type === 'skill_advertised') {
      const system = sig.delta?.system;
      const ids = sig.delta?.skill_ids;
      if (!system || !ids) continue;
      for (const id of ids) {
        const k = `${system}::${id}`;
        advert.set(k, (advert.get(k) || 0) + 1);
      }
    } else if (sig.type === 'skill_invoked') {
      const system = sig.delta?.system;
      const id = sig.delta?.skill_id;
      if (!system || !id) continue;
      const k = `${system}::${id}`;
      invoke.set(k, (invoke.get(k) || 0) + 1);
      // Buffer for the per-turn JOIN below.
      let set = turnInvokes.get(sig.turn_id);
      if (!set) { set = new Set(); turnInvokes.set(sig.turn_id, set); }
      set.add(k);
    } else if (sig.type === 'correction' || sig.type === 'edit') {
      turnHadReaction.add(sig.turn_id);
    } else if (sig.type === 'skill_ineffective') {
      const system = sig.delta?.system;
      const id = sig.delta?.skill_id;
      if (!system || !id) continue;
      const k = `${system}::${id}`;
      ineffective.set(k, (ineffective.get(k) || 0) + 1);
    }
  }

  // Modified-after-hit JOIN: a turn with both `skill_invoked` and one
  // of (correction | edit) credits every skill invoked in that turn.
  // Over-attributes on purpose when multiple skills load in one turn —
  // the alternative is causal attribution we don't have.
  const modifiedAfterHit = new Map<string, number>();
  for (const [turn_id, keys] of turnInvokes) {
    if (!turnHadReaction.has(turn_id)) continue;
    for (const k of keys) {
      modifiedAfterHit.set(k, (modifiedAfterHit.get(k) || 0) + 1);
    }
  }

  // Display-name lookup — listSkills() is mtime-cached per directory
  // (features/skills.ts:_skillDirStamp) so this is cheap. Returns the
  // SKILL.md frontmatter `name`; falls back to skill_id when the entry
  // is missing (B-system skills, freshly-uninstalled platform skills).
  const nameMap = new Map<string, string>();
  try {
    const skills = await listSkills();
    for (const s of skills) nameMap.set(s.id, s.name || s.id);
  } catch (err) {
    log.warn(`listSkills failed (display names will fall back to ids): ${(err as Error).message}`);
  }

  const keys = new Set<string>([...advert.keys(), ...invoke.keys(), ...ineffective.keys()]);
  const rows: SkillMetricRow[] = [];
  for (const k of keys) {
    const [system, id] = _decodeKey(k);
    const ad = advert.get(k) || 0;
    const iv = invoke.get(k) || 0;
    const moh = modifiedAfterHit.get(k) || 0;
    const ineff = ineffective.get(k) || 0;
    rows.push({
      skill_id: id,
      skill_system: system,
      display_name: nameMap.get(id) || id,
      advertised: ad,
      invoked: iv,
      invocation_rate: ad > 0 ? iv / ad : 0,
      modified_after_hit: moh,
      modified_after_hit_rate: iv > 0 ? moh / iv : 0,
      ineffective: ineff,
      ineffective_rate: iv > 0 ? ineff / iv : 0,
    });
  }

  // Sort heuristic: surface "dead weight" first (advertised a lot,
  // invoked little). Ties broken by skill_id for deterministic output.
  rows.sort((a, b) =>
    (b.advertised - b.invoked) - (a.advertised - a.invoked)
    || a.skill_id.localeCompare(b.skill_id)
  );

  return {
    range: { since: sinceIso, until: untilIso },
    rows,
    total_signals_scanned: signals.length,
  };
}

function _decodeKey(k: string): [SkillSystem, string] {
  const i = k.indexOf('::');
  return [k.slice(0, i) as SkillSystem, k.slice(i + 2)];
}
