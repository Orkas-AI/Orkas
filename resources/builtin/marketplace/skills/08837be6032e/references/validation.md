# Analysis Validation

Read this reference when reviewing an existing analysis or when a conclusion is
surprising, externally shared, high impact, or dependent on conflicting sources.
Validate proportionally to the decision risk and prioritize errors that could
change the conclusion.

## Inventory the claim chain

Identify the question, audience, decision, headline claims, source artifacts,
time windows, population, filters, metric definitions, comparison baseline,
methods, and stated caveats. Confirm that the analysis answers the requested
question rather than a nearby easier one. Map each material conclusion back to
visible evidence or a reproducible calculation.

## Validate the evidence

Check the risks relevant to the source and claim:

- **Provenance and freshness:** authoritative source, as-of time, expected
  partitions, lineage, and consistent snapshot timing.
- **Grain and identity:** unit of analysis, key uniqueness, duplicate entities,
  one-to-many relationships, and row/entity counts before and after joins.
- **Coverage:** missing periods, categories, geographies, cohorts, deleted or
  failed entities, filter loss, null handling, and reference-table match rates.
- **Definitions:** formula, unit, denominator, eligibility, currency, timezone,
  cutoff, reporting calendar, and consistency across periods and sources.
- **Transformation:** source-to-output record traces, subtotal reconciliation,
  weighted calculations, rounding, boundary dates, and expected invariants.

Do not treat a polished artifact, successful query, or clean schema as proof
that the business interpretation is correct.

## Challenge common failure modes

- Many-to-many joins can multiply records and inflate counts or sums. Compare
  row counts and distinct entities around the join and aggregate to the intended
  grain when required.
- Averages of group averages are wrong when group sizes differ unless they are
  weighted from the underlying numerator and denominator.
- Partial and complete periods, changed eligible populations, or shifted metric
  definitions do not form a valid trend without adjustment or a visible caveat.
- Survivorship and selection bias omit churned, failed, deleted, or otherwise
  absent entities; ask which members of the target population cannot appear.
- Aggregate and segment trends may conflict. Inspect decision-relevant segments
  before accepting an aggregate result, while avoiding post-hoc segment mining.
- Outliers can dominate means and correlations. Inspect distributions and
  robust summaries, but do not remove observations solely because they weaken
  the preferred conclusion.
- Multiple testing, cherry-picked windows, look-ahead leakage, and tuning on the
  evaluation set can turn exploratory patterns into false certainty.
- Correlation, prediction accuracy, or a before/after change does not by itself
  support a causal statement.

## Apply independent checks

Use the strongest economical check available:

1. Recompute a headline number from raw components through a separate path.
2. Trace representative normal, boundary, missing, and duplicated records.
3. Reconcile a total against an authoritative source or invariant.
4. Compare a result under a defensible alternate baseline, exclusion rule, or
   assumption.
5. Inspect final charts or tables for misleading scales, intervals, ordering,
   labels, units, precision, and caveat placement.

Independence means the check is capable of exposing the original error; rerunning
the same transformation with the same assumptions is not an independent check.

## Assess readiness

Classify only when the user or decision benefits from a readiness judgment:

- **Ready:** the method fits the question, material definitions and inputs are
  established, key calculations are verified, and remaining limitations do not
  plausibly change the decision.
- **Usable with caveats:** the direction is supported, but named assumptions,
  uncertainty, or unverified checks must accompany the conclusion.
- **Not decision-ready:** a material source, denominator, population, join,
  method, calculation, or claim is unreliable or missing.

Report blockers separately from caveats. For each blocker, give the evidence,
decision impact, and smallest correction or additional check needed. Label
unverified items and never turn readiness labels into numeric probabilities.

