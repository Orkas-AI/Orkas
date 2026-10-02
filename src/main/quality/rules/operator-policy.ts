/**
 * Operator policy rules — additive red flags supplied by an operator at
 * runtime. RED_FLAGS stays the security floor: rules here can only ADD
 * findings, never suppress or downgrade a built-in one, and a colliding id is
 * rejected. Findings carry `source: 'operator-policy'`. Pure: no filesystem.
 */

import { Level, RuleDef, ScanKind } from '../types';
import { RED_FLAGS } from './red-flags';
const KINDS: ReadonlyArray<ScanKind> = ['skill_md', 'skill_meta', 'script', 'agent_json'];
const DEFAULT_APPLIES_TO: ScanKind[] = ['skill_md', 'script', 'agent_json'];
const MAX_RULES = 50;
const MAX_PATTERN = 500;
const RULE_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ALLOWED_FLAGS = /^[imsu]*$/;

export interface OperatorPolicyParseResult {
  rules: RuleDef[];
  /** Reasons individual rules were skipped (never thrown). */
  errors: string[];
}

/** Parse an operator rule file (`{ "rules": [ ... ] }`). Invalid rules are
 *  skipped and reported in `errors`; the rest still load. */
export function parseOperatorPolicy(content: string): OperatorPolicyParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { rules: [], errors: [`operator policy is not valid JSON: ${(err as Error).message}`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { rules: [], errors: ['operator policy must be a JSON object like { "rules": [...] }'] };
  }
  const raw = (parsed as { rules?: unknown }).rules;
  if (!Array.isArray(raw)) {
    return { rules: [], errors: ['operator policy must contain a "rules" array'] };
  }

  const errors: string[] = [];
  if (raw.length > MAX_RULES) errors.push(`operator policy has ${raw.length} rules; only the first ${MAX_RULES} load`);

  const builtinIds = new Set(RED_FLAGS.map((r) => r.id));
  const seen = new Set<string>();
  const rules: RuleDef[] = [];

  for (const [i, entry] of raw.slice(0, MAX_RULES).entries()) {
    const where = `rules[${i}]`;
    const fail = (msg: string) => { errors.push(`${where}: ${msg}`); };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { fail('must be an object'); continue; }
    const r = entry as Record<string, unknown>;

    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!RULE_ID.test(id)) { fail(`"id" must match ${RULE_ID}`); continue; }
    if (builtinIds.has(id)) { fail(`id "${id}" collides with a built-in rule; operator rules may not shadow the security floor`); continue; }
    if (seen.has(id)) { fail(`duplicate id "${id}"`); continue; }

    const level = r.level;
    if (level !== 'EXTREME' && level !== 'MEDIUM' && level !== 'LOW') { fail('"level" must be EXTREME, MEDIUM, or LOW'); continue; }

    const src = typeof r.pattern === 'string' ? r.pattern : '';
    if (!src || src.length > MAX_PATTERN) { fail(`"pattern" must be a non-empty string of at most ${MAX_PATTERN} chars`); continue; }

    // `g` / `y` are stateful (`lastIndex`) and one rule object is reused across files.
    const flags = typeof r.flags === 'string' ? r.flags : '';
    if (!ALLOWED_FLAGS.test(flags)) { fail('"flags" may only contain i, m, s, u'); continue; }

    let pattern: RegExp;
    try { pattern = new RegExp(src, flags); }
    catch (err) { fail(`invalid regex: ${(err as Error).message}`); continue; }

    const message = typeof r.message === 'string' ? r.message.trim().slice(0, 300) : '';

    const appliesTo = _appliesTo(r.appliesTo, where, errors);
    if (!appliesTo) continue;

    seen.add(id);
    rules.push({
      id,
      level: level as Level,
      appliesTo,
      pattern,
      suggested_fix: message
        || `Operator policy "${id}" matched. Rewrite the spec so it no longer matches, or ask the operator to revise this policy.`,
    });
  }

  return { rules, errors };
}

function _appliesTo(raw: unknown, where: string, errors: string[]): ScanKind[] | null {
  if (raw === undefined) return [...DEFAULT_APPLIES_TO];
  const list = Array.isArray(raw) ? raw : [];
  const bad = !list.length || list.some((k) => typeof k !== 'string' || !KINDS.includes(k as ScanKind));
  if (bad) {
    errors.push(`${where}: "appliesTo" must be a non-empty array of ${KINDS.join(' | ')}`);
    return null;
  }
  return list as ScanKind[];
}
