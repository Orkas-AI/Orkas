import { check, entry, fields } from './input.mjs';
import { percentage, table } from './presentation.mjs';

// Finite-scope worst-case bounds: enumerate every missing binary outcome as
// either failure or success. No sampling or missing-at-random assumption.
export function calculate(value) {
  fields(value, ['groups']);
  check(Array.isArray(value.groups) && [1, 2].includes(value.groups.length), 'Supply one group for a rate range or two groups for a difference range.');
  const groups = value.groups.map((group, index) => {
    fields(group, ['label', 'successes', 'failures', 'missing'], `groups[${index}]`);
    const { label, successes, failures, missing } = group;
    check(label === undefined || (typeof label === 'string' && label.length <= 120), 'Group labels must be strings of at most 120 characters.');
    for (const count of [successes, failures, missing]) check(Number.isSafeInteger(count) && count >= 0, 'successes, failures and missing must be nonnegative safe integers.');
    const total = successes + failures + missing;
    check(Number.isSafeInteger(total) && total > 0, 'Group total must be a positive safe integer.');
    const observed = successes + failures;
    return { ...(label === undefined ? {} : { label }), successes, failures, missing, total,
      observed_rate: observed ? successes / observed : null,
      bounds: { low: successes / total, high: (successes + missing) / total } };
  });
  const result = { method: 'finite-scope-missing-binary-bounds', unit: 'proportion', groups,
    limitations: 'Bounds over the supplied eligible units, assuming correct counts and binary outcomes. Not sampling confidence intervals, probabilities of an effect, or causal identification; unknown population coverage is not repaired.' };
  if (groups.length === 2) result.difference = {
    direction: 'groups[0] - groups[1]',
    bounds: { low: groups[0].bounds.low - groups[1].bounds.high, high: groups[0].bounds.high - groups[1].bounds.low },
  };
  const rows = groups.map((group, index) => [group.label ?? `groups[${index}]`,
    group.observed_rate === null ? 'not estimable (no observed outcomes)' : percentage(group.observed_rate),
    `${percentage(group.bounds.low)} to ${percentage(group.bounds.high)}`, '%',
    `${group.successes} successes; ${group.failures} failures; ${group.missing} missing; ${group.total} eligible`]);
  if (result.difference) rows.push([result.difference.direction, 'not a point estimate',
    `${percentage(result.difference.bounds.low)} to ${percentage(result.difference.bounds.high)}`, 'percentage points', 'all eligible units in each group']);
  result.report = table(['Metric', 'Observed-only rate', 'All-eligible range', 'Unit', 'Basis'], rows) + `\n${result.limitations}`;
  return result;
}

export default entry(calculate);
