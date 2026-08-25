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

A user-requested narration change — voice, speed, language, or script wording —
is a revision of the SAME composition: amend the signed selection
(`audio.narration_intent` on schema 2; the `voice` parameter on schema 1),
approve the amendment with the user's own change message as evidence, and
re-run `composition.materialize_narration`. Never create a new composition or
candidate line for an audio-only change: the visual identity, preview
approval, and every visual artifact carry over unchanged, and rebuilding them
replays every confirmation the user already gave. Rebuild only when the host
leaves no in-place path — a blocked narration invariant that the listed
recovery operations cannot clear — and tell the user why before doing it.
When re-materialization succeeds with visual identity unchanged (the result
says `redraft_same_turn_then_final_video_stop`), continue in the same turn to
`composition.draft` — the prior video track is reused, so it completes in
seconds — and present the new-voice draft at the final-video stop as the
single audition and confirmation, with the narration audio attached. Do not
stop for a standalone audio audition first: one listen, one decision.

The native narration transaction ledger owns convergence. When it returns
`E_TTS_RETRY_EPISODE_EXHAUSTED`, the unchanged request has reached its automatic
uncertain-outcome boundary, not a permanent user-retry prohibition. The result
keeps the current visual candidate and supplies a `narration_retry_offer` for
exactly one additional billable request. If no fresh user decision exists in
the current turn, present that candidate, the unresolved billing risk, and one
`narration_retry_decision`; send no request and end the turn. Do not open Paid
generation or Production plan confirmation.

A new real user turn that clearly approves the displayed retry — including a
plain request such as “continue generating narration” — authorizes exactly one
`composition.materialize_narration` call with native-object
`decision_evidence={source:"user_message",gate:"narration_retry",decision:"approve",quote}`.
This remains true after any number of earlier inconclusive requests: the native
ledger persists the new authorization before dispatch and binds it to
`authorized_turn_id`, so replaying that same turn cannot send twice. If the new
request also fails inconclusively, automatic continuation stops again and a
later real user turn may make a new one-request decision. The model never
counts, resets, or overrides attempts itself.

Historical conversations may contain an older host result saying there is no
retry offer, or that a submitted retry was
`superseded_by_current_transaction_ledger`. Those fields describe what happened
in that old turn; they are not a permanent prohibition after the host/Skill is
upgraded. Never reuse the old reply, but if the current real user newly asks to
retry, call `composition.materialize_narration` with evidence from the current
message and let the native ledger decide. A question or a reply that does not
approve a new request leaves the retry pending and sends nothing.

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
artifact/readiness. Open exactly one `narration_retry_decision`, leading with
the host-recommended default and one direct question — not an open
questionnaire:

- Proceed (recommended default): keeps the complete current audio, records a
  duration waiver, and retimes without truncation. Present it as what happens
  on a plain "好/确认" reply.
- Revise again (alternative): authorizes one additional synthesis after the
  free fit check.

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
