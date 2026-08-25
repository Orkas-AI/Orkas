<!-- deep-research reference. Read this before the first caps, academic,
compress, or citations call, and before assembling a verifier-backed report. -->

# Operations and verified report assembly

## `caps`

`plan` input:

```json
{"subquestions":["..."],"depth":0,"caps":{}}
```

Optional `caps` fields are `max_subquestions`, `max_fetches`,
`max_fetches_per_subquestion`, `max_model_calls`, `max_depth`, and
`max_cost_usd`. Omit limits that should keep their defaults. Use caps for normal
fan-out research and whenever the user, task, cost policy, or resumed state
supplies a real budget. A fresh compact landscape has no default fetch-count
ceiling: its two-batch/eight-fetch suggestion is only an efficiency target.

When caps apply, use returned deduplicated `subquestions`,
`fetch_budget_per_subquestion`, `total_fetch_budget`, `allowed`, and `dropped`.
After every fetch batch, append one JSON object for every attempted call to
`fetch_ledger.jsonl`, including failed, cached, or repeated attempts, then run:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" deep-research caps -- --op account --plan caps_plan.json --fetch-ledger fetch_ledger.jsonl --out account_output.json
```

Each valid fetch row consumes one fetch attempt under that saved budget; search
or query rows remain audit history but do not consume `max_fetches`. Continue fetching only
when the latest result has `data.stop=false` and `data.remaining.fetches>0`;
when `data.stop=true`, make no further fetch and deliver an honest partial result
if evidence is incomplete. `caps_plan.json` is a static plan and has no `stop`
field.

For explicit model-call or cost accounting, `account` also accepts:

```json
{"steps":[{"step":"gather","fetches":3,"model_calls":0,"cost_usd":0}]}
```

`data.limits_reached` names which budget ran out. Explicit input audits
caller-reported events; file-backed fetch accounting derives its count from the
durable ledger. The script does not intercept native tools.

## `academic`

Use only when scholarly evidence is relevant. Optional sources are
`arxiv,openalex,crossref,semanticscholar,pubmed`. Results share `id`, `source`,
`title`, `text`, `authors`, `date`, `doi`, and `url` (plus `pmid` when present).
Providers fail independently: retain valid results, record provider-specific
errors, and report partial coverage rather than failing the entire run.

## `compress`

Input:

```json
{"query":"sub-question","sources":[{"id":"s1","url":"https://...","title":"...","text":"..."}],"max_chars":12000}
```

Use `data.kept` directly. It is already de-duplicated, ranked by multilingual
lexical relevance, and selected without exceeding `max_chars`; preserve source
metadata when writing evidence. Compression is relevance pruning, not evidence
validation, and does not permit altered quotes. Do not also feed the full raw
pages to synthesis.

## `citations`

### Verification hygiene

Before citation verification, reject mojibake, replacement characters, or
visibly corrupted multilingual text from `citations_input.json`; select a clean
exact quote from the same fetched official source or mark the affected field
`Not verified`.

For a retained landscape candidate, do not combine unrelated factual fields in
one broad omnibus claim. Persist only the narrow material claims needed by the
retained comparison cells; when evidence does not support a field, expose the
gap instead of manufacturing another claim. Audit every canonical comparison
column before running citations.

On the compact landscape path, let the verifier write `RESEARCH-REPORT.md`
directly from the field-tagged evidence ledger and compact candidate profiles.
Do not read `citations_output.json`, author another recommendation list or
comparison table, reconstruct fields from memory, or use shell code to assemble
the report. Other paths may use the returned Markdown fields directly.

### Compact-path payload

When web excerpts are already bounded and exact evidence rows are saved, skip
`compress`; it adds no decision value here. Citation verification remains
mandatory. For the compact path, `citations_input.json` contains only this
schema; the verifier derives sources, claims, factual cells, claim bindings, and
evidence-source bindings from the sibling field-tagged ledger:

```json
{
  "compact_landscape": {
    "title": "AI desktop-app comparison",
    "boundary": "Scope, cutoff, source limits, and named evidence gaps.",
    "candidates": [{
      "candidate": "Exact ledger candidate name",
      "best_for": "A bounded decision mode",
      "ideal_user": "The user profile for that mode"
    }]
  }
}
```

Each line of `evidence_ledger.jsonl` uses this complete schema; source metadata
after `canonical_url` is optional and no implementation-specific fields are
required.

```json
{"id":"E1","source_id":"S1","candidate":"Exact candidate name","field":"os","claim":"Narrow supported claim in the quote's language","quote":"Exact source text","canonical_url":"https://official.example/page"}
```

Do not mix this with copied `sources`, `claims`, or `comparison` arrays. The
candidate name must exactly match its ledger rows. `best_for` and `ideal_user`
are model inferences, not verifier-proven facts. Before writing these profiles,
compare each proposed path with the saved evidence rows. Recommend a candidate
only when its choice-changing facts are verified. If an unresolved fact could
reverse the path, present only the condition and how either outcome changes the
choice, and keep the result partial. Every factual cell comes from the first
valid matching candidate/field row and otherwise becomes `Not verified`. For
non-compact verification, the expanded sources/claims/comparison schema
remains valid.

### Verification behavior

- Exact quote matching normalizes Unicode, smart punctuation, case, and
  whitespace, but never accepts a paraphrase.
- Keep each narrow claim in its quote's language and retain the decisive source
  wording; translate only outside verifier-bound factual cells.
- `supported=true` requires a known fetched source, exact verified quote, and
  minimum claim/quote content alignment.
- An unknown source, missing quote in source, malformed DOI, or DOI absent from
  the source is flagged. A known source without a quote is weak/unproven.
- When the input file has a sibling `evidence_ledger.jsonl`, missing dates,
  access dates, publisher/type, and limitations are merged by source ID or URL.
- `data.comparison_markdown` is a fixed complete table. Missing cells are
  explicit; unsupported or lexically unrelated field bindings are replaced
  with `Not verified`; each verified factual cell carries its claim-level
  Evidence ID inline, and the Evidence column keeps the row's de-duplicated IDs.
- `data.comparison_coverage` classifies each normalized row after those
  downgrades. Recommendation readiness requires verified OS and setup/ease,
  model capabilities, local/offline or privacy, pricing/cost, and a material
  limitation. The result lists remaining and blocking decision groups without
  turning honest gaps into citation warnings.
- `data.evidence_markdown` contains verified claims, exact quotes, official
  links, source/release dates, access dates, status, and limitations.

The verifier already omits unsupported evidence and downgrades unsupported
cells. It reports complete or partial factual coverage for each model-selected
path. An under-evidenced path remains visible with its named blocking gaps and
must not become a definitive winner. With `--report-out`, it appends the
recommendation, comparison, and Evidence used sections unchanged to the title
and boundary supplied by the compact input. Do not rebuild them from memory or
add a separate source list.
Correct and rerun only when a decision-changing issue has valid evidence that
can resolve it; otherwise use the verified subset and disclose the gap. Never
rewrite the payload merely to remove non-material warnings.

## Final compact report

Generate the compact verified report once with:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" deep-research citations -- --op verify --input citations_input.json --out citations_output.json --report-out RESEARCH-REPORT.md
```

The report contains the supplied title and boundary, then evidence-informed
model-selected paths with complete or partial factual coverage, the only
systematic comparison table, and the final Evidence used section. Do not
reconstruct or rewrite it.

Keep the report compact with one short boundary and one retained evidence row
per factual candidate/field. Do not add model-authored recommendation bullets,
per-candidate sections, or prose that restates comparison-table cells. The
deterministic table uses this literal header:

```markdown
| Candidate | Best for | OS | Setup/ease | Model capabilities | Local/offline | Privacy/data handling | Pricing/cost | Key limitations | Ideal user | Evidence |
```

It gives every retained candidate every column and marks gaps `Not verified`
rather than guessing. The evidence markdown is the de-duplicated reference list
and already contains verified claims, exact source quotes, official links,
source/release dates, access dates, verification status, and limitations. Do not
append a separate bare source list.

In the response after the usable verifier result, emit the final plan update and
publication as ordered calls together; include the final account command only
when caps apply. Do not spend one model round per file or read the unchanged
report back for validation or call `read_files` with `metadata_only:true`. If actual
compaction happens after the write, publish the already-known path and give a
concise handoff instead of reading the full report merely to reproduce it. The
persisted report is incomplete if either non-empty verifier Markdown field is
absent. Shorten narrative prose rather than the table or Evidence used section.
If verification fails, label the claim unverified and do not use it as an
evidence-backed recommendation.
