/**
 * Operator policy rules — additive red flags supplied by an operator at
 * runtime. RED_FLAGS stays the security floor: rules here can only ADD
 * findings, never suppress or downgrade a built-in one. Operator ids have their own
 * namespace. Findings carry `source: 'operator-policy'`. Pure: no filesystem.
 */

import { Level, RuleDef, ScanKind } from '../types';

const KINDS: ReadonlyArray<ScanKind> = ['skill_md', 'skill_meta', 'script', 'agent_json'];
const DEFAULT_APPLIES_TO: ScanKind[] = ['skill_md', 'script', 'agent_json'];
const MAX_RULES = 50;
const MAX_PATTERN = 500;
const RULE_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const ALLOWED_FLAGS = /^[imsu]*$/;

export interface OperatorPolicyParseResult {
  rules: RuleDef[];
  /** Configuration errors. Any error rejects the entire policy. */
  errors: string[];
}

/** Parse an operator rule file (`{ "rules": [ ... ] }`). Invalid configuration is rejected atomically; no partial rule set loads. */
export function parseOperatorPolicy(content: string): OperatorPolicyParseResult {
  if (content.length > 64 * 1024) return { rules: [], errors: ['operator policy exceeds 64 KiB'] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { rules: [], errors: [`operator policy is not valid JSON: ${(err as Error).message}`] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { rules: [], errors: ['operator policy must be a JSON object like { "rules": [...] }'] };
  }
  const config = parsed as Record<string, unknown>;
  if (config.version !== 1) return { rules: [], errors: ['operator policy requires version 1'] };
  if (Object.keys(config).some((key) => !['version', 'rules'].includes(key))) {
    return { rules: [], errors: ['unknown operator policy field'] };
  }
  const raw = config.rules;
  if (!Array.isArray(raw)) {
    return { rules: [], errors: ['operator policy must contain a "rules" array'] };
  }

  const errors: string[] = [];
  if (raw.length > MAX_RULES) return { rules: [], errors: [`operator policy allows at most ${MAX_RULES} rules`] };

  const seen = new Set<string>();
  const rules: RuleDef[] = [];

  for (const [i, entry] of raw.slice(0, MAX_RULES).entries()) {
    const where = `rules[${i}]`;
    const fail = (msg: string) => { errors.push(`${where}: ${msg}`); };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { fail('must be an object'); continue; }
    const r = entry as Record<string, unknown>;

    if (Object.keys(r).some((key) => !['id', 'level', 'pattern', 'flags', 'message', 'appliesTo'].includes(key))) {
      fail('unknown rule field'); continue;
    }
    if (r.flags !== undefined && typeof r.flags !== 'string') { fail('"flags" must be a string'); continue; }
    if (r.message !== undefined && (typeof r.message !== 'string' || r.message.length > 300)) {
      fail('"message" must be a string of at most 300 chars'); continue;
    }
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!RULE_ID.test(id)) { fail(`"id" must match ${RULE_ID}`); continue; }
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
      id: `operator:${id}`,
      level: level as Level,
      appliesTo,
      pattern,
      suggested_fix: message
        || `Operator policy "${id}" matched. Rewrite the spec so it no longer matches, or ask the operator to revise this policy.`,
    });
  }

  return { rules: errors.length ? [] : rules, errors };
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
