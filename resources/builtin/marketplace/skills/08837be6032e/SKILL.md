---
name: data-analysis
description_zh: "从文件、数据库、API、连接器、工具结果或混合来源的数据中形成可复核结论，覆盖指标汇总、分组比较、趋势与异常诊断、实验、预测和分析验证，并处理口径、数据质量与不确定性。用于需要从多条定量或结构化证据推导结论的任务；不用于仅制作表格格式、复述现成结论或普通资料检索。"
description_en: "Analyze quantitative evidence: exact totals, comparisons, experiments and causal uncertainty. Excludes formatting-only work."
---

# Data Analysis

Derive reviewable conclusions from the user's data. Use the available source
and computation tools; this Skill does not prescribe a format, language,
library, or artifact. Respect project metric definitions and business rules.
Preserve inputs unless transformation was requested, and match effort to the
decision's risk.

Apply three gates before analysis:

- **Precision gate:** execute precision-preserving arithmetic before reporting
  an exact monetary/ledger reconciliation or another result where ordinary
  numeric arithmetic can lose meaningful digits. Reading values, profiling
  them, or writing out arithmetic is not verification.
- **Method gate:** report no statistical interval, p-value, model coefficient,
  forecast, or probability unless an applicable method was executed and its
  assumptions are supported by the evidence. Calling a number rough or
  approximate does not supply a derivation.
- **Confidence gate:** return no 0-100 or other numerical confidence unless the
  source defines the score or an applicable method estimates that quantity.
  Otherwise say it is not estimable from the supplied evidence. Never relabel
  an unsupported number as evidence strength, decision confidence, reliability,
  or confidence in the opposite conclusion. When the user requests numerical
  confidence, execute the bundled `uncertainty-gate` after classifying the claim
  and evidence; its rejection of a generic score is binding.

## Evidence boundary

Every reported number needs a derivation, a unit, and a denominator where
applicable. Apply this to the final recommendation, not just the calculations.

- **Units:** retain source units unless a conversion is needed and supported.
  If the currency is unspecified, say so and keep the supplied monetary unit;
  do not guess a currency or silently scale the values. Label totals versus
  per-unit values and percentage points versus relative percentages.
- **Confidence:** identify the requested quantity and whether the design/data
  can estimate it. A user's request for a number does not create evidence, and
  not estimable is not zero probability. A defined business scoring rule may be
  computed, but is not a probability.
- **Causality:** a descriptive comparison, of any sign, establishes neither a
  causal effect nor its absence without a credible identifying design.
  Report the observed result separately from what remains unidentified.

## Analytical loop

1. **Frame the claim.** Establish the population, entity grain, period, metric,
   denominator, units, comparison, and deliverable. Distinguish description,
   prediction, and causal inference. Resolve ambiguities that could change the
   answer; otherwise state a reasonable assumption.
2. **Establish the evidence.** Inspect source provenance, freshness, schema,
   counts, keys, and boundaries. A preview or sample describes only its covered
   scope; retrieve the complete records required by the claim using the source's
   pagination or persisted-result contract.
3. **Check fitness.** Test the relevant risks: missingness, duplicates, filter
   loss, join coverage/multiplication, changed definitions, partial periods,
   incompatible units, or shifted population/segment mix. State material
   exclusions and missing-value treatment. Narrow an unsupported claim instead
   of filling evidence gaps with speculation.
4. **Compute reproducibly.** Use transparent direct arithmetic for a few visible
   values when it is safely reviewable. Execute code, SQL, or spreadsheet
   formulas for bulk transformations, statistical inference, fitted models,
   precision-sensitive results, or when execution was requested. Reuse a bundled
   calculation below when its assumptions fit; otherwise use the simplest suitable implementation.
   Have the computation output the report-ready values with metric labels,
   units and denominators, including needed conversions and display rounding.
   Reuse those values in the answer; keep exact money/counts internally. Do not
   install a data-science stack merely for analysis.
5. **Challenge the headline.** Use an independent check capable of changing the
   conclusion: raw-component recomputation, reconciliation, record tracing,
   alternate grouping/baseline, or sensitivity analysis. Correct discrepancies;
   stop when further checks would not materially improve the answer.
6. **Report at the evidence boundary.** Lead with the result, its scope and
   practical meaning. Separate observation, interpretation, and recommendation.
   Put material assumptions, exclusions, and limitations beside their claims.
   Do not produce a checklist report or extra files merely to follow this loop.

## Choosing uncertainty

Use quantitative uncertainty when the design supports it: a suitable interval
for a sample estimate or experiment, validated prediction error/ranges for a
forecast, or bounds/sensitivity analysis for incomplete evidence. Give the
estimate, scale, sample basis, method, and material assumptions together. A
complete in-scope deterministic total needs scope and validation, not an
artificial sampling interval. When uncertainty cannot be quantified, explain
the evidence gap and decision impact without an arbitrary numerical substitute.

Before responding, reconcile the answer's material numbers and labels with
their derivations. Remove unsupported quantities introduced during explanation;
in particular, remove any statistical quantity that did not pass the method
gate, any numerical confidence that did not pass the confidence gate, and
execute any precision-sensitive result that did not pass the precision gate.

## Conditional references

- For a requested numerical confidence, binomial rate/difference intervals,
  missing binary outcome bounds, multiple-testing correction, or exact decimal
  totals/reconciliation, read [calculations.md](references/calculations.md) and
  execute the matching bundled script. Source extraction and business logic
  remain task-specific; these helpers do not define a universal confidence score.
- For sampling inference, experiments, forecasts, formal uncertainty, or causal
  analysis, read [inference-and-uncertainty.md](references/inference-and-uncertainty.md).
- For reviewing an existing analysis, reconciling conflicting sources, or
  validating a surprising or high-impact conclusion, read
  [validation.md](references/validation.md).
