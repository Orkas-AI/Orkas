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
 * Display names are read from the requested account's custom and
 * marketplace roots. B-system skills (agent self-evolved) fall back to
 * `skill_id` since their id == name by convention.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { querySignalsForUser } from './expert_signals';
import { parseSkillFrontmatter } from './skills';
import type { Signal } from './expert_signals/types';
import type { SkillSystem } from './expert_signals/types';
import { createLogger } from '../logger';
import { userMarketplaceSkillsDir, userSkillsDir } from '../paths';
import { logErrorSummary } from '../util/log-redact';

const log = createLogger('skill-metrics');

const DEFAULT_DAYS = 7;
const QUERY_HARD_LIMIT = 10_000;

export interface SkillMetricRow {
  skill_id: string;
  skill_system: SkillSystem;
  display_name: string;
  health_status: SkillHealthStatus;
  health_score: number;
  findings: string[];
  recommendation: string;
  advertised: number;
  invoked: number;
  invocation_rate: number;            // invoked / max(advertised, 1)
  modified_after_hit: number;
  modified_after_hit_rate: number;    // modified_after_hit / max(invoked, 1)
  ineffective: number;
  ineffective_rate: number;           // ineffective / max(invoked, 1)
}

export type SkillHealthStatus =
  | 'healthy'
  | 'underused'
  | 'needs_review'
  | 'ineffective'
  | 'insufficient_data';

export interface SkillMetricsReport {
  range: { since: string; until: string };
  rows: SkillMetricRow[];
  summary: Record<SkillHealthStatus, number> & { total: number };
  total_signals_scanned: number;
  data_status: 'ok' | 'error';
  /** The storage hard cap was reached, so the report may be incomplete. */
  truncated: boolean;
}

export interface SkillMetricsOpts {
  /** Window size in days ending now. Defaults to 7. */
  sinceDays?: number;
}

export async function aggregateSkillMetrics(
  userId: string,
  opts: SkillMetricsOpts = {},
): Promise<SkillMetricsReport> {
  const days = _normalizeDays(opts.sinceDays);
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  const untilIso = until.toISOString();

  let signals: Signal[];
  try {
    signals = await querySignalsForUser(userId, {
      since: sinceIso,
      until: untilIso,
      types: ['skill_advertised', 'skill_invoked', 'correction', 'edit', 'skill_ineffective'],
      limit: QUERY_HARD_LIMIT,
    });
  } catch (err) {
    log.warn('skill metrics query failed', { error: logErrorSummary(err) });
    return {
      range: { since: sinceIso, until: untilIso },
      rows: [],
      summary: _emptyHealthSummary(),
      total_signals_scanned: 0,
      data_status: 'error',
      truncated: false,
    };
  }

  // Metrics are per turn, not per emitted JSONL line. Multiple callbacks can
  // observe the same advertise/read/failure event; Set-based aggregation
  // prevents those duplicates from producing rates above 100%.
  const advertisedTurns = new Map<string, Set<string>>();
  const invokedTurns = new Map<string, Set<string>>();
  const ineffectiveTurns = new Map<string, Set<string>>();
  const turnHadReaction = new Set<string>();

  for (const sig of signals) {
    const turn = _signalTurnKey(sig);
    if (!turn) continue;
    if (sig.type === 'skill_advertised') {
      const system = _validSystem(sig.delta?.system);
      const ids = sig.delta?.skill_ids;
      if (!system || !Array.isArray(ids)) continue;
      for (const id of ids) {
        const validId = _validSkillId(id);
        if (!validId) continue;
        _addTurn(advertisedTurns, `${system}::${validId}`, turn);
      }
    } else if (sig.type === 'skill_invoked') {
      const system = _validSystem(sig.delta?.system);
      const id = _validSkillId(sig.delta?.skill_id);
      if (!system || !id) continue;
      const k = `${system}::${id}`;
      _addTurn(invokedTurns, k, turn);
    } else if (sig.type === 'correction' || sig.type === 'edit') {
      turnHadReaction.add(turn);
    } else if (sig.type === 'skill_ineffective') {
      const system = _validSystem(sig.delta?.system);
      const id = _validSkillId(sig.delta?.skill_id);
      if (!system || !id) continue;
      _addTurn(ineffectiveTurns, `${system}::${id}`, turn);
    }
  }

  // Modified-after-hit JOIN: a conversation turn with both `skill_invoked`
  // and one of (correction | edit) credits every skill invoked in that turn.
  // Over-attributes on purpose when multiple skills load in one turn —
  // the alternative is causal attribution we don't have.
  const modifiedAfterHit = new Map<string, number>();
  const ineffective = new Map<string, number>();
  for (const [k, turns] of invokedTurns) {
    let modifiedCount = 0;
    let ineffectiveCount = 0;
    const failedTurns = ineffectiveTurns.get(k);
    for (const turn of turns) {
      if (turnHadReaction.has(turn)) modifiedCount += 1;
      if (failedTurns?.has(turn)) ineffectiveCount += 1;
    }
    modifiedAfterHit.set(k, modifiedCount);
    ineffective.set(k, ineffectiveCount);
  }

  const nameMap = _readSkillDisplayNames(userId);

  const keys = new Set<string>([...advertisedTurns.keys(), ...invokedTurns.keys()]);
  const rows: SkillMetricRow[] = [];
  for (const k of keys) {
    const [system, id] = _decodeKey(k);
    const ad = advertisedTurns.get(k)?.size || 0;
    const iv = invokedTurns.get(k)?.size || 0;
    const moh = modifiedAfterHit.get(k) || 0;
    const ineff = ineffective.get(k) || 0;
    const base = {
      skill_id: id,
      skill_system: system,
      display_name: nameMap.get(id) || id,
      advertised: ad,
      invoked: iv,
      invocation_rate: ad > 0 ? Math.min(1, iv / ad) : 0,
      modified_after_hit: moh,
      modified_after_hit_rate: iv > 0 ? moh / iv : 0,
      ineffective: ineff,
      ineffective_rate: iv > 0 ? ineff / iv : 0,
    };
    const health = _assessSkillHealth(base);
    rows.push({ ...base, ...health });
  }

  // Sort heuristic: surface unhealthy rows first, then "dead weight"
  // (advertised a lot, invoked little). Ties broken by skill_id for
  // deterministic output.
  const statusRank: Record<SkillHealthStatus, number> = {
    ineffective: 0,
    needs_review: 1,
    underused: 2,
    insufficient_data: 3,
    healthy: 4,
  };
  rows.sort((a, b) =>
    statusRank[a.health_status] - statusRank[b.health_status]
    || (a.health_score - b.health_score)
    || (b.advertised - b.invoked) - (a.advertised - a.invoked)
    || a.skill_id.localeCompare(b.skill_id)
  );

  return {
    range: { since: sinceIso, until: untilIso },
    rows,
    summary: _summarizeHealth(rows),
    total_signals_scanned: signals.length,
    data_status: 'ok',
    truncated: signals.length >= QUERY_HARD_LIMIT,
  };
}

function _normalizeDays(value: number | undefined): number {
  if (value === undefined) return DEFAULT_DAYS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_DAYS;
  return Math.min(30, Math.max(1, Math.floor(parsed)));
}

function _signalTurnKey(signal: Signal): string | null {
  if (typeof signal.cid !== 'string' || !signal.cid) return null;
  if (typeof signal.turn_id !== 'string' || !signal.turn_id) return null;
  return `${signal.cid}\u0000${signal.turn_id}`;
}

function _validSystem(value: unknown): SkillSystem | null {
  return value === 'A.custom' || value === 'A.platform' || value === 'B'
    ? value
    : null;
}

function _validSkillId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) ? id : null;
}

function _addTurn(map: Map<string, Set<string>>, key: string, turn: string): void {
  let turns = map.get(key);
  if (!turns) {
    turns = new Set<string>();
    map.set(key, turns);
  }
  turns.add(turn);
}

function _readSkillDisplayNames(userId: string): Map<string, string> {
  const names = new Map<string, string>();
  let failures = 0;
  // Custom wins by id, so read marketplace first and overlay custom.
  for (const root of [userMarketplaceSkillsDir(userId), userSkillsDir(userId)]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.existsSync(root)
        ? fs.readdirSync(root, { withFileTypes: true })
        : [];
    } catch (err) {
      failures += 1;
      log.warn('skill metrics name catalog read failed', {
        error: logErrorSummary(err),
      });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = _validSkillId(entry.name);
      if (!id) continue;
      try {
        const meta = parseSkillFrontmatter(
          fs.readFileSync(path.join(root, entry.name, 'SKILL.md'), 'utf8'),
        );
        const name = typeof meta.name === 'string' ? meta.name.trim() : '';
        if (name) names.set(id, name);
      } catch {
        failures += 1;
      }
    }
  }
  if (failures > 0) {
    log.warn('some skill metric display names could not be read', {
      failed_count: failures,
    });
  }
  return names;
}

function _decodeKey(k: string): [SkillSystem, string] {
  const i = k.indexOf('::');
  return [k.slice(0, i) as SkillSystem, k.slice(i + 2)];
}

function _emptyHealthSummary(): SkillMetricsReport['summary'] {
  return {
    healthy: 0,
    underused: 0,
    needs_review: 0,
    ineffective: 0,
    insufficient_data: 0,
    total: 0,
  };
}

function _summarizeHealth(rows: SkillMetricRow[]): SkillMetricsReport['summary'] {
  const summary = _emptyHealthSummary();
  for (const row of rows) {
    summary[row.health_status] += 1;
    summary.total += 1;
  }
  return summary;
}

function _assessSkillHealth(row: {
  advertised: number;
  invoked: number;
  invocation_rate: number;
  modified_after_hit: number;
  modified_after_hit_rate: number;
  ineffective: number;
  ineffective_rate: number;
}): Pick<SkillMetricRow, 'health_status' | 'health_score' | 'findings' | 'recommendation'> {
  const observations = row.advertised + row.invoked + row.modified_after_hit + row.ineffective;
  const findings: string[] = [];

  if (row.invoked > 0 && row.ineffective_rate >= 0.3) {
    findings.push(`Ineffective in ${Math.round(row.ineffective_rate * 100)}% of invoked turns.`);
    return {
      health_status: 'ineffective',
      health_score: Math.max(0, 30 - Math.round(row.ineffective_rate * 30)),
      findings,
      recommendation: 'Review trigger scope and implementation before widening usage.',
    };
  }

  if (row.invoked >= 2 && row.modified_after_hit_rate >= 0.5) {
    findings.push(`Users edited or corrected ${Math.round(row.modified_after_hit_rate * 100)}% of invoked turns.`);
    return {
      health_status: 'needs_review',
      health_score: Math.max(20, 55 - Math.round(row.modified_after_hit_rate * 25)),
      findings,
      recommendation: 'Inspect recent turns and refine expected output or preconditions.',
    };
  }

  if (row.advertised >= 5 && row.invocation_rate < 0.1) {
    findings.push(`Advertised ${row.advertised} times but rarely invoked.`);
    return {
      health_status: 'underused',
      health_score: 45,
      findings,
      recommendation: 'Tighten routing hints or remove the skill from broad prompts.',
    };
  }

  if (observations < 3) {
    findings.push('Not enough signal volume for a reliable assessment.');
    return {
      health_status: 'insufficient_data',
      health_score: 50,
      findings,
      recommendation: 'Keep collecting usage signals before changing the skill.',
    };
  }

  findings.push('Usage signals look stable in the selected window.');
  return {
    health_status: 'healthy',
    health_score: row.invocation_rate >= 0.2 ? 90 : 80,
    findings,
    recommendation: 'No action needed.',
  };
}
