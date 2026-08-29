<!-- deep-research reference. Read this only for a low-risk landscape or
product comparison, including its fetch-only checkpoint and zero-source
fallback. -->

# Compact low-risk landscape

## Execution kernel

Before acting—or, in a tools-off handoff, before describing the run—make every
item in this compact contract explicit. A brief preflight is incomplete if it
omits one:

1. Treat two fetch batches and eight `web_fetch` calls as an efficiency target,
   not a default ceiling. Create caps only when the user, task, cost policy, or
   resumed state supplies a real budget; an arbitrary call count never decides
   whether useful research may continue.
2. Use one combined `web_search`, freeze the smallest diverse candidate set,
   then emit the known independent official `web_fetch` calls concurrently.
3. After every fetch batch, append all attempt rows and reassess evidence gain.
   Normally stop after the initial batch when the comparison is ready. Otherwise
   search only for a named gap that could change eligibility, compatibility,
   recommendation order, or the recommended user path. When caps apply, also
   run file-backed accounting and require remaining budget.
4. Keep newly written unchanged plan and ledger state in memory; do not reread it
   merely to continue the next known step.
5. Persist exact evidence, run `citations --op verify`, assemble and validate
   `RESEARCH-<topic>.md`, then publish it.
6. Make one final plan-status update after verified assembly. Prefer a batched
   update when several statuses are already known, but one isolated update stays
   valid and work never waits merely to form a batch.

## Discover, freeze, and fetch candidates

Start with one combined `web_search` that names the requested category and
decision dimensions without forcing a site or domain filter; model-memory
candidate names may appear only as optional query terms, not as assumed results.
Wait for the search result before any `web_fetch`. If it fails or returns no
eligible official source, change one material strategy dimension—query terms,
language, site constraint, or provider path—and search again when no cap applies
or the applicable budget has room; never repeat the same failed query.

From the returned results, select one best official primary URL per retained
candidate, preferring the product site, official documentation, download page,
or app-store page; use an official repository only when it is the primary
product source or an eligibility claim requires it. A URL recalled only from
model memory is undiscovered and must be omitted rather than guessed.
Deduplicate and freeze every retained candidate before the initial fetch,
capped at five, then emit one best official URL per candidate together. Later
targeted searches may discover decision-changing pages for those retained
candidates, but must not introduce a new candidate merely to enlarge the list.

One or two eligible official URLs are an evidence-limited scope, not a reason to
discard valid sources: fetch them and label the comparison partial. Use the
source-unavailable fallback below only after materially different discovery
strategies yield zero eligible official URLs or an applicable saved cap says
stop. Retain three to five candidates when discovery supplies that many eligible
distinct paths, always using the smallest set that still covers materially
different user paths. Once a path has a representative, do not add a
near-equivalent candidate just to enlarge the list.

When bounded excerpts are already saved, skip `compress`, but still run
`citations --op verify`.

For normal or high-stakes research, once independent official URLs are known,
emit their `web_fetch` calls together so they run concurrently. Use at most
eight URLs per batch and continue in bounded batches only on that non-compact
path. Sequence a later fetch only when its URL or necessity genuinely depends
on an earlier result.

Emit one initial fetch batch containing one official primary source per retained
candidate using `{"url":"...","maxChars":4000}`; never split already-known
sibling URLs across serial responses and do not fetch both a product homepage
and repository for the same candidate by default. Two fetch batches and eight
`web_fetch` calls are the compact efficiency target, not a hard ceiling. Execute
independent fetches concurrently, then fill the comparison-coverage matrix for
main use case, OS, setup/ease, model capabilities, local/offline operation,
privacy/data handling, pricing/cost, key limitations, and ideal user.

## Readiness-driven gap collection

After each batch, build a readiness view from saved evidence. Recommendation-
ready means verified OS and setup/ease, model capabilities, local/offline or
privacy, pricing, and a material limitation. A gap is decision-changing only
when leaving it unknown could change candidate eligibility, operating-system
compatibility, recommendation order, or the recommended user path.

Use exact official URLs already discovered first. If a decision-changing gap
has no known URL, run a targeted search using a meaningfully different query
or source strategy, then fetch the smallest set of newly discovered official
URLs likely to close it. Reassess readiness and evidence gain after every batch;
when caps apply, run file-backed accounting too. A successful distinct source
that resolves or materially narrows a named gap is progress and resets the
no-gain streak, so useful collection may expand beyond two batches, eight
fetches, or sixteen fetches. It must never expand merely to fill the matrix or
achieve ordinary completeness.

For an inaccessible source, do not keep varying URLs on the same blocked origin.
Use one materially different source or provider strategy. If that strategy also
adds no usable independent source or decision-changing evidence, stop collection
and expose the gap. Also stop when enough distinct rows are recommendation-ready,
an applicable cap says stop, or the next batch has no named decision-changing
gain. Mark remaining cells `Not verified` and deliver an evidence-honest partial
result. Never silently raise a real saved cap to avoid a partial answer.

Never fetch one follow-up page per candidate for symmetry, ordinary
completeness, or a nonessential feature detail. Never fetch homepage, docs,
download, pricing, privacy, app-store, repository, and release variants for
every candidate by default. Reuse access dates and visibly stated source,
release, or price dates already returned by the fetch; do not make an API or
metadata fetch solely to obtain freshness. A repeated fetch of the same
normalized URL after compaction is served from the run cache even if `maxChars`
changes, but still wastes context, so do not request it again. This is evidence-
based early stopping for reducing actual calls and returned noise, not a change
to platform tool or network ceilings.

## Plan and compact evidence rows

For a normal compact run, create exactly three execution-plan milestones:
gather, verify, deliver. Do not update their intermediate statuses. After clean
verification and report assembly, make one final plan update; prefer one
`set_statuses` call because all three final statuses are then known together.
The API still permits `set_status` for one genuinely isolated change, and work
must never wait merely to form a batch.

Immediately after each fetch batch, keep only distinct evidence that may support
a requested comparison field or decision. Write one compact
`evidence_ledger.jsonl` row per retained exact quote and narrow claim; use no
fixed row count. Every row includes the exact candidate name and `field` or
`fields` drawn from `os`, `setup_ease`, `model_capabilities`, `local_offline`,
`privacy_data_handling`, `pricing_cost`, and `key_limitations`. Keep the strongest
row first when more than one could support the same candidate/field. Tag a field
only when the quote directly answers that field's decision question; exact text
or keyword overlap alone is not enough. Never reuse a fact to fill a different
field, and leave unsupported fields absent. For example, operating-system or
download availability alone does not prove setup ease, and cloud/local status
alone does not prove privacy handling. Keep each quote at or below 200
characters, omit repeated source prose, and give every claim a unique stable
ID. Do this before another fetch batch.

Exception: when the user explicitly requests a fetch-only checkpoint, do not
call `manage_execution_plan`; write all batch statuses to `fetch_ledger.jsonl`
together, account only when a real cap applies, then pause without extracting
evidence rows, running citations, publishing outputs, or drafting
recommendations. After actual context compaction, read this ledger and any saved
cap before a network call; never refetch evidence already recorded. A tool-call
ID beginning `call_` is not a persisted result ref; never use `tool_result`
unless the host ledger explicitly contains `ref=<opaque-ref>`.

## Eligibility and recommendation

When the requested category has a defining eligibility criterion such as open-
source licensing, verify that criterion from an authoritative source before
retaining or recommending a candidate. For an everyday desktop-app
recommendation, supported desktop operating systems and a concrete installation
path are mandatory eligibility fields. If either remains `Not verified` after
the official primary-source fetch, make the smallest official download-page or
platform-support gap fetch; if it still cannot be verified, exclude that
candidate from ranked recommendations and present it only as an explicitly
under-evidenced discovery lead. Verify license or project activity only when the
user's scope or a decision-changing claim requires it; do not turn those fields
into default gates for a general desktop-app comparison.

Do not name a universal or generic-audience best overall candidate unless the
verified comparison establishes that it dominates the retained alternatives
across every material decision mode and eligibility field. When different
products fit different user paths, lead with a conditional decision rule or
persona-specific recommendations such as simplest private chat, document
workflows, or extensible open-source alternative; label any remaining preference
as an inference and cite the decisive Evidence IDs. Missing or Not verified
comparison cells can never support a universal first choice.

The citations verifier returns `comparison_coverage` in the persisted result and
`comparison_coverage_details` in the compact command result. Citation-clean and
recommendation-ready are separate. A `recommendation_ready` row has complete
factual coverage for a model-selected path. Coverage is diagnostic, not a
completeness gate: a missing field that cannot change the choice does not block
a supported recommendation. The model decides whether the verified facts
support the proposed path. If it depends on a blocking gap, continue only when
a targeted source or materially different strategy has a reasonable chance of
changing the decision; otherwise stop and deliver an evidence-honest partial
result that names the condition and how the unresolved fact could change the
choice. An `under_evidenced` row is not a recommendation: it may remain only as
that conditional path, never as complete research. The verifier does not make
this semantic decision.

## Source-unavailable advisory fallback

For a low-risk landscape, give provisional user paths in the current response.
Cover the material decision modes; for each, name what to verify first, why, and
the disqualifying checks. State the intended research cutoff and an access or
verification date for every retained source. Include a literal evidence-row
template for candidate, claim, authoritative source, source date, access date,
exact quote/value, support status, confidence, and limitation.

Use a conservative default verification order and tie-breakers, with breadth set
by the decision rather than targeting an arbitrary candidate or path count.
Label these as verification shortlists, not current recommendations, and label
every item `discovery seed — not verified`; not a current finding, ranking, or
recommendation. For legal, medical, financial, policy, or safety questions,
abstain instead of naming unsupported choices.
