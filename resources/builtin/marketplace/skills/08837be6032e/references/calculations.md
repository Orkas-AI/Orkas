# Reusable calculations

Use these small, dependency-free JavaScript helpers for their stated methods.
They accept calculation inputs, not a prescribed data source: obtain records or
sufficient statistics through the available file, database, API, or tool path.
Perform source-specific filtering, joins, deduplication and field mapping in
SQL or task code. Do not infer design assumptions merely to fit a helper.

## Invocation

Run through the available shell tool and the standard Skill runner. Replace
`<script>` with `uncertainty-gate`, `proportions`, `missing-binary-bounds`,
`adjust-pvalues`, or `exact-total`:

```sh
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" data-analysis <script> -- --input calculation-input.json
```

On Windows PowerShell:

```powershell
& $env:ORKAS_NODE "$env:ORKAS_PC_DIR/bin/run-skill.cjs" data-analysis <script> -- --input calculation-input.json
```

Use `--json '<JSON object>'` instead of `--input` for small inputs, especially
when the user forbids file creation. Shell quoting follows the host shell.
Input files resolve from the task working directory, never the Skill directory.
Helpers only read the specified input and return JSON; they never write files,
fetch data, install packages, or modify the Skill. Do not locate/copy script
implementations to invoke them. The standard runner resolves the bound Skill.

Each success includes a `report` table derived by the calculation, with display
units, sample basis where applicable, and method limitations. Reuse its numeric
cells when reporting, translating labels if needed; the raw fields retain
precision for subsequent calculations. More than 20 correction rows are
explicitly summarized in the table; the JSON arrays remain complete. For task
code or SQL, similarly emit labeled report-ready values instead of bare numbers.
This needs no separate file or prescribed source format. A table is arithmetic
evidence, not proof that the chosen method fits the source or establishes cause.

Success returns `ok: true`, method and results. Invalid inputs return `ok: false`
with `error.code` and a recovery message; the runner exits nonzero. Do not treat
an error as a result. Input is limited to 8 MiB; array helpers allow at most
100,000 values. Reduce/partition source data as appropriate, retaining complete
coverage. Multiple-testing correction must use the complete family in one call,
not separate corrections per chunk. Unknown fields and numeric strings where
numbers are required are rejected instead of silently ignored/coerced.

## Numerical confidence eligibility

When the user requests a 0-100 or other numerical confidence, run
`uncertainty-gate` before deciding how to express uncertainty:

```json
{"claim":"causal-effect","evidence":"unidentified-observational"}
```

`claim` is one of `causal-effect`, `descriptive-estimate`, `prediction`,
`deterministic-result`, or `source-defined-score`. `evidence` is one of
`unidentified-observational`, `identified-design`, `sampling-model`,
`validated-prediction`, `complete-scope`, `source-defined-rule`, or
`insufficient`.

The gate never manufactures a score. It rejects generic numerical confidence
and returns the appropriate evidence form: an identified effect with an
interval, a sampling interval, validated prediction error/range, deterministic
reconciliation, or an explicit not-estimable result. Only a
`source-defined-score` paired with a `source-defined-rule` permits computing the
supplied business score, which must remain labeled as such. An actual interval,
probability, or business score still has to be produced by the applicable
method or source formula; the gate only validates eligibility.

## Proportions

One group: Wilson score interval. Two groups: Newcombe hybrid Wilson interval
for **first group minus second group**, without continuity correction.

```json
{"design":"independent-binomial","groups":[{"label":"treatment","events":37,"total":240},{"label":"control","events":21,"total":220}],"confidence_level":0.95}
```

`events` and `total` are safe integers, `0 <= events <= total`, `total > 0`.
One binary outcome per independent unit and a fixed analysis window are
required; with two groups, groups must also be independent. The caller must
establish those conditions from evidence. Declaring `design` does not verify
them. Do not use these intervals for paired users, clusters, weights, repeated
peeking, missing-outcome bias, revenue means, or causal identification.

`confidence_level` defaults to 0.95 and must be strictly between 0 and 1.
Results include group rates and intervals, and for two groups `difference`
with estimate, direction and interval. All are on the **proportion** scale:
multiply by 100 for percentages / percentage points, respectively. These are
approximate marginal intervals, not simultaneous intervals, exact binomial
intervals, or the probability that an effect exists. Boundary counts are
supported without collapsing uncertainty to zero. Use a suitable alternative
when the design or required coverage calls for another method.

## Missing binary outcomes

Use `missing-binary-bounds` for worst-case ranges over a known eligible group:

```json
{"groups":[{"label":"A","successes":18,"failures":6,"missing":6},{"label":"B","successes":20,"failures":10,"missing":0}]}
```

Counts must be nonnegative safe integers whose sum is a positive safe integer.
One group returns its observed-only rate (null if none are observed) and the
all-eligible bounds `successes / total` to `(successes + missing) / total`.
Two groups also return the first-minus-second difference bounds: first low
minus second high, to first high minus second low. These assume no restrictions
on the missing binary values. They are finite-scope ranges, not confidence
intervals, causal effects, or generalizations to unseen units. Unknown eligible
counts, weighted outcomes, and outcomes outside {0,1} need another approach.

## Multiple testing

```json
{"pvalues":[0.012,0.18,0.041,0.003],"method":"holm","alpha":0.05}
```

Provide valid numeric p-values in [0,1] for the **complete tested family**, not
only selected small p-values. `alpha` defaults to 0.05, strictly between 0 and 1.
Select the error criterion from the decision:

- `holm`: family-wise error rate, arbitrary dependence allowed.
- `bh`: false discovery rate under independence or suitable positive dependence.
- `by`: false discovery rate under arbitrary dependence; more conservative.

Output preserves input order in `pvalues`, `adjusted_pvalues` and `reject`.
The helper does not generate p-values or repair an invalid test, selective
reporting, or unaccounted optional stopping. Adjusted p-values are not the
probabilities that individual hypotheses are true/false.

## Exact totals and reconciliation

```json
{"values":["9007199254740993.10","0.20","-0.05"],"unit":"source cents","expected":"9007199254740993.25"}
```

`values` contains decimal **strings**, each at most 128 characters, with an
optional minus sign and decimal point. No exponents, separators or currency
symbols. Preserve exact source strings; converting an already-rounded Number
to a string cannot recover lost digits. `unit` is required and echoed unchanged:
all amounts must already have that same unit. This is not currency conversion.

Output `total` is an exact decimal string; optional `expected` adds `difference`
(computed minus expected) and `matches`. `matches: false` is a successfully
computed discrepancy, not a tool failure. Empty input returns count 0 and sum
0; it does not establish source completeness. To handle larger collections,
sum partitions and then sum their exact string totals. Partitioned counts must
be tracked separately. Mixed scales are aligned exactly without rounding.

## Method provenance

- [statsmodels proportion methods](https://www.statsmodels.org/stable/_modules/statsmodels/stats/proportion.html): Wilson and Newcombe method definitions; published independent numerical test anchors.
- [statsmodels multiple testing](https://www.statsmodels.org/stable/generated/statsmodels.stats.multitest.multipletests.html): Holm / BH / BY and their error-control assumptions.
- [jStat numerical kernel](https://github.com/jstat/jstat/blob/e3b9787b3b1a2541927be619ae223d135cea602a/src/special.js): the small error-function kernel is adapted with its MIT notice retained in `normal.mjs`; no package install.
- [decimal.js precision guidance](https://github.com/MikeMcl/decimal.js#use): preserve decimal strings instead of first losing precision in binary floating point. This helper independently implements only scaled-integer addition, not that library's general arithmetic API.
