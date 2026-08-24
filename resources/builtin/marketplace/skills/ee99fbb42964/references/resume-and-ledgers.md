<!-- deep-research reference. Read this before any new network call when
durable research files already exist, pending sources are fixed, the user has
revised scope, or actual context compaction occurred. -->

# Durable resume and ledgers

## Execution kernel

Before any resumed network call, load the saved cap and both ledgers, reuse the
existing plan, and resume only unfinished subquestions. Build one in-memory set
of normalized recorded queries and URLs. Immediately before every pending
`web_search` or `web_fetch`, check that set and skip recorded work; after each
attempt, append its status and update the set. Never reset prior accounting.
The final handoff names `caps_plan.json`, `fetch_ledger.jsonl`, and
`evidence_ledger.jsonl`, confirms recorded work was not repeated, and reports
prior + new = cumulative attempted calls.

## Fixed pending-source resume

When `caps_plan.json` already supplies `pending_source_targets` and
`resume_limits`, the persisted resume contract outranks the ordinary collection
loop:

1. Read `caps_plan.json`, `fetch_ledger.jsonl`, and `evidence_ledger.jsonl` once,
   preserve prior rows and accounting, and freeze the unfinished pending URLs.
   When `discovery_search_allowed` is false, do not search.
2. Emit all allowed pending URLs together in exactly one concurrent fetch batch.
   `max_new_network_calls` and `max_new_calls_per_unfinished_subquestion` are
   attempted-call ceilings: a success, timeout, provider error, cached call, or
   other failed attempt consumes its slot immediately. Never retry a failed URL
   in the same resume run, even when the failure looks transient.
3. Append one status row for every attempt before further research processing.
   Each `append_file` content value starts directly with `{`, contains exactly
   one JSON object, and ends with one newline; never prefix it with `\n` or create
   an interior blank record in a JSONL ledger. Extract evidence only from
   successful results; a failed pending source leaves that subquestion explicitly
   `Not verified`.
4. If an append returns `E_STALE`, reread only the target ledger, merge the
   still-pending rows, and append once. The stale recovery is a local write
   repair: do not refetch, reread all state, restart the round, or spend another
   network slot.
5. Reconcile prior + new attempted calls cumulatively. The visible handoff must
   name the three durable files, show prior/new/cumulative attempt counts, and
   use the literal shape `prior N + new M = cumulative K/L attempted network
   calls` (for the saved 2+2 fixture: `prior 2 + new 2 = cumulative 4/4`), then
   directly summarize established obligations, official support measures, and
   official source/citation attribution. Do not hide these results behind a
   published report link; name every failed-source gap as `Not verified`.

## Scope revision

The user's latest scope instruction is authoritative. Update `caps_plan.json`
before collection or synthesis, preserve already charged work, reuse evidence
that remains in scope, and mark excluded evidence out of scope rather than
deleting its ledger rows. Do not reset budgets or repeat completed searches.

## Deduplication gate

Treat network deduplication as a pre-call gate, not a final-report claim. First
list the workspace files. If the three durable files do not exist, create a new
plan and ledgers without spending a standalone response on empty files; do not
call `read_files` on guessed missing paths or treat a fresh task as a resume. If
they do exist, read `fetch_ledger.jsonl` once at task start, durable resume, or
after actual context compaction, then build an in-memory set of normalized
queries and canonical URLs; do not repeatedly call `read_files`
for the same unchanged ledger. Within an active run, keep just-written plan,
ledger, and command-input content in memory; re-read only after an external
change or for exact-byte validation.

Immediately before each `web_search` or `web_fetch`, compare the candidate
against that loaded set. After the network call, append its status to
`fetch_ledger.jsonl` before another network call and update the in-memory set.
Include every actual attempted call, including cached or accidentally repeated
calls, in caps accounting. Obey persisted `pending_source_targets` and
`resume_limits` exactly; when `discovery_search_allowed` is false, make no
`web_search` call. If native tool-call count exceeds ledger or account count,
stop and reconcile. After a provider failure or a loop-detection nudge, never
repeat an identical tool call; use already known authoritative URLs or deliver
an evidence-honest partial result.

A durable-resume final status must explicitly name `caps_plan.json`,
`fetch_ledger.jsonl`, and `evidence_ledger.jsonl`; state that only unfinished
subquestions were resumed and recorded work was not repeated; and report that
the prior budget was carried forward with the actual attempted network-call
count.

## Ledger schemas

`fetch_ledger.jsonl`: `kind`, normalized `query` or `canonical_url`,
`subquestion`, `status`, `accessed_at`, charged counters.

`evidence_ledger.jsonl`: `schema_version`, `source_id`, `canonical_url`,
`title`, `publisher`, `published_at`, `accessed_at`, `source_type`,
`subquestion`, `claim`, exact `quote`, `confidence`, `limitations`, and optional
`content_sha256`. Keep quotes at or below 1,600 characters; the compact landscape
path uses its stricter 300-character limit.

Read `caps_plan.json` and only the relevant ledger tail at task start, durable
resume, or after an actual context compaction before any new request. Within an
active run, retain loaded state in memory and do not re-read a file just written
unchanged; re-read only after an external change or for exact-byte validation.
Never refetch a completed URL because its earlier output left model context.
The Skill body itself is stable during a run: after a complete initial load, do
not reload it after compaction when the checkpoint preserves its path and command.
