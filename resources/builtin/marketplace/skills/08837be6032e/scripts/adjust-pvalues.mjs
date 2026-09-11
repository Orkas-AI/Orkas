import { check, entry, fields, probability } from './input.mjs';
import { table } from './presentation.mjs';

// Established step-up BH / BY and step-down Holm procedures; compare with
// statsmodels.stats.multitest.multipletests. Preserve original hypothesis order.
export function calculate(value) {
  fields(value, ['pvalues', 'method', 'alpha']);
  const { pvalues, method } = value;
  check(['holm', 'bh', 'by'].includes(method), 'Select method: holm (FWER), bh (FDR under independence/positive dependence), or by (FDR under arbitrary dependence).');
  check(Array.isArray(pvalues) && pvalues.length > 0 && pvalues.length <= 100000, 'pvalues must contain 1 to 100000 values from the complete hypothesis family.');
  pvalues.forEach((p, i) => probability(p, `pvalues[${i}]`));
  const alpha = value.alpha === undefined ? 0.05 : value.alpha;
  probability(alpha, 'alpha');
  check(alpha > 0 && alpha < 1, 'alpha must be strictly between 0 and 1.');
  const ordered = pvalues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const n = ordered.length;
  const adjusted = new Array(n);
  let harmonic = 1;
  if (method === 'by') for (let i = 2; i <= n; i++) harmonic += 1 / i;
  if (method === 'holm') {
    let previous = 0;
    for (let i = 0; i < n; i++) {
      previous = Math.min(1, Math.max(previous, ordered[i].p * (n - i)));
      adjusted[ordered[i].index] = previous;
    }
  } else {
    let next = 1;
    for (let i = n - 1; i >= 0; i--) {
      next = Math.min(next, ordered[i].p * n * harmonic / (i + 1));
      adjusted[ordered[i].index] = next;
    }
  }
  const result = {
    method, alpha, hypotheses: n, pvalues, adjusted_pvalues: adjusted,
    reject: adjusted.map(p => p <= alpha),
    error_control: method === 'holm' ? 'family-wise error rate' : 'false discovery rate',
    assumptions: method === 'bh'
      ? 'Valid p-values for the complete family; independence or suitable positive dependence. Not the probability that a particular claim is false.'
      : 'Valid p-values for the complete family; arbitrary dependence allowed. Not the probability that a particular claim is false.',
  };
  result.report = `${method}; ${result.error_control}; alpha=${alpha}.\n`
    + table(['Hypothesis index (0-based)', 'Raw p-value', 'Adjusted p-value', 'Reject'],
      pvalues.map((p, index) => [index, p, adjusted[index], result.reject[index]]))
    + `\n${result.assumptions}`;
  return result;
}

export default entry(calculate);
