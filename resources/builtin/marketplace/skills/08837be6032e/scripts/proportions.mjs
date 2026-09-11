import { check, entry, fields, probability } from './input.mjs';
import { normalCritical } from './normal.mjs';
import { percentage, table } from './presentation.mjs';

// Wilson score interval and Newcombe's hybrid score difference interval,
// without continuity correction. Method reference / independent test anchors:
// statsmodels.stats.proportion.proportion_confint(method='wilson') and
// confint_proportions_2indep(method='newcomb', compare='diff').
function wilson(group, z, index) {
  fields(group, ['events', 'total', 'label'], `groups[${index}]`);
  const { events, total, label } = group;
  check(Number.isSafeInteger(total) && total > 0, `groups[${index}].total must be a positive safe integer.`);
  check(Number.isSafeInteger(events) && events >= 0 && events <= total, `groups[${index}].events must be an integer from 0 through total.`);
  check(label === undefined || (typeof label === 'string' && label.length <= 120), 'Group labels must be strings of at most 120 characters.');
  const rate = events / total;
  const z2n = z * z / total;
  const center = (rate + z2n / 2) / (1 + z2n);
  const radius = z * Math.sqrt((rate * (1 - rate) + z2n / 4) / total) / (1 + z2n);
  return {
    ...(label === undefined ? {} : { label }), events, total, rate,
    interval: { low: events === 0 ? 0 : Math.max(0, center - radius), high: events === total ? 1 : Math.min(1, center + radius) },
  };
}

export function calculate(value) {
  fields(value, ['groups', 'confidence_level', 'design']);
  check(value.design === 'independent-binomial', 'This method requires design="independent-binomial": independent units, one binary outcome per unit, fixed analysis window. Paired, clustered, weighted or sequential data need another method.');
  const confidenceLevel = value.confidence_level === undefined ? 0.95 : value.confidence_level;
  probability(confidenceLevel, 'confidence_level');
  check(confidenceLevel > 0 && confidenceLevel < 1, 'confidence_level must be strictly between 0 and 1.');
  check(Array.isArray(value.groups) && [1, 2].includes(value.groups.length), 'Supply one group for a rate interval or two groups for a difference interval.');
  const z = normalCritical(confidenceLevel);
  const groups = value.groups.map((group, index) => wilson(group, z, index));
  const result = {
    method: groups.length === 1 ? 'wilson' : 'newcombe-wilson',
    confidence_level: confidenceLevel, unit: 'proportion', groups,
    assumptions: 'Independent binomial units and a fixed analysis window, as declared by the caller; not verified by this calculation. Intervals are approximate, not causal probabilities or simultaneous intervals.',
  };
  if (groups.length === 2) {
    const [a, b] = groups;
    const estimate = a.rate - b.rate;
    result.difference = {
      direction: 'groups[0] - groups[1]', estimate,
      interval: {
        low: Math.max(-1, estimate - Math.hypot(a.rate - a.interval.low, b.interval.high - b.rate)),
        high: Math.min(1, estimate + Math.hypot(a.interval.high - a.rate, b.rate - b.interval.low)),
      },
    };
  }
  const rows = groups.map((group, index) => [
    group.label ?? `groups[${index}]`, percentage(group.rate), '%',
    `${group.events} / ${group.total}`, `${percentage(group.interval.low)} to ${percentage(group.interval.high)}`,
  ]);
  if (result.difference) rows.push([
    result.difference.direction, percentage(result.difference.estimate), 'percentage points',
    `${groups[0].total} vs ${groups[1].total} independent units`,
    `${percentage(result.difference.interval.low)} to ${percentage(result.difference.interval.high)}`,
  ]);
  result.report = `${result.method}; approximate ${percentage(confidenceLevel)}% confidence intervals (not effect probabilities).\n`
    + table(['Metric', 'Estimate', 'Unit', 'Sample basis', 'Interval in the same unit'], rows)
    + `\n${result.assumptions}`;
  return result;
}

export default entry(calculate);
