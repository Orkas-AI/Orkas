# Inference and Uncertainty

Read this reference only when the requested conclusion extends beyond a direct
description of the complete supplied population, or when uncertainty itself is
part of the decision.

## Identify the estimand and design

State the quantity the analysis is trying to learn, the target population, the
observed sample or time span, and how observations entered the data. Separate
these designs before selecting a method:

- a complete enumeration of the in-scope records;
- a probability or otherwise defensible sample from a wider population;
- a randomized experiment;
- observational comparison or quasi-experiment;
- repeated measurements or time series; or
- a predictive model evaluated on future or held-out observations.

An interval formula cannot repair a nonrepresentative sample, a changed
population, dependent observations treated as independent, leakage, or a metric
whose denominator does not match the estimand.

## Similar numbers, different questions

Choose from source design and the target claim, not from the helper's accepted
parameters. These contrasts illustrate decisions, not a required tool sequence:

| Source and target | Useful computation | What it does not establish |
| --- | --- | --- |
| Complete in-scope ledger; reconcile a declared amount | Exact signed total and discrepancy | Source authenticity, or a sampling interval |
| Fixed-window experiment with independently randomized units and complete binary outcomes | Group rates, effect and appropriate sampling interval | Probability that this particular effect is true |
| Known eligible groups with missing binary outcomes | Observed-only rates and all-eligible worst-case bounds | Missing-at-random behavior or a sampling interval that resolves selection bias |
| Nonrandom before/after comparison | Normalize each period by its own eligible population and compute descriptive changes | Causality or a calibrated percentage of belief |

For example, a group with 18 successes, 6 failures and 6 missing outcomes has
an observed rate of 75%, but its 30 eligible outcomes permit 60%-80%. A fully
observed comparison group at 20/30 is about 66.67%, inside that range. Executing
`missing-binary-bounds` gives the ranges and their difference; an observed-only
binomial interval answers a different question and cannot decide the winner.

For a descriptive change, execute the actual transformation, not just data
profiling. For example, task code can compute each group's per-person change
as `(after_total - before_total) / users`, then subtract those changes and emit
the source unit per person. A row count/missingness check does not compute it.
Interpret that result separately from whether a causal design is supported.

## Sample estimates and comparisons

- Report the effect or estimate and its practical scale, not only a p-value.
- Choose intervals that match the statistic and design. Account for paired,
  clustered, stratified, weighted, repeated, or time-dependent observations
  when present. Use a defensible resampling method when an analytic interval is
  unavailable and the resampling unit preserves the dependency structure.
- Show group sizes, event counts, and base rates for comparisons. Very small or
  sparse groups may require exact methods, wider intervals, aggregation, or an
  explicit inability to support the requested precision.
- Treat failure to reject a null hypothesis as insufficient evidence of a
  difference, not proof of equivalence. An equivalence or non-inferiority claim
  needs a pre-specified margin and suitable design.
- If many hypotheses, metrics, segments, or time windows were searched, expose
  that multiplicity and use a correction, holdout confirmation, or exploratory
  label rather than presenting the best-looking result as confirmatory.

## Experiments

Confirm the randomization unit, eligibility and exposure rules, assignment
integrity, analysis population, primary outcome, guardrails, and analysis
window. Check sample-ratio mismatch and differential attrition. Prefer the
pre-specified intention-to-treat estimate unless the decision calls for another
estimand and its additional assumptions are explicit. Report effect size,
interval, baseline rate, and practical relevance. Repeated peeking or optional
stopping requires a sequential design or an explicit exploratory caveat.

## Observational and causal analysis

Prediction, correlation, temporal ordering, and regression adjustment alone do
not establish causality. Name the treatment, outcome, comparison, time ordering,
and causal assumptions. Identify likely confounders, selection mechanisms,
spillovers, and post-treatment variables.

Use a quasi-experimental method only when its identifying assumption can be
examined and defended for this setting—for example parallel trends for
difference-in-differences, continuity around a regression-discontinuity cutoff,
or exclusion and relevance for an instrument. Matching or propensity scores
balance measured covariates; they do not remove unmeasured confounding. When a
credible design is absent, present the result as an association and test whether
reasonable alternative explanations could reverse the recommendation.

## Forecasts and predictive models

- Split training, tuning, and evaluation in time or by independent unit so the
  evaluation represents future use. Prevent target, temporal, and entity
  leakage through features and preprocessing.
- Compare against a simple relevant baseline. Select metrics that match the
  decision cost, report performance by important segment, and inspect error
  distribution rather than only an average score.
- Use rolling or repeated backtests when seasonality, drift, or limited history
  makes one split fragile. State the forecast horizon and data cutoff.
- Report a prediction interval, quantiles, or calibrated probability when the
  method supports it. Validate empirical coverage where possible. Widen or
  withhold ranges when structural change makes historical error unrepresentative.

## Communicate uncertainty

Keep these dimensions separate:

1. **Data uncertainty:** coverage, measurement, missingness, sampling, and
   source reliability.
2. **Method uncertainty:** model form, identifying assumptions, thresholds,
   preprocessing, and analyst choices.
3. **Result uncertainty:** interval, prediction error, bounds, scenario range,
   or sensitivity of the decision.

Apply the root Skill's quantitative-claim check to the final interpretation as
well as the calculated estimates. Explain which evidence or validation would
most reduce material uncertainty; not every caveat needs more analysis before
a low-risk decision.
