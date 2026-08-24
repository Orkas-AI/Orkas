<!-- gate-control reference. Read this only when presenting or consuming one
of the five stopping decisions, or when handling a COMPOSE narration retry. -->

# Confirmation artifacts and stopping protocol

## Show the work; stop only five times

VideoStudio emits no confirmation forms. The input channel is plain prose:
never emit `<agent-input-form>`, and do not treat retired forms in conversation
history as examples. Every artifact is shown in an ordinary message. User-
requested changes and repairs are already authorized; never confirm them again.

Exactly five decisions stop the run: direction, production plan, paid
generation, keyframe preview, and final video. Present the current artifact with
its exact locator, a concise next-action/cost/QA note, one direct question, and
`<plan-interaction status="open" />`; then call no more tools. Revised shots,
repairs, and partial progress are not stops: publish them and keep producing.
The same closing marker applies to any other message that hands the next step
to the user — a blocked report, an exhausted repair budget, a missing
capability: without it the runtime reads the stop as an unfinished turn and
bounces the reply.

## Direction and preview

Direction comes before any plan file. Route the request, resolve locked brief
facts, then show two or three genuinely different concepts for the same brief:
one-line name and description each, locked production line/aspect/duration/video
language/audio mode/supplied-asset usage/cost note, and one question. Write no
copy, narration, manifest, or art direction yet. A brief that already specifies
the video still stops here with one concept.

The keyframe preview is the stop between capture and rendering/assembly. When a
standalone composition's full snapshot set exists, or an assembled production
has no `uncaptured_segment_ids`, end the turn with every frame's exact locator
and one invitation to change it or reply `继续` / `continue`. Only a later real
user reply naming no change is go-ahead. An empty, unrelated, question-only,
delegated, or background-resume turn is not. Status/read/repair never records
go-ahead.

The preview stop happens once per visual identity. Narration text, voice, audio,
or narration timing changes preserve silent frames and their go-ahead when
scene windows and visible output are unchanged. Visible copy, layout, assets,
scene order/windows, or motion creates a new identity: capture and show the new
complete set once. Unchanged internal recaptures publish progress and continue.

Until the user replies, `composition.draft` returns
`E_PREVIEW_GO_AHEAD_REQUIRED` with frame paths. Do not retry or bypass it. A new
user turn is interpreted semantically by the model choosing
`composition.draft`; the host verifies the prior-turn preview and current visual
identity. Preview go-ahead uses no `decision_evidence` and is not stored by
`composition.status`.

## Exact artifact locators and pending decisions

“Show the current artifact” must be executable. Carry the exact current artifact locator
returned by native state—the contact-sheet and frame-path set, or complete draft/video path—into both the
review package and user response. Never publish a superseded locator or replace
it with “show latest”. If the user asks a question while a decision is pending,
answer from current artifact locators and leave the decision pending without
asking again. Negated prose is not approval.

Only a real user turn decides a gate. `E_GATE_USER_TURN_REQUIRED` with
`current_user_message_available:false` and `next_step_owner:user` means show the
artifact, ask once, and end. Never retry in that turn or treat delegated task
text as the user's decision.

## Gate artifact table

| Gate | Required review artifact | Evidence gate | Approved transition |
| --- | --- | --- | --- |
| Direction | two or three concepts plus locked facts; no plan file | `direction_decision` | write plan from the chosen concept |
| Production plan | locked direction summary plus COMPOSE manifest/narrator or production EDL; an unapproved EDL's native `plan_summary` is presented verbatim once | `gate_b_decision` | composition -> `composition.approve_plan`; production -> `production.approve_plan` |
| Paid generation | exact billable segment count plus current credit/billing evidence | `gate_c_decision` | `production.approve_generation` before provider call |
| COMPOSE narration retry | current visual candidate, uncertain prior request, and exactly one proposed new request | `narration_retry_decision` | one fresh `composition.materialize_narration` transaction |
| COMPOSE narration timing | complete audio, measured duration/band, visual readiness, and exhausted automatic timing retry | `narration_retry_decision` | one user-authorized synthesis or duration waiver using complete audio |
| Final video | draft plus QA headline plus the draft result's `delivery_options` | `gate_d_decision` | composition -> `composition.approve_draft`; production -> `production.status` delivery check |

At the final-video stop, show both `delivery_options` with their
`estimated_minutes` so the wait is chosen knowingly. A plain confirmation
exports the high-quality default; picking the faster preview-quality option is
itself the user's acceptance of the lower quality — pass its exact `call`
parameters and ask nothing further.

## Production plan content and language

The Production plan opens with the locked direction summary—line, aspect,
duration, video language, audio mode, supplied-asset usage, and billable cost
note—then the plan digest. It restates rather than reopens settled facts. Preserve
every explicit brief constraint; concepts live inside those constraints. Do not
interrogate the user for open casting, ethnicity, audience, style, tone, or
visual preferences unless truly missing and blocking.

Resolve initial video language from explicit request, then User UI language,
then English. Map `zh`/`zh-CN` to `zh-CN`, `en`/`en-US` to `en`, `ja`/`ja-JP`
to `ja`, and `pt`/`pt-BR` to `pt-BR`;
unavailable or unsupported UI language falls back to `en`. The
supported deliverable languages are English, Simplified Chinese, Japanese, and
Brazilian Portuguese. State it in the plan and write plan artifacts in that
language. A reply changing language is a revise instruction: rewrite canonical
files and show the one updated plan, never approve mismatched files. Later UI
language changes do not alter the locked deliverable language.

For a production EDL, present native `plan_summary` verbatim once. If the user
already answered while `plan_approval_current:false`, the transition is owed;
never present the plan again. Plan approval authorizes only the owning
`approve_plan`, never paid generation, render, or export. Send `task_title` on
every plan confirmation/amendment in the user's words; keep it stable unless the
task changes and omit rather than invent it.

## Paid generation and narration retry

Paid generation may open only from a current signed plan and fresh
`production.status` whose quote is available and sufficient. Show billable
generation count; expected, maximum/required, and available credits; managed
fallback coverage; and externally billed/unverified segments. A failed or
pending provider attempt is not reusable authorization. If the latest status
already has current quote/signature and an unreconcilable outcome, do not query status again.
If the user explicitly asked to retry, open that fresh Gate C immediately with no host call;
only later approval dispatches a new output path. Never
interleave shot confirmations.

COMPOSE narration is not Gate C. When materialization returns an uncertain prior
request plus `narration_retry_offer`, first complete and expose the visual
candidate. Explain that usable narration was not returned and may have been
charged, show that the proposal sends exactly one new request, and use
`narration_retry_decision`. A clear user reply calls
`composition.materialize_narration` with native-object decision evidence. The
host consumes one real user turn once, archives the failed transaction, and
creates one fresh attempt. Never reuse an earlier reply or ask again after the
same attempt succeeded.

For identity drift, ledger exhaustion, old-session submissions, or measured-
duration convergence, read `narration-recovery.md`. Core timing uses target plus
or minus `max(target * 5%, 5s)`, accepts in-band audio, permits one native-owned
automatic timing revision, then presents exactly two visible choices. “Proceed”
must state that complete current audio is kept without truncation. The model
does not count attempts or send another request without current authority.

An AUTO child inherits parent plan approval only through
`composition.approve_plan` with owning `plan_path` and `segment_id`; mismatch
returns to the single parent EDL plan confirmation, never a child gate.

A narration-retry rejection is recorded by the same operation:
`composition.materialize_narration` with
`decision_evidence={source:"user_message",gate:"narration_retry",decision:"reject",quote}`.
It sends no provider request; do not invent a “record rejection” operation.
