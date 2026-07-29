# Research and evidence

Use this reference for research-backed planning, drafting, and audits. Optimize for claim support, not source count.

## Contents

1. Research contract
2. Question and perspective map
3. Source selection
4. Source ledger
5. Claim ledger
6. Citation and synthesis rules
7. Contradictions and uncertainty
8. Stop conditions

## Research contract

Record these decisions before searching:

- research question and intended reader.
- geographic, temporal, product/version, and population scope.
- freshness date: the date on which current claims must be true.
- allowed and forbidden source types.
- required viewpoints, comparison dimensions, and known disputed points.
- evidence standard: exploratory, editorial, strict, or high-stakes/qualified-review.

Convert missing noncritical constraints into open dimensions. Do not silently assume a country, product tier, population, or time period.

For ordinary bounded `current-research`, keep the pre-discovery state compact:
record only the scope, freshness date, 3–6 required evidence families, and the
material claim each family must support. Use short human-readable Unicode
labels and reuse each normalized label exactly in source rows. Defer the full
evidence matrix, outline, and prose until the collection gate passes.

## Question and perspective map

Build questions from the article's major decisions, not from generic topic keywords.

```markdown
| ID | Section job/question | Planned claim | Perspective | Evidence/example needed | Source/status | Unresolved gap |
|---|---|---|---|---|---|---|
| Q1 | Explain why adoption changed | Adoption changed for a bounded population and period | operator | first-party data + independent context | open | population and period |
```

Use perspectives that materially change what should be researched. Possible lenses include affected user, practitioner/operator, domain expert, regulator/standards body, critic, buyer, and competitor. Do not manufacture false balance when evidence overwhelmingly supports one conclusion.

Search in layers:

1. Map terminology, entities, timelines, and primary-source locations.
2. Investigate each section question with targeted queries.
3. Challenge the emerging thesis with counterevidence and boundary cases.
4. Close only the gaps that affect the reader promise or publication decision.

For ordinary current-research work, make one discovery batch of at most 3 family-specific `web_search` calls and request at most 5 results per call. It is the first and only batch. In each query, ask for the requested period plus the latest prior-period authoritative baseline. Append negative source filters: Chinese queries include `-百科 -baike -wikipedia`; other queries include `-wikipedia -encyclopedia`. Once the batch returns, search is permanently closed even when results are weak or empty and after an error, gate, retry, recovery, or compaction. Never repeat the batch after a provider/model retry. Immediately persist `search_batch_complete: true`, the actual `search_attempts`, zero `fetch_attempts`, and empty `sources` in `RESEARCH_LEDGER.json`; after compaction, read it before any network or plan tool. A successful same-turn write already confirms the ledger: do not call `read_file` just to inspect it. Preserve unused authoritative result URLs as alternates. Reject encyclopedia, homepage, category, tag, search, and generic research-hub URLs; prefer a dated title-matched report/article or the exact official document. Every fetched URL must be copied verbatim from a successful search result; never guess, synthesize, shorten, or extrapolate a URL path. If an inaccessible commercial first-party report blocks a family, use an exact search-returned, dated reputable article that names the report and label the evidence secondary. A prior-period source covers a family only as an explicitly dated latest baseline, never as current-period measurement. After discovery, emit at most 2 `web_fetch` calls per model tool-use response, each for a different uncovered evidence family, with `maxChars: 2500`. Wait for and classify the whole batch before continuing; never emit 3 or more sibling `web_fetch` calls. Count a source as successful only when it returns usable body text for its required family. Stop only when both conditions hold: at least 3 independent sources succeeded, and every named evidence family has usable support. Neither raw source count nor family coverage alone is sufficient, and no fetch is allowed after both conditions are met. Use no more than 6 fetch attempts and 9 combined search/fetch attempts. After recovery, resume from the source and claim ledgers without another search batch. Exceed the budget only when the user explicitly approves extended research; otherwise mark unsupported families as gaps and deliver.

Keep this bounded path in the source and claim ledgers. Do not call a plan-management tool. For an ordinary analytical article, use the scoped research shape without loading this format reference.

Synthesize each bounded `web_fetch` result directly into the ledgers. Do not use `tool_result_search` for a fetch made with `maxChars: 2500`.

Before drafting, write the literal `RESEARCH_LEDGER.json` file and apply the
canonical `content-writer research_gate` procedure documented in SKILL.md.
Never run the first gate until `fetch_attempts >= 3`. Draft a completed-research artifact only on `READY_TO_DRAFT`. On
`CONTINUE_RESEARCH`, obey `remaining_fetch_attempts`: fetch a saved exact
alternate only when its title, snippet, and publisher cover every reported
`missing_family` and its one new independent URL satisfies the remaining
`source_deficit`, making `READY_TO_DRAFT` plausible on the next gate. If no such
candidate exists, skip the fetch, ledger rewrite, and second gate and deliver
an explicit `HOLD`.
A second gate is valid only after `fetch_attempts` increased. Never run the gate more than
twice. The second gate is final; never fetch after it. Treat
`READY_TO_DRAFT` as collection completeness only;
source quality, factual support, freshness, and claim entailment still require
the checks below.
Production regression binds each fetch to a specific URL observed in successful
search output without persisting the URL; guessed or disallowed URLs fail the
source-binding check.
Record all successful and failed reads in `fetch_attempts`. After a first
gate made only once `fetch_attempts >= 3`, a `CONTINUE_RESEARCH` requires at
least one new exact-result fetch before a second gate. If no alternate exists,
skip that second gate and deliver gaps. Otherwise rerun immediately and never
fetch after the second gate.

## Select sources by role

Judge each source on authority, proximity to the claim, independence, recency, transparency, and scope fit.

| Tier | Typical sources | Use |
|---|---|---|
| A: primary | original paper/data, statute, court/regulator record, official product docs, transcript, filing, direct interview | anchor what happened, what was measured, or what a party officially claims |
| B: authoritative synthesis | standards body, systematic review, respected institutional analysis, strong investigative reporting | explain context, compare evidence, or interpret primary material |
| C: informed context | practitioner analysis, trade press, expert commentary with disclosed basis | add implementation detail or a named perspective |
| D: discovery only | search snippet, anonymous aggregation, SEO summary, unsourced repost, generated summary | find leads; do not cite as evidence unless no better source exists and the limitation is explicit |

Treat a company page as primary evidence for its own documented feature or stated position, not independent proof of superiority or outcomes. Trace quoted statistics to the original dataset or study when feasible.

Count independence, not URLs. Syndicated stories, press-release rewrites, and pages citing the same study form one evidence family.

## Maintain a source ledger

Assign a stable ID to every material source actually read.

```markdown
| ID | Source/title | Type/tier | Date accessed/published | Supports | Limits/conflicts | Disposition | Verification action |
|---|---|---|---|---|---|---|---|
| S1 | [title](url) | primary / A | published YYYY-MM-DD; accessed YYYY-MM-DD | C1, C3 | vendor-authored; enterprise tier only | cite | confirm tier/date; seek independent outcome evidence |
```

Use one of these dispositions:

- `cite`: appears in the artifact.
- `background`: informed synthesis but does not directly support a published claim.
- `challenge`: provides a counterpoint, limitation, or contradiction.
- `reject`: irrelevant, low quality, duplicate, inaccessible, or scope-mismatched.

Do not list a source as read when only a snippet, abstract fragment, or another page's quotation was available. Record access limits.

## Maintain a claim ledger

Track every material claim: a claim that changes the reader's conclusion, action, trust, or risk.

```markdown
| ID | Exact claim or claim plan | Type | Importance | Support | Status | Required action |
|---|---|---|---|---|---|---|
| C1 | Feature X became generally available on DATE | current fact | critical | S1 | supported | cite S1 next to date |
```

Use these claim types:

- `fact`: externally checkable and not meaningfully time-sensitive.
- `current fact`: can change after the freshness date.
- `user-provided`: supplied by the user or private material but not independently verified.
- `inference`: a conclusion drawn from evidence; state the reasoning and boundaries.
- `opinion`: attributed judgment or the author's disclosed position.
- `hypothetical`: invented only as an explicitly labeled illustration.

Use these statuses:

- `supported`: source directly entails the scoped claim.
- `partially supported`: source supports only part, a narrower scope, or weaker certainty.
- `conflicted`: credible sources disagree.
- `unverified`: evidence was not checked or is access-limited.
- `unsupported`: no adequate evidence.
- `stale`: evidence may no longer satisfy the freshness date.

Resolve critical `partially supported`, `unsupported`, and `stale` claims before publication. Narrow, qualify, source, or remove them. Do not solve them by making the wording vaguer while preserving the same implication.

For every rejected or narrowed material claim, record the evidence required to restore the stronger version. Specify the missing population, exposure/intervention, outcome, comparator/baseline, time window, and method rather than writing only "needs a source."

## Cite and synthesize precisely

- Place a citation immediately after the claim or tightly scoped paragraph it supports.
- Keep one citation number or link stable for each unique source.
- Preserve source qualifiers such as sample size, geography, time window, plan/tier, methodology, and confidence interval when material.
- Attribute opinions and forecasts to named people or institutions.
- Distinguish correlation, causation, projection, target, estimate, and measured result.
- Quote only when the exact wording matters. Verify the exact words, speaker, date, and context.
- Prefer synthesis over source-by-source summaries. Organize the prose around the reader's question, then use sources as support.
- Include a sources section only for sources cited in the delivered artifact unless the user requests a bibliography or research log.

Never use a citation to decorate an adjacent claim it does not entail. If one paragraph contains multiple distinct claims, cite each claim or rewrite the paragraph so scope is unambiguous.

## Handle contradictions and uncertainty

When credible sources conflict:

1. Check whether they measure the same population, period, definition, product version, or outcome.
2. Prefer direct and method-transparent evidence for the exact claim.
3. Explain the source of disagreement when known.
4. Report a bounded range or competing interpretations when the conflict remains.
5. Avoid majority-vote synthesis by source count.

Calibrate language:

- use `shows` or a direct factual verb for strong direct support.
- use `suggests`, `is associated with`, or `is consistent with` for limited or observational evidence.
- use `the company says` for unverified first-party claims.
- use `could`, `may`, or an explicit scenario for forecasts and possibilities.
- state `not verified` or remove the claim when evidence is unavailable.

## Stop research deliberately

Stop when all are true:

- the reader promise and comparison dimensions are covered.
- every critical claim is supported, narrowed, removed, or explicitly held.
- at least one challenge pass has tested the main thesis when appropriate.
- recent searches mostly repeat known evidence or lead to the same evidence families.
- remaining gaps are nonmaterial or require user/private access.

Before another fetch, check the ledger for the same URL and evidence family. Do not retry the same failed route, reread an accepted source, or reopen a closed gap after context compaction. Resume from the ledger and use one alternate source within the remaining budget when access fails.

Do not stop merely because a target number of links was reached. Do not continue merely to make the bibliography look large.
