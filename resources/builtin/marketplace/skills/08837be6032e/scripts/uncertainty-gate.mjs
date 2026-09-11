import { check, entry, fields } from './input.mjs';

const CLAIMS = [
  'causal-effect',
  'descriptive-estimate',
  'prediction',
  'deterministic-result',
  'source-defined-score',
];

const EVIDENCE = [
  'unidentified-observational',
  'identified-design',
  'sampling-model',
  'validated-prediction',
  'complete-scope',
  'source-defined-rule',
  'insufficient',
];

const RECOMMENDATIONS = {
  'causal-effect:unidentified-observational': 'Report the observed contrast separately and state that causal effect and numerical causal confidence are not estimable from this design.',
  'causal-effect:identified-design': 'Estimate the causal effect with an applicable method and report its interval, assumptions, and design limitations; do not convert it to a generic confidence score.',
  'descriptive-estimate:sampling-model': 'Report the estimate with an applicable sampling interval and its sample basis; the confidence level is coverage, not confidence that the claim is true.',
  'prediction:validated-prediction': 'Report held-out or backtested error, a prediction interval, or a calibrated probability produced by the validated method; do not invent a generic score.',
  'deterministic-result:complete-scope': 'Report scope, reconciliation, and validation. A complete deterministic result does not need a sampling or intuitive confidence score.',
  'source-defined-score:source-defined-rule': 'Compute only the supplied scoring rule, label it as a business score, and do not present it as a probability or statistical confidence.',
};

export function calculate(value) {
  fields(value, ['claim', 'evidence']);
  const { claim, evidence } = value;
  check(CLAIMS.includes(claim), `claim must be one of: ${CLAIMS.join(', ')}.`);
  check(EVIDENCE.includes(evidence), `evidence must be one of: ${EVIDENCE.join(', ')}.`);

  const key = `${claim}:${evidence}`;
  const recommendation = RECOMMENDATIONS[key]
    ?? 'The requested numerical confidence is not estimable from the supplied evidence. State the evidence gap and use an applicable interval, bound, validation result, or qualitative limitation instead.';
  const sourceDefined = key === 'source-defined-score:source-defined-rule';
  const reportingRequirements = [
    'Preserve source units unless the evidence supplies a conversion factor and target unit; label every conversion explicitly.',
    'Give every material derived quantity an unambiguous unit and denominator.',
  ];

  return {
    method: 'uncertainty-eligibility-gate',
    claim,
    evidence,
    generic_numeric_confidence_allowed: false,
    source_defined_score_allowed: sourceDefined,
    result: sourceDefined ? 'compute-source-defined-rule' : 'do-not-report-numeric-confidence',
    recommendation,
    reporting_requirements: reportingRequirements,
    report: `Numerical confidence decision: ${sourceDefined ? 'only the source-defined business score is admissible' : 'not estimable as a generic score'}.\n${recommendation}\n${reportingRequirements.join('\n')}`,
  };
}

export default entry(calculate);
