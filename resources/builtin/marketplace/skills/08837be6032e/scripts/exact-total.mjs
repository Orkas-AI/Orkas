import { check, entry, fields } from './input.mjs';
import { table } from './presentation.mjs';

// Decimal-string -> integer coefficient + scale, following the decimal
// arithmetic representation used by decimal.js (without importing a library).
// No binary-float conversion, unit guessing, rounding, or currency conversion.
function decimal(value) {
  check(typeof value === 'string' && value.length <= 128 && /^-?\d+(?:\.\d+)?$/u.test(value), 'Amounts must be decimal strings of at most 128 characters, without separators or exponent notation.');
  const [whole, fraction = ''] = value.split('.');
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}

function format(coefficient, scale) {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  const number = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  return `${negative ? '-' : ''}${number}`;
}

export function calculate(value) {
  fields(value, ['values', 'unit', 'expected']);
  check(typeof value.unit === 'string' && value.unit.trim().length > 0 && value.unit.length <= 120, 'Supply the source unit explicitly (for example cents, USD, or count); do not infer currency.');
  check(Array.isArray(value.values) && value.values.length <= 100000, 'values must be an array of at most 100000 decimal strings. Partition larger totals and sum their exact outputs.');
  const amounts = value.values.map(decimal);
  const expected = value.expected === undefined ? undefined : decimal(value.expected);
  let scale = expected?.scale ?? 0;
  for (const amount of amounts) scale = Math.max(scale, amount.scale);
  const rescale = amount => amount.coefficient * 10n ** BigInt(scale - amount.scale);
  let sum = 0n;
  for (const amount of amounts) sum += rescale(amount);
  const result = {
    method: 'exact-decimal-sum', unit: value.unit, count: amounts.length, total: format(sum, scale),
    ...(expected ? {
      expected: format(rescale(expected), scale),
      difference: format(sum - rescale(expected), scale),
      matches: sum === rescale(expected),
    } : {}),
  };
  result.report = table(['Metric', 'Exact value', 'Unit'], [
    ['Computed total', result.total, result.unit],
    ...(expected ? [['Expected total', result.expected, result.unit],
      ['Computed minus expected', result.difference, result.unit]] : []),
  ]) + `\nSummed ${result.count} supplied values; no rounding. This checks arithmetic, not source completeness or authenticity.`;
  return result;
}

export default entry(calculate);
