---
ownerAgent: 79df9cc89f5f
name: gate-control
min_app_version: "1.6.5"
description_zh: VideoStudio 的统一审核授权与状态转换规则；把用户决策、产物范围、原生 QA 状态映射为唯一下一动作，防止重复确认和错误恢复。
description_en: VideoStudio's canonical gate-authorization and transition policy. Maps user decisions, artifact scope, and native QA state to one next action without duplicate confirmations or false recovery gates.
category: creation
---

# gate-control

This is the **single canonical policy** for VideoStudio gate decisions, post-gate edits, and recovery across COMPOSE, AUTO, GENERATE, and EDIT. Workflow and line skills may describe artifacts and production operations, but must not create a competing authorization policy.

## Decision kernel — apply this before the detailed rules

Resolve every turn from the latest durable facts with this short sequence:

1. **Identify the current candidate and current pending user decision.** A
   pending decision is status, not permission to ask again.
2. **Classify the dependency.** Only a genuine user decision about a
   creative/delivery choice or new billable attempt is a user dependency.
   Missing files, stale locators, parameter-shape errors, interrupted
   operations, equivalent locator/metadata changes, and QA failures with passes
   remaining are system work. This system work does not justify stopping. An
   exhausted visual-QA cycle is a creative fork: show its evidence/options and
   wait.
3. **Choose one result-aware execution horizon.** List or execute only
   operations whose preconditions are already true. If an operation's result
   decides the branch, stop the planned horizon at that operation, inspect its
   result, and then choose the next operation in the same agent turn.
4. **Use exact interfaces.** In `calls`, keep the exact native operation token
   or named Skill/file operation. Do not add a `video_studio.` prefix,
   replace it with prose, or invent generic recovery/status. Include every mandatory binding:
   AUTO child inheritance, for example, needs `composition.approve_plan` plus
   its `plan_path` and `segment_id`.
5. **End in exactly one place:** another immediately executable operation, one
   of the five stopping decisions with its current artifact, a completed
   delivery, or an external uncertainty boundary with the current artifact and
   concrete options. Showing an artifact is not an ending in itself — publish
   it and keep going — EXCEPT at the five stops, where the artifact IS the
   question: a complete keyframe set ends the turn once per visual identity
   (after its go-ahead, unchanged recaptures do not stop again). Never combine
   mutually dependent future stages.

These are structural invariants, not a state-machine enumeration. The model
still determines the next action from current evidence.

### Direction-to-plan handoff

Keep the first two stops mechanically distinct even when the brief is clear:

- **Direction stop:** route and lock the facts already settled by the brief,
  then show two or three concepts without writing a manifest, script,
  narration copy, or art direction. Use the exact localized name from the
  table below; in Chinese this is `制作方向确认`, never a renamed label such
  as `创意方向确认`.
- **COMPOSE plan stop after the user chooses a direction:** call
  `speech.capabilities`, write the canonical
  `project/composition/composition-manifest.json` from that chosen concept,
  run the free `composition.check_narration_fit`, and only after those concrete
  results present the one `制作方案确认` / `Production plan confirmation`.
  “Write a plan draft”, “prepare review content”, or copying voice fields into
  an unspecified object is not a completed canonical plan, and omitting the
  fit check leaves the review artifact incomplete.

### Stopping test

Before ending a turn on a user decision, all of the following must be true:

- the decision is one of the five: direction (before any plan file exists),
  production plan, paid generation, keyframe preview (the complete frame set,
  before any rendering or assembly, and only while its visual identity has no
  recorded go-ahead), final video;
- that same decision is not already pending;
- the exact complete review artifact exists now;
- every native prerequisite has returned success for that exact candidate;
- no call listed after the question depends on its future answer.

If any item is false, do not stop. A user question, stale reply, already-pending
decision, technical recovery, or a conditional “ask after QA passes” never ends
a turn on the user.

After a local visual mutation, the next artifact does not exist until the exact
mutation and the required `composition.inspect` and `composition.snapshot` calls
have succeeded. In a planning response, name those exact calls rather than
emitting `calls:[]`. Invalidate only approvals and evidence that actually
existed for the prior candidate.

An unknown external provider outcome is not recoverable by repeatedly calling
a status operation that has no query/reconcile capability. Preserve the
pending transaction. If the user explicitly requests a new billable attempt
and the latest status already contains a sufficient current quote, the only
new dependency is one fresh Paid generation confirmation: open it with no
provider call in that turn. If the retry boundary is exhausted, show the
current artifact and exactly two honest paths—wait for provider reconciliation,
or make a real user-intent change that creates a different request.

### No-runtime branch

When the current transport cannot execute production tools or render media,
do not stop at the plan confirmation. Return the complete explicitly unexecuted production package:
assumptions, script/narration, timed storyboard, exact visible copy/captions,
visual/audio actions, provenance/fallback assets, export target, preview review,
and final QA. Do not claim media exists or title it “Production plan
confirmation”. Identify each source as user-supplied, self-authored/generated,
or third-party; third-party use needs source, license, retrieval date, and a
project ledger. Without licensed music, specify silence or a future rights-safe
search, never an imaginary mood-only BGM.

## User-facing confirmation names

`Gate A/B/C/D` and the `*_decision` ids are internal protocol terms. They may appear in logs, diagnostics, tests, and tool calls, but **must not appear in normal user-facing headings, forms, progress updates, or error explanations**. Use the current User UI language and these plain-language names instead:

| Internal protocol | Chinese UI | English UI |
| --- | --- | --- |
| Gate A | 制作方向确认 | Direction confirmation |
| Gate B | 制作方案确认 | Production plan confirmation |
| Gate C | 付费素材生成确认 | Paid generation confirmation |
| Preview Gate | 关键帧预览 | Keyframe preview |
| Narration retry | 旁白重试确认 | Narration retry confirmation |
| Gate D | 成片确认 | Final video confirmation |

Do not write hybrids such as “Gate B（制作方案确认）” in normal user output. Show only the localized plain-language title. When explaining a blocker, describe the missing user action or artifact directly—“请先确认制作方案”, “Please confirm the production plan”—and keep internal error codes to diagnostic details. Never expose `budget_exhausted`, “QA budget”, or retry-counter language to the user. Say that the previous repair strategies did not resolve the recorded finding, which artifacts were preserved, and present the returned user options in plain language so the user chooses the direction; another internal attempt is one of those options, never the silent default.

Every prose span emitted outside a tool call, including progress/process
summaries before the final message, is user-visible presentation copy. Internal
production evidence is not presentation copy. In a successful
keyframe-preview message, lead with the current contact sheet/frames, say in
one short sentence that the preview is ready, then ask one direct question:
name changes, or reply `继续` / `continue` to start the draft. Passing checks
and non-blocking advisories stay silent. Do not print “Frame review results”,
severity words such as `advisory`/`warning`, raw finding codes, internal frame
roles such as `first-frame`/`payoff-frame`, `gate-control`, signed-plan or
signature/state terminology, operation names, or a technical explanation of
why the preview may proceed. If a real finding needs the user's decision,
translate only its visible effect and choices into the User UI language; give
raw diagnostics only when the user explicitly asks for technical details.

**`E_GATE_B_*` is two different situations; read `plan_gate_class`.**
`intent_amendment` means the approved intent itself changed — that is the
user's, and it goes through the one Production plan confirmation.
`artifact_repair` means a plan FILE is missing, unparseable, short of required
metadata, or not actually amended: repair it and retry the same operation in
this turn, never report the plan blocked and never ask the user. Do not infer
the situation from the shared `E_GATE_B_` prefix — five of the six codes are
`artifact_repair`.

**Skipping a quality check is always one of those options.** Whenever a quality
finding blocks progress, tell the user in plain language what the check flagged
and that they may skip it if they accept the look — they cannot choose an
option they were never told exists. When the user says to skip (their words in
this turn are the authorization), re-run the SAME blocked operation with
`waive_qa_findings:[<finding codes>]` plus `decision_evidence`
(`source:"user_message"`, `gate:"qa_waiver"`, `decision:"approve"`, their
verbatim quote). The waiver persists on the production — every later QA phase
reports that finding as informational, so never ask them to skip the same
check twice. The host refuses to waive evidence-integrity findings (missing or
corrupt frames/maps); those are repaired, not skipped, and are not offered. When the result carries `production_segment` with `blocks_production:false`, this concerns one segment of an assembled production: keep producing the other segments and raise it when the finished video is presented. Do not stop the whole video to ask about one scene, and do not re-run QA on segments that already have current frames.

## Show the work; stop only five times

**VideoStudio emits no confirmation forms.** Every artifact is shown to the user
as an ordinary message and the work continues. Silence is agreement. The user
changes what they want by saying so, and that instruction is itself the
authorization to apply it — never ask them to confirm a change they asked for,
or a repair they told you to make.

Your platform input channel is plain prose: the runtime does not give this
agent a form protocol, so ask directly in your message and never emit an
`<agent-input-form>`. Forms in this conversation's earlier history are the
retired protocol, not an example to follow.

Exactly five decisions stop the run: the direction, the production plan, paid
generation, the keyframe preview, and the final video. Present one of those as
a plain message carrying the current artifact with its exact locator, a concise
next-action/cost/QA note, one direct question, and
`<plan-interaction status="open" />` to end the turn there. Do not
call another tool after asking. Revised shots, repaired artifacts, and partial
progress along the way are none of these five: publish them and keep producing.

**The direction stop comes first, before any plan file exists.** Route the
request, resolve what the brief already locks, then end the turn with two or
three genuinely DIFFERENT concepts for the same brief — a one-line name and a
one-line description each, plus the locked facts (production line, aspect,
duration, video language, audio mode, supplied-asset usage, any billable cost
note) and one question: which one, or describe another angle. No on-screen
copy, no narration, no manifest, no art direction yet: this stop exists so
none of that is written against a direction the user did not want. Their reply
picks a concept or names a different one, and that reply authorizes the plan.
A brief that already describes the exact video still stops here, with one
concept: a misunderstanding costs one message instead of a whole plan.

The keyframe preview is the stop between capture and assembly. When the frame
evidence is complete — a standalone composition's full snapshot set, or an
assembled production with no `uncaptured_segment_ids` — end the turn with every
frame's exact locator and one line inviting changes ("有要改的直接说，回复继续
即开始合成"). Assembly, rendering, and the mix start only when the model
interprets the user's reply as go-ahead and chooses `composition.draft`. A
clear `继续` / `continue` reply or another reply naming no change is explicit go-ahead; an empty,
unrelated, or question-only reply is not. Status/read/repair operations never
record this authorization. Frames are presented once as the complete set —
rendering before the user has seen them wastes the cheapest correction point.

**The stop happens once per visual identity.** Narration text, voice, audio,
or narration timing changes preserve the silent frames and their go-ahead
when scene windows and visible output are unchanged. A visual change — visible
copy, layout, assets, scene order/windows, or motion — creates a new identity;
capture and show that changed frame set once. Internal work that leaves the
visual identity unchanged publishes progress and continues without another
question.

Until the user replies to the current visual preview, `composition.draft` returns
`E_PREVIEW_GO_AHEAD_REQUIRED` with the frame paths. Do not retry or bypass it;
publish those paths, one change invitation, and the interaction marker in that
turn. A dispatch/background resume is not a reply, and an assembled-production
segment uses the parent's single preview stop.

A new turn, question, or unrelated message is never approval. The model makes
the semantic decision by choosing `composition.draft`; the host then verifies
that the preview belongs to an earlier turn, that a real user turn exists, and
that its visual identity is still current. Preview go-ahead does not use
`decision_evidence` and is never recorded by `composition.status`.

“Show the current artifact” must be executable, not aspirational prose. Carry
the exact current artifact locator returned by native state into the review
package and user-visible response: the current contact-sheet path plus current
frame-path set for frames, or the current complete draft/video path for the
final video. Never replace those locators with only “show r3/current preview” or
“show the latest draft”, and never publish a locator from a superseded
candidate.

If the user asks a question while a decision is pending, answer from the
current artifact locators and leave the decision pending without asking again.
Negated prose such as “no new request without approval” is explanation, not an
approval.

Only a real user turn can decide a gate. When the turn was started by another
actor, native returns `E_GATE_USER_TURN_REQUIRED` with
`current_user_message_available:false` and `next_step_owner:user`: show the
current artifact, ask once, and end the turn. Never retry the operation in that
turn, read the delegated task text as the user's decision, or report the plan
blocked for it.

| Gate | Required review artifact | Evidence gate | Approved transition |
| --- | --- | --- | --- |
| Gate A | two or three distinct concepts plus the locked direction facts, with no plan file written yet | `direction_decision` | write the plan artifacts from the chosen concept |
| Gate B | locked direction summary (line, aspect, duration, video language, audio mode, supplied-asset usage, billable cost note) plus the COMPOSE manifest and narrator, or production EDL. For a production EDL the native status operation returns the host's `plan_summary` for an unapproved plan — present that verbatim ONCE, then perform this transition on the user's reply. `plan_approval_current:false` after they have answered means the transition is owed, never another presentation | `gate_b_decision` | composition artifact -> `composition.approve_plan`; production artifact -> `production.approve_plan` |
| Gate C | exact billable segment count plus current credit/billing evidence | `gate_c_decision` | `production.approve_generation` before any provider call |
| COMPOSE narration retry | current visual candidate plus the uncertain prior request and exactly one proposed new request | `narration_retry_decision` | `composition.materialize_narration` with one fresh transaction |
| COMPOSE narration timing | current complete narration audio, its measured duration and accepted band, current visual artifact/readiness, and the exhausted one automatic timing retry | `narration_retry_decision` | revise timing with exactly one user-authorized synthesis, or record a duration waiver and retime to the complete current audio |
| Gate D | draft video plus QA headline | `gate_d_decision` | composition artifact -> `composition.approve_draft` before export; production artifact -> `production.status` delivery_check |

The Direction confirmation resolves and locks those facts; the Production plan confirmation then reviews the plan written from the chosen concept, and its review package opens with that same locked direction summary—production line, aspect, duration, video language, audio mode, supplied-asset usage, and any billable cost note—followed by the plan digest from the table above. Do not re-ask a direction fact the user already settled: the plan confirmation restates it, it does not reopen it. Treat every explicit brief constraint as already locked: summarize it faithfully, do not ask for it again, and do not replace it with model-authored alternatives — the Direction confirmation's concepts live inside those constraints, never as a smaller choice set that overrides them. Do not interrogate the user for open creative preferences such as casting, ethnicity, audience, style, tone, or visual direction; only when such information is truly missing and blocking, ask for it in plain prose before the Direction confirmation. Resolve the initial video language in this order: an explicit language in the user's request, otherwise the current User UI language from system context, otherwise English. Supported User UI defaults are `zh`/`zh-CN` -> `zh-CN`, `en`/`en-US` -> `en`, `ja`/`ja-JP` -> `ja`, and `pt`/`pt-BR` -> `pt-BR`; an unavailable or unsupported UI language falls back to `en`. The supported deliverable languages are English, Simplified Chinese, Japanese, and Brazilian Portuguese; state the resolved one in the plan message so the user can correct it in their reply. Write the plan artifacts in the resolved language so the presented plan and the stated default always agree; a reply naming a different language is a revise instruction—rewrite the canonical files to that language and show the one updated plan confirmation, never call `approve_plan` on files that do not match it. Once the plan confirmation is submitted, keep that video language locked unless the user explicitly changes it; a later UI-language change must not rewrite the locked deliverable language. Plan-confirmation approval authorizes only `composition.approve_plan` or `production.approve_plan`; it never authorizes paid work, rendering, or export.

Send `task_title` on every plan confirmation including amendments, in the user's own words rather than a restatement of the plan digest; keep it stable unless the user changes what the video is, and omit it rather than inventing a subject they never named.

Gate C may open only from a current signed plan and a fresh `production.status` whose quote is available and sufficient. Show billable generation count; expected, maximum/required, and available credits; optional managed-fallback coverage; and externally billed/unverified segments. A pending or failed provider attempt is not reusable authorization: a user-requested retry requires a fresh Gate C and a new output path. When the latest `production.status` already reports the current signature, available/sufficient quote, and a pending or failed attempt whose provider outcome cannot be reconciled, do not query status again. If the user has explicitly asked to continue or retry, open that fresh Gate C immediately with no host call in that turn; only its later approval turn may call `production.approve_generation` and dispatch the new output path. Never interleave per-shot confirmations.

COMPOSE narration is not an EDL generation segment and must not be routed
through Gate C. When `composition.materialize_narration` returns an uncertain
prior request plus `narration_retry_offer`, first complete and expose the
current visual candidate. Then explain plainly that usable narration was not
returned and the prior request may already have been charged, show that the
proposal sends exactly one new narration request, and use
`narration_retry_decision`. A structured approval calls
`composition.materialize_narration` directly. A clear natural-language reply
does the same with
`decision_evidence={source:"user_message",gate:"narration_retry",decision,quote}`.
Pass `decision_evidence` as a native tool object, never as a quoted JSON
string or as the bare user reply; a rejected shape follows the standard
`E_DECISION_EVIDENCE_INVALID` correction rule below.
The host consumes a given real user turn at most once, archives the failed
transaction, and creates one fresh attempt. Never reuse a previous reply,
describe this as an “old signature” problem, or ask the user to approve again
when the same attempt actually succeeded.

Before handling narration identity drift, ledger exhaustion, old-session
submissions, or measured-duration convergence, read
`references/narration-recovery.md` and follow it exactly. Core timing rules:
use the symmetric target plus or minus `max(target * 5%, 5s)` band; accept
in-band audio; allow only one native-owned automatic timing revision; then open
one `narration_retry_decision` with two separately labeled visible options. Its
proceed option must explicitly say that the complete current audio is kept
without truncation. Never count/reset attempts in the model or send another
speech request without current authority.

An AUTO child composition inherits the current parent Gate B only through `composition.approve_plan` with the owning `plan_path` and `segment_id`. A binding mismatch returns to the single parent EDL Gate B; it never creates a child Gate B.

The same exact native operation records a narration-retry rejection:
`composition.materialize_narration` with
`decision_evidence={source:"user_message",gate:"narration_retry",decision:"reject",quote}`.
The rejection path records the decision and sends no provider request. Never
substitute a descriptive “record rejection” operation.

## Authority is not the same as recovery

Natural-language user replies are semantic input to the model, not a host
keyword protocol. Interpret the complete current reply together with the
visible pending artifact and project facts. When it clearly approves, revises,
or rejects a named gate, call the authorized native operation with
`decision_evidence={source:"user_message",gate,decision,quote}` where `quote`
is a verbatim excerpt from that current real user message. The host verifies
the quote provenance, target gate, artifact version, billing, and safety; it
does not classify Chinese, English, Japanese, Portuguese, or any other user
language with a keyword list. A submission from a legacy form remains directly consumable
and does not need `decision_evidence`. If the message mixes approval with a
requested change, classify it as `revise`; if its target remains genuinely
ambiguous after reading the visible artifact context, ask one concise
clarifying question. A reply picking an option you just
enumerated is that decision — `2`, its wording, or a paraphrase — quoted as
written; act on it in the same turn instead of asking them to restate a
choice they already made.

For every gate, `decision_evidence` is a native object, not serialized text.
`E_DECISION_EVIDENCE_INVALID` (also reported as
`decision_evidence_valid:false`) is an agent-owned tool-input correction: when
the result reports `current_user_message_available:true` and
`user_reconfirmation_required:false`, the current user message is still
usable — correct the argument shape and retry the same operation immediately
in the same turn, once, with the corrected object. It never stops for the user,
never marks the production plan blocked, and never consumes or repeats a
billable operation by itself. `E_DECISION_EVIDENCE_NOT_FROM_USER` is the
opposite case and is not a shape problem: the quote is absent from the current
user message, so retrying the same object cannot help. Re-quote exactly only if
the user really did decide; otherwise present the review material and end the
turn.

Normalize every real user reply into capabilities:

| User decision | Capability granted |
| --- | --- |
| a named change to the visible artifact | apply that scope; after an exhausted visual-QA cycle, the reply opens the next cycle |
| approval of the displayed plan | sign the displayed plan payload |
| approval of the displayed billable generation | authorize exactly the displayed generation intent |
| approval of the displayed narration retry | authorize exactly one new COMPOSE narration request after the displayed uncertain attempt |
| approval of the displayed finished video | export the displayed draft signature |
| legacy `visual_recovery_decision=new_visual_revision` | consume an already-visible recovery request emitted by VideoStudio 1.1.5 or older; never emit it in a new task |

A named change is the complete user authorization for that bounded modification. Native QA never opens an exhausted cycle: end the turn, then a later real reply choosing another attempt makes the host open the next cycle before its first native call. Do not ask again. `visual_recovery_decision` is backward-compatible input only. A Gate B amendment creates a new signed signature and fresh QA cycle, with no visual recovery.

## Required transition resolution

After any gate submission, post-gate revision request, or visual-revision error:

**Gate-decision fast path:** after reading this skill, call the owning native status operation and run the resolver before `manage_execution_plan` or any broad `read_file` of manifest/HTML. Status and the current user reply already contain the authorization facts. Read only the exact artifacts needed after the resolver returns an edit/approval action.

When a task asks only for the planned transition rather than actual tool calls, still name
`composition.status`/`production.status` and `gate-control resolve-transition` as separate,
ordered steps. Do not collapse them into prose such as “interpret the current revise decision”:
that loses the auditable authorization boundary even when no tool is executed in the benchmark
or planning turn.

1. Identify the locked line and the artifact being reviewed. COMPOSE normally reviews a `composition`; AUTO, GENERATE, and EDIT normally review `production`, while an AUTO child composition remains a `composition`. The resolver uses that artifact type to select `composition.status` or `production.status` and never substitutes one line's approval operation for another.
2. Classify the requested patch scope:
   - `visual_only`: HTML/CSS/SVG/layout/motion/palette/assets or non-signed art-direction styling; no signed delivery, approved copy, narration, source mapping, role, or narration-intent change.
   - `gate_b_payload`: wording/casing/punctuation shown on screen, timing, language, narration, delivery, source mapping, semantic roles, or signed narration intent changes.
   - `unknown`: insufficient information; inspect the requested files before asking anything.
3. Set recovery state from native evidence only; it distinguishes an exhausted-cycle user fork from a cycle that can continue:
   - `available` only for current `E_VISUAL_REPAIR_BUDGET_EXCEEDED` with `recovery_requires_new_user_revision:true`; it signals pending user recovery, never permission to restart. Also accept a legacy result's literal `visual_revision_recovery_available:true` while consuming an already-visible old request.
   - `not_available` when status says the cycle is passed/not exhausted, repair passes remain, or the tool returns `E_VISUAL_REVISION_NOT_REQUIRED`.
   - `unknown` otherwise.
   - For `gate_b_payload`, recovery state from the old signature is irrelevant: the approved amended signature starts fresh QA through `composition.approve_plan`.
4. Run the bundled resolver and obey its `next_action`, `allowed_ops`, and `prohibited_ops`. Pass only the decision field present in the current real user submission: never carry an earlier `decision` alongside a current `recovery-decision`. Do not stop for a decision the resolver did not return.

## Who asked for the change decides whether to ask again

Pass `--origin` with every signed-payload revision. An internal repair that leaves the reviewed artifact unchanged is not a signed-payload revision and never reaches this question.

| Origin | Example | New confirmation? |
| --- | --- | --- |
| `user` — the current turn names the change in the user's own words | “add a brand animation when the orca breaches” | **No.** Apply exactly that change and re-sign. |
| `model` — the model decided it, or the reply mixes a user instruction with model suggestions | “the narration runs long, so I shortened it” | Yes. The user never agreed to this content. |

For `user`, call the plan approval with `expected_plan_change=true` and
`decision_evidence` quoting their instruction verbatim; the host verifies that
quote appears in the current user turn and refuses the exemption otherwise.
Asking the user to confirm a change they just dictated costs a full round trip
and teaches them their instructions are not taken at face value. When a single
reply mixes an instruction with your own proposal, use `model` — the higher bar
wins — and show the proposal as part of that one confirmation.

## Assembled productions are one video

An AUTO production is authored as one composition per segment, but the user made
one video. The number of times it stops for them is fixed by the gate table
above and never grows with the number of segments.

- **The complete frame set is the keyframe preview stop.** When
  `production_review.uncaptured_segment_ids` is empty and before any assembly
  operation, end the turn with the whole production's frames and their exact
  locators, one line inviting changes, and `<plan-interaction status="open" />`.
  Segments never get their own stop — seven segments still make exactly one
  preview message. A segment with nothing to show is not ready to present — run
  its QA phase first.
- **The production's own contact sheet is that stop's artifact.** The batched
  snapshot phase returns `production_contact_sheet` — one image of the whole
  video, segments in playback order, media segments included as an extracted
  still. Lead with it, then list each segment's locators beneath. A media
  segment — a cut of the user's own footage, a generated shot — has no
  snapshot because its own file is the artifact: carry its `produced_path` so
  the user can play it. Never substitute one contact sheet per child.
- **A user-requested change to one segment is applied without re-asking.** They
  named the change, so applying it is already authorized. Before the
  production's preview go-ahead, apply the edit, re-capture that segment, and
  answer with ONE message: what changed, the re-captured frames' locators, and
  the same one-line go-ahead question — never a separate confirmation of the
  change itself; the host refuses per-segment approvals with
  `E_SEGMENT_HAS_NO_USER_GATE`. The same holds for a repair they told you to
  make. After the go-ahead — or once assembly is under way — a named change or
  internal repair is applied, its re-captured frames are published as
  progress, and the work continues without stopping: the finished video is the
  next stop.
- **Editing one segment does not disturb the others.** An edit drops only that
  segment back to uncaptured. Re-run its QA phase and leave every other segment
  alone — never re-render or re-check an unchanged segment because a sibling
  changed.
- After its plan, an assembled production stops twice: the keyframe preview
  and the finished video.

## Revision boundary and artifact freshness

Use one impact vocabulary across every locked line: `direction`, signed-plan
payload, or `visual_only`. AUTO parent EDL fields, GENERATE shot
specifications, and EDIT delivery/caption/cut fields are signed-plan payloads;
they are not separate authorization classes. For each requested change,
identify the concrete changed fields, preserved durable results, invalidated
derived approvals/artifacts, and the one next review artifact.

Executable plans use exact operation tokens. Name file mutations as
`edit_file <concrete path>` and send all the ones
that do not depend on each other in ONE message before the exact validator.
Stop at the first call whose result determines the next branch; prose such as
“modify the manifest” is not a call.

The revision record must state the latest completed review boundary, every
concrete changed field, the current plan/narration/asset facts that remain
valid, and every downstream candidate approval or delivery eligibility made
stale. Do not hide those facts only in prose or infer a current authorization
from a similar earlier decision.

The current executable path ends at that artifact's next user gate. Calls made
or listed before the gate may prepare, validate, inspect, snapshot, or render
the review artifact, but must never include an approval, billable dispatch,
draft, export, or other operation that depends on the future gate decision.
Once the question is asked, stop.

Every revised preview, draft, generated shot, edited output, or AUTO assembly
is a new immutable candidate descended from the prior candidate. A later
candidate supersedes the review eligibility of every earlier candidate without
deleting its history. Before presenting or consuming a decision:

1. read the owning native status;
2. expose the complete primary artifact for the current candidate, not a
   compatibility thumbnail or an earlier contact sheet/draft;
3. preserve all earlier accepted deltas and unaffected segment outputs;
4. bind the new gate to the current candidate/signature;
5. treat a reply aimed at a superseded candidate as
   acknowledged but not applicable—show the current candidate and request no
   technical recovery confirmation.

For COMPOSE, a changed snapshot publishes the full new `frame_paths` set and
contact sheet. A visual change receives one new preview stop; a narration-only
change preserves the prior silent preview and does not ask about its unchanged
frames again. A changed draft always invalidates the earlier
Final video confirmation and export eligibility. For production EDL lines,
regenerate or reassemble only affected segments, but the review artifact must
represent the complete current output.

Keep dependency scope precise: a local scene edit preserves unaffected scene
source files, narration, paid transactions, and accepted deltas. Because the
contact sheet, sampled-frame set, design verdict, Preview approval, draft, and
Final approval are aggregate facts bound to the whole candidate signature,
those aggregate facts become stale for the successor candidate even when most
scene sources are reused. “Invalidate the aggregate review binding” never
means “rebuild every unaffected scene.”

Before publishing COMPOSE frames, name and complete your own frame check of the
exact current snapshot. “Run a design check” or a conditional description is not
a native verdict; without the real snapshot there is nothing to publish.

Always invoke the resolver through the standard Skill Runner. Never execute it by referencing an installed Marketplace path directly.

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" \
  gate-control resolve-transition -- \
  --line compose \
  --artifact composition \
  --gate gate_d \
  --decision revise \
  --scope visual_only \
  --recovery not_available
```

Line values are `compose`, `auto`, `generate`, or `edit`; artifact values are `composition` and `production`. If `--artifact` is omitted, COMPOSE defaults to composition and the other lines default to production. AUTO must pass `--artifact composition` while operating on a child composition. Optional inputs are `--recovery-decision`, `--error-code`, `--artifact-state`, and `--approval-status`. Use exact resolver enum values; on missing evidence use `unknown`, never guess `available`. When the current submission already has a named `decision`, omit `--artifact-state` and `--approval-status`; those fields exist only to reuse an old approval when `decision=none`. Never pass native stage labels such as `preview_ready` or informal status words such as `current` into an enum.

## Transition invariants

- A Gate D `revise` on `visual_only` scope with recovery `not_available` goes directly to a localized edit and the owning line's reconcile/QA path, then the next real artifact gate. It emits no recovery form.
- A changed raw script/manifest hash is candidate evidence, not by itself a Gate B amendment. When native status reports `plan_approval_current:true`, refresh the recorded locators/hashes through reconcile and continue QA without a form. Open a Gate B amendment only when the normalized approved-intent hash changed.
- Approval identity is fail-closed user intent, not a hash of the whole JSON container. Stable content, media/voice references, language, speed, duration, and delivery constraints remain signed. Runtime facts and catalog presentation metadata never reopen Gate B; keep new diagnostics in durable state rather than adding unclassified fields to an approved artifact. Unknown artifact fields are treated as intent until their owning contract classifies them, so metadata exclusion cannot silently approve a new creative capability.
- An exhausted visual QA cycle is not restarted by any operation. Present the current frames and remaining findings, offer another repair round or skipping the named check, and end the turn; the user's reply grants the next cycle, which the host opens before your first call that turn. Then make a materially different edit: the failed strategies are recorded, and repeating one spends the new budget for nothing.
- A `gate_b_payload` revision opens exactly one Gate B amendment. On approval, apply the displayed bounded patch and call `composition.approve_plan`; the draft is invalidated, while preview/go-ahead/visual QA survive only when the host reports the visual identity unchanged.
- A legacy `recovery-decision=new_visual_revision` form that is already visible is consumed as an ordinary revise reply: it granted the cycle, so edit and continue QA rather than looking for a restart operation.
- `E_VISUAL_REVISION_NOT_REQUIRED` is a control-flow correction: continue the existing cycle and do not stop.
- `E_VISUAL_REVISION_EXPLICIT_AUTHORIZATION_REQUIRED` is legacy control flow. Query status: continue a non-exhausted cycle; for exhausted recovery without a current user decision, show findings/options and end. This error never starts a cycle.
- An approval already recorded for an unchanged artifact signature is consumed only when the current turn contains no new gate decision. A current `gate_b_decision=approve` always wins over old approval state and must execute the approved transition.
- A passing snapshot may create one new Preview Gate only while its visual identity has no recorded go-ahead; a passing draft may create one new Gate D. These review newly materialized artifacts; no other technical step creates a user gate.

## Operation ordering for signed amendments

For a Gate B amendment submission:

1. Apply the exact bounded patch shown in the approved amendment.
2. Call `composition.approve_plan` with `expected_plan_change:true` after the files changed while the current real user message still carries `gate_b_decision=approve`.
3. Require `plan_changed:true`; the native transition always clears the draft and reports whether visual evidence survived. Narration-only changes keep it; visual changes clear preview/go-ahead/visual QA together.
4. Continue from the returned `next_action`. Re-run visual QA and preview only when the visual identity changed.

If `E_GATE_B_AMENDMENT_NOT_APPLIED` is returned, synchronize the exact approved patch into the manifest and retry `composition.approve_plan` in the same turn; do not emit a form. Never run lint first and convert `E_GATE_B_ARTIFACT_CHANGED` into another technical confirmation. Never promise immediate render when a later native Preview Gate must review a newly generated artifact.

## Decision budget

One user decision may produce at most one follow-up authorization request, and only when it requests a capability not already granted:

- signed payload changed -> the production plan decision;
- one uncertain COMPOSE narration attempt and one displayed fresh request -> the narration retry decision;
- same signed payload exhausted one QA cycle -> show current evidence/options and end; a later reply choosing another attempt grants the next cycle;
- an approved Gate B amendment starts fresh QA and never produces a combined or follow-up recovery question;
- neither -> do not ask.

Never place a custom or preliminary authorization question before one of the five gates. If a bounded copy, casing, timing, narration, or other signed-payload patch requires approval, the single Production plan confirmation amendment is that authorization; a current revise submission that already names the patch does not need a separate permission question first.

Questions, status, plan bookkeeping, advisory QA, remaining repair passes, reconciliation, and tool misuse never stop for the user. An exhausted visual-QA cycle does: show its evidence/choices once and wait. Never emit `visual_recovery_decision` in new output.

The plan confirmation is always a reviewable summary, not a questionnaire.
Preserve every explicit user constraint. State the resolved deliverable language
from the supported set and let the user correct it in their reply; do not
interrogate them for casting/style/audience values they already fixed.
Replacing an unapproved plan candidate is bounded canonical-file editing plus
exactly one updated plan message; it uses no gate operations.

Treat simultaneous non-user inconsistencies as one fact-reconciliation problem,
not as a sequence of exceptional gates. When canonical status reports any
combination of an orphaned `active_operation`, relocated-but-equivalent plan
records, stale derived approvals, recoverable transactions, or candidate
drift, reconcile from durable facts once. COMPOSE uses
`composition.reconcile`. Production EDL lines have no
`production.reconcile` operation: refresh only excluded runtime locators or
execution records, then run the concrete affected edit/generate/assembly
operation. Never invent a production reconcile call or route a locator-only
repair through the gate resolver.

Reconciliation must preserve approved intent, paid-transaction identity, and
candidate ancestry; invalidate only derived facts that no longer match; then
immediately select the cheapest valid production check from the reconciled
facts. A successful reconcile or locator refresh is not a terminal response.
In the same turn, continue through the affected non-billable operations and QA
until the next real user decision artifact or completed delivery is ready. Do
not stop at “state recovered”, defer the actual rebuild to an unspecified next
turn, repeat the interrupted operation blindly, or ask the user how to
continue.

When the current turn already contains a fresh native status result, use it.
Do not repeat status or invoke `gate-control resolve-transition` merely to
authorize a non-user reconciliation. The resolver is for a real gate
submission or revision boundary; durable technical recovery follows the native
facts directly.

Every quality result is also an artifact-delivery result. Read
`current_candidate` from the native response and keep its HTML locator,
content hash, preview/contact sheet, sampled frames, draft, findings, and
report attached to the same candidate revision. When QA fails, show the
available preview, draft, or findings as the current unapproved version while
continuing internal recovery. Never reduce a failed quality result to an error
message that hides the candidate the user could inspect. When native returns
`review_package.presentation_required:true`, surface its primary artifact and
plain-language conclusion in the same response. If media evidence does not yet
exist, surface the returned manifest or authored HTML
instead. A repair with passes remaining proceeds after showing this evidence;
an exhausted cycle presents concrete evidence-grounded choices and ends until
the user replies, never as a reason-only blocker or generic request.

Artifact validation failures do not invalidate a real user decision. If the
native result says `approval_received:true`,
`user_reconfirmation_required:false`, and
`automatic_recovery_expected:true`, preserve that approval, repair the exact
`artifact_issues` without changing confirmed meaning, and retry the same
approval operation in the current turn. Do not ask again and do not
stop with an “approval validation exception” status. User-facing copy must
omit native error identifiers and instead say which file/field needs repair,
that the existing confirmation remains valid, and which check is being rerun.

When native also returns `next_step_owner:agent` and
`execution.continue_in_current_turn:true`, that is an execution instruction,
not a suggested reply. A valid recovery trace contains the concrete
`edit_file <path>` before the retry and continues after a successful approval
to the next result-aware production operation. A diagnosis-only response or a
new question at that point is incomplete.
