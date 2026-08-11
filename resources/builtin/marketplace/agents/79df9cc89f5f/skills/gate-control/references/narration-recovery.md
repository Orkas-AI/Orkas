# Narration recovery and duration decisions

Read this reference whenever COMPOSE narration identity changes, a retry ledger
is exhausted, an old-session decision arrives, or measured audio misses its
approved duration band.

## Stable request identity and uncertain provider outcomes

Narration confirmation identity follows the stable synthesis request:
narration text, `route_ref`, `voice_ref`, language, speed, and format. Catalog
display names, provider implementation labels, paths, formatting, and other
locator/presentation metadata are not user-approved intent. Refresh those
facts internally without reopening Production plan confirmation or replacing
an already-recorded one-request retry authorization. If a non-billable local
check interrupts dispatch, call the repair/reconcile operation and resume the
same persisted authorization; never ask for it again.

The native narration transaction ledger owns convergence. When it returns
`E_TTS_RETRY_EPISODE_EXHAUSTED`, the unchanged request has reached its total
uncertain-outcome boundary. Do not open another narration, paid-generation, or
production-plan confirmation, even if the current reply repeats an earlier
approval. Present the returned current visual candidate and plain-language
conclusion, send no request, and wait for provider reconciliation or a real
user-requested narration-content/voice change. The model must not count,
reset, or override attempts itself.

A resumed old-session submission may have been opened before the latest
transaction facts were recorded. When native returns
`submitted_decision_status=superseded_by_current_transaction_ledger`, say
plainly that the user's reply was received but the older retry proposal is no
longer actionable, that no new request or charge was created, and that the
visual candidate remains available. Treat the old action as safely closed:
do not claim confirmation was missing, reuse its reply, retry the native
operation, or ask again.

## Measured-duration convergence

Measured-duration convergence is a separate durable episode from an uncertain
provider retry. Estimated and measured narration both use the native-reported
narration target plus or minus `max(target * 5%, 5s)`. That target is the
approved delivery duration after explicitly silent scene windows are reserved;
those windows are not speech budget. An in-band result is accepted immediately;
never trim the text or synthesize again merely to hit the nominal target.

After an out-of-band initial result, native permits one automatic
timing-focused text revision and one revised synthesis across the changed
`text_sha256`. When that request returns
`E_NARRATION_TIMING_USER_DECISION_REQUIRED`, show the current complete audio,
measured duration, accepted band, and truthful current visual
artifact/readiness. Open exactly one `narration_retry_decision` with two neutral
choices rendered as two separately labeled visible options:

- Revise again: authorizes one additional synthesis after the free fit check.
- Proceed: keeps the complete current audio, records a duration waiver, and
  retimes without truncation.

The visible proceed choice must explicitly say both that the complete current
audio is kept and that it will not be truncated; never leave either consequence
implicit in a generic “proceed” or “retime” label. End the turn. Do not send
another speech request, reopen Gate B/C, reset or recount the persisted episode,
or describe a runtime scaffold as completed visual engineering.

A direct reply selecting another revision is current-turn authority for the
bounded edit/check/prepare/materialize path and exactly one additional speech
request. A direct reply selecting progress with the current audio is recorded
by `composition.materialize_narration` with
`decision_evidence={source:"user_message",gate:"narration_retry",decision:"reject",quote}`.
That call reuses the existing audio, sends no provider request, records the
waiver, and expands actual composition timing when needed. Questions about the
choice leave it pending and send no request.
