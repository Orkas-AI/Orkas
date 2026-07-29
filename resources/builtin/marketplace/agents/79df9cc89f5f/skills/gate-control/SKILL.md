---
ownerAgent: 79df9cc89f5f
name: gate-control
min_app_version: "1.6.0"
description_zh: VideoStudio 的统一审核授权与状态转换规则；把用户决策、产物范围、原生 QA 状态映射为唯一下一动作，防止重复确认和错误恢复。
description_en: VideoStudio's canonical gate-authorization and transition policy. Maps user decisions, artifact scope, and native QA state to one next action without duplicate confirmations or false recovery gates.
category: creation
---

# gate-control

This is the **single canonical policy** for VideoStudio gate submissions, post-gate edits, and recovery forms across COMPOSE, AUTO, GENERATE, and EDIT. Workflow and line skills may describe artifacts and production operations, but must not create a competing authorization policy.

## Decision kernel — apply this before the detailed rules

Resolve every turn from the latest durable facts with this short sequence:

1. **Identify the current candidate and current pending user decision.** A
   pending review is status, not permission to emit another form.
2. **Classify the dependency.** Only a real creative/delivery choice or a new
   billable attempt is a user dependency. Missing files, stale ledgers,
   parameter-shape errors, interrupted operations, QA failures, exhausted local
   repair strategies, and equivalent locator/metadata changes are system work.
3. **Choose one result-aware execution horizon.** List or execute only
   operations whose preconditions are already true. If an operation's result
   decides the branch, stop the planned horizon at that operation, inspect its
   result, and then choose the next operation in the same agent turn.
4. **Use exact interfaces.** In an executable `calls` list, keep the exact
   native operation token (`composition.approve_plan`,
   `composition.materialize_narration`, `composition.reconcile`,
   `composition.inspect`, `composition.snapshot`,
   `composition.submit_design_review`, `composition.approve_preview`,
   `composition.draft`, `composition.approve_draft`,
   `composition.export`, `production.approve_plan`,
   `production.approve_generation`, or the named skill/file operation).
   Do not add a `video_studio.` prefix, replace it with descriptive prose, or
   invent a generic recovery/status operation. Human-readable prose belongs in
   `next_action`; executable identity belongs in `calls`. An operation name
   without every mandatory binding already present in current facts is not a
   complete call. For example, AUTO child inheritance is
   `composition.approve_plan` plus the owning `plan_path` and `segment_id`, not
   the operation token alone.
5. **End in exactly one place:** another immediately executable operation, one
   newly materialized user review artifact and its single form, a completed
   delivery, or an external uncertainty boundary with the current artifact and
   concrete options. Never combine mutually dependent future stages.

These are structural invariants, not a state-machine enumeration. The model
still determines the next action from current evidence.

### Gate creation test

Before emitting a form, all of the following must be true:

- the requested decision is genuinely owned by the user;
- no current form for that candidate and decision is already pending;
- the exact complete review artifact exists now;
- every native prerequisite has returned success for that exact candidate;
- no call listed after the form depends on its future decision.

If any item is false, `open_gates` is empty. A user question, stale reply,
already-pending review, technical recovery, or conditional “open after QA
passes” never creates a form in the current output.

After a local visual mutation, the next review artifact does not exist until
the exact mutation and the required `composition.inspect` and
`composition.snapshot` calls have succeeded (plus design review when native
evidence requires it). In a planning response, name those exact calls; do not
emit `calls:[]` and open Visual preview confirmation immediately. Invalidate
only approvals and evidence that actually existed for the prior candidate. If
no preview or draft approval existed, say the successor candidate will require
one rather than claiming a nonexistent approval was invalidated.

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
do not stop at Direction confirmation for a clear/default-filled brief. Return
the complete explicitly unexecuted production package now: assumptions,
script/narration, timed storyboard or shotlist, on-screen copy/captions, visual
and audio plan, provenance/fallback assets, target export settings, preview
review, and final QA. Describe the future authorization boundary, but do not
emit a form that withholds this package or claim that media already exists.
Do not label this package “Direction confirmation”. Each timed scene must carry
usable narration, exact visible copy/caption, visual action, and edit/transition
instruction rather than a topic-only outline. Make provenance operational:
for each visual or audio source state whether it is user-supplied,
self-authored/generated, or third-party; for third-party media require the
source URL/provider, license name or purchase record, retrieval date, and
project-local ledger entry before use. If no music asset is available, specify
silence or a rights-cleared future-library search with that same ledger
requirement—never describe a mood-only BGM as though it were already licensed.

## User-facing confirmation names

`Gate A/B/C/D`, `HTML Preview`, and the `*_decision` ids are internal protocol terms. They may appear in logs, diagnostics, tests, and tool calls, but **must not appear in normal user-facing headings, forms, progress updates, or error explanations**. Use the current User UI language and these plain-language names instead:

| Internal protocol | Chinese UI | English UI |
| --- | --- | --- |
| Gate A | 制作方向确认 | Direction confirmation |
| Gate B | 制作方案确认 | Production plan confirmation |
| Gate C | 付费素材生成确认 | Paid generation confirmation |
| Narration retry | 旁白重试确认 | Narration retry confirmation |
| HTML Preview | 画面预览确认 | Visual preview confirmation |
| Gate D | 成片确认 | Final video confirmation |

Do not write hybrids such as “Gate B（制作方案确认）” in normal user output. Show only the localized plain-language title. When explaining a blocker, describe the missing user action or artifact directly—for example, “请先确认制作方案” or “Please confirm the production plan”—while keeping internal error codes available only in diagnostic details. Never expose `budget_exhausted`, “QA budget”, or retry-counter language to the user. Say that the previous repair strategies did not resolve the recorded finding, which artifacts were preserved, and what will be tried next.

## Canonical confirmation forms (internal protocol)

Every user confirmation shows its current review artifact, a concise next-action/cost/QA note, one form, and then `<plan-interaction status="open" />`. Do not call another tool after opening the form. Each decision select displays localized approve and revise labels, with free-text feedback in a separate `adjustments` field. Plan, generation, and narration-retry values remain `approve` / `revise`. Preview and Final values are invisibly bound to the artifact shown: `approve::<current 64-hex artifact_signature>` and `revise::<current 64-hex artifact_signature>`. The signature is the option value, never user-visible label or prose. A new turn, question, or unrelated message is never approval.

“Show the current artifact” must be executable, not aspirational prose. Carry
the exact current artifact locator returned by native state into the review
package and user-visible response: the current contact-sheet path plus current
frame-path set for Preview, or the current complete draft/video path for Final.
Never replace those locators with only “show r3/current preview” or “show the
latest draft”, and never publish a locator from a superseded candidate.

`open_gates` is a create/show-form action, not a list of pending status. When a
current candidate already has a pending review and a stale reply arrives, keep
that review pending and re-expose its artifact in normal evidence, but leave
`open_gates` empty. Writing “current gate, do not reopen” inside `open_gates`
still asks the host to emit another form and is forbidden.

If the user asks a question while a review is pending, answer it using the
current artifact locators and keep the review pending without recreating its
form. Negated prose such as “no new request without approval” is explanation,
not an approval or operation.

For Preview and Final, obtain the current artifact signature from native status
and bind both decision option values to it before showing the form. The host
rejects a bound value for an older signature. A legacy unbound form is accepted
only while the project has never produced a successor candidate; after any
revision it is acknowledged as superseded, the current artifact remains
pending, and no replacement form is emitted automatically. A direct user
message is still interpreted semantically against the current visible artifact
and does not need this form-only binding.

| Gate | Required review artifact | Decision id | Approved transition |
| --- | --- | --- | --- |
| Gate B | COMPOSE script + shotlist + narrator, or production EDL | `gate_b_decision` | composition artifact -> `composition.approve_plan`; production artifact -> `production.approve_plan` |
| Gate C | exact billable segment count plus current credit/billing evidence | `gate_c_decision` | `production.approve_generation` before any provider call |
| COMPOSE narration retry | current visual candidate plus the uncertain prior request and exactly one proposed new request | `narration_retry_decision` | `composition.materialize_narration` with one fresh transaction |
| HTML Preview | contact sheet for the current composition signature | `preview_decision` | `composition.approve_preview` before draft |
| Gate D | draft video plus QA/design-review headline | `gate_d_decision` | composition artifact -> `composition.approve_draft` before export; production artifact -> owning production finalization path |

The direction-confirmation proposal is non-production: show the locked line, aspect, duration, video language, audio mode, one to three concepts, supplied-asset usage, and any billable cost note. Treat every explicit brief constraint as already locked: summarize it faithfully, do not ask for it again, and do not replace it with model-authored alternatives. Concepts are optional, non-exhaustive suggestions within those constraints, never a smaller choice set that overrides them. The form shell owns its approve/revise decision selector; never add `direction_decision` to the editable `fields` array. That array must always include an editable `language` select because supported deliverable languages are a real closed runtime domain—for an explicitly English deliverable it contains `{id:"language",type:"select",default:"en"}` with the supported language options. Do not replace this field with the form-shell decision selector. Do not add another `select` or `multiselect` for open creative preferences such as casting, ethnicity, audience, style, tone, or visual direction; when such information is truly missing and blocking, collect it with free text. Resolve the initial video language in this order: an explicit language in the user's request, otherwise the current User UI language from system context, otherwise English. Supported User UI defaults are `zh`/`zh-CN` -> `zh-CN`, `en`/`en-US` -> `en`, `ja`/`ja-JP` -> `ja`, and `pt`/`pt-BR` -> `pt-BR`; an unavailable or unsupported UI language falls back to `en`. The select must offer English, Simplified Chinese, Japanese, and Brazilian Portuguese, and its submitted value overrides the inferred default. Once direction confirmation is submitted, keep that video language locked unless the user explicitly changes it; a later UI-language change must not rewrite the locked deliverable language. Direction confirmation does not authorize production-plan approval, paid work, rendering, or export.

Gate C may open only from a current signed plan and a fresh `production.status` whose quote is available and sufficient. Show billable generation count; expected, maximum/required, and available credits; optional managed-fallback coverage; and externally billed/unverified segments. A pending or failed provider attempt is not reusable authorization: a user-requested retry requires a fresh Gate C and a new output path. When the latest `production.status` already reports the current signature, available/sufficient quote, and a pending or failed attempt whose provider outcome cannot be reconciled, do not query status again. If the user has explicitly asked to continue or retry, open that fresh Gate C immediately with no host call in the form-opening turn; only its later approval turn may call `production.approve_generation` and dispatch the new output path. Never interleave per-shot confirmations.

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
string or as the bare user reply. If the native result reports
`decision_evidence_valid:false` with `user_reconfirmation_required:false`,
the current user message is still usable: correct the argument shape and retry
the same operation immediately in the same turn. Do not ask the user again,
open another form, or mark the production plan blocked for this tool-input
error.
The host consumes a given real user turn at most once, archives the failed
transaction, and creates one fresh attempt. Never reuse a previous reply,
describe this as an “old signature” problem, or ask the user to approve again
when the same attempt actually succeeded. A `gate_c_decision` form already
opened by VideoStudio 1.1.29 or older may be consumed only by native
`composition.materialize_narration` while its matching failed narration
transaction is current; never emit that legacy field for a new COMPOSE
narration retry.

Narration confirmation identity follows the stable synthesis request:
narration text, `route_ref`, `voice_ref`, language, speed, and format. Catalog
display names, provider implementation labels, paths, formatting, and other
locator/presentation metadata are not user-approved intent. Refresh those
facts internally without reopening Production plan confirmation or replacing
an already-recorded one-request retry authorization. If a non-billable local
check interrupts dispatch, call the repair/reconcile operation and resume the
same persisted authorization; never ask for it again.

The native narration transaction ledger also owns convergence. When it returns
`E_TTS_RETRY_EPISODE_EXHAUSTED`, the unchanged request has reached its total
uncertain-outcome boundary. Do not open another narration, paid-generation, or
production-plan confirmation, even if the current reply repeats an earlier
approval. Present the returned current visual candidate and plain-language
conclusion, send no request, and wait for provider reconciliation or a real
user-requested narration-content/voice change. The model must not count,
reset, or override attempts itself. A resumed old-session form may have been
opened before the latest transaction facts were recorded. When native returns
`submitted_decision_status=superseded_by_current_transaction_ledger`, say
plainly that the user's reply was received but the older retry proposal is no
longer actionable, that no new request or charge was created, and that the
visual candidate remains available. Treat the old action as safely closed:
do not claim that confirmation was missing, do not reuse its reply, do not
retry the native operation, and do not open a replacement form.

An AUTO child composition inherits the current parent Gate B only through `composition.approve_plan` with the owning `plan_path` and `segment_id`. A binding mismatch returns to the single parent EDL Gate B; it never creates a child Gate B.

The same exact native operation records a narration-retry rejection:
`composition.materialize_narration` with
`decision_evidence={source:"user_message",gate:"narration_retry",decision:"reject",quote}`.
The rejection path records the decision and sends no provider request. Never
substitute `composition.approve_preview` or a descriptive “record rejection”
operation.

## Authority is not the same as recovery

Natural-language user replies are semantic input to the model, not a host
keyword protocol. Interpret the complete current reply together with the
visible pending artifact and project facts. When it clearly approves, revises,
or rejects a named gate, call the authorized native operation with
`decision_evidence={source:"user_message",gate,decision,quote}` where `quote`
is a verbatim excerpt from that current real user message. The host verifies
the quote provenance, target gate, artifact version, billing, and safety; it
does not classify Chinese, English, Japanese, Portuguese, or any other user
language with a keyword list. A structured form remains directly consumable
and does not need `decision_evidence`. If the message mixes approval with a
requested change, classify it as `revise`; if its target remains genuinely
ambiguous after reading the visible artifact context, ask one concise
clarifying question.

For every gate, `decision_evidence` is a native object, not serialized text.
`E_DECISION_EVIDENCE_INVALID` is an agent-owned tool-input correction: when
the result preserves the current message and says reconfirmation is not
required, retry the same native operation once with the corrected object in
the same turn. It never opens a new user form and never consumes or repeats a
billable operation by itself.

Normalize every real user form submission into capabilities:

| User decision | Capability granted |
| --- | --- |
| any named Preview/Gate D `revise` with adjustments | edit the currently reviewed artifact within the stated scope and restart an exhausted non-billable visual-QA cycle when required |
| `gate_b_decision=approve` | sign the displayed plan payload |
| `gate_c_decision=approve` | authorize the displayed billable generation intent |
| `narration_retry_decision=approve` | authorize exactly one new COMPOSE narration request after the displayed uncertain attempt |
| `preview_decision=approve` | render the displayed HTML preview signature |
| `gate_d_decision=approve` | export the displayed draft signature |
| legacy `visual_recovery_decision=new_visual_revision` | consume an already-visible recovery form emitted by VideoStudio 1.1.5 or older; never emit this form in a new task |

`revise` is the complete user authorization for a user-requested bounded modification. Restarting an exhausted internal visual-QA cycle is a non-billable implementation detail driven by native QA evidence, so it requires no user confirmation at all. `visual_recovery_decision` is backward-compatible input only. A Gate B amendment creates a new signed signature and therefore a fresh QA cycle; it never also needs visual recovery.

## Required transition resolution

After any gate submission, post-gate revision request, or visual-revision error:

**Gate-submission fast path:** after reading this skill, call the owning native status operation and run the resolver before `manage_execution_plan` or any broad `read_file` of manifest/HTML. Status and the submitted form already contain the authorization facts. Read only the exact artifacts needed after the resolver returns an edit/approval action.

When a task asks only for the planned transition rather than actual tool calls, still name
`composition.status`/`production.status` and `gate-control resolve-transition` as separate,
ordered steps. Do not collapse them into prose such as “interpret the current revise decision”:
that loses the auditable authorization boundary even when no tool is executed in the benchmark
or planning turn.

1. Identify the locked line and the artifact being reviewed. COMPOSE normally reviews a `composition`; AUTO, GENERATE, and EDIT normally review `production`, while an AUTO child composition remains a `composition`. The resolver uses that artifact type to select `composition.status` or `production.status` and never substitutes one line's approval operation for another.
2. Classify the requested patch scope:
   - `visual_only`: HTML/CSS/SVG/layout/motion/palette/assets or non-signed art-direction styling; no signed script, shotlist, delivery, approved copy, narration, source mapping, role, or narration-intent change.
   - `gate_b_payload`: wording/casing/punctuation shown on screen, timing, language, narration, delivery, source mapping, semantic roles, or signed narration intent changes.
   - `unknown`: insufficient information; inspect the requested files before asking anything.
3. Set recovery state from native evidence only; it selects an internal operation, never a new form:
   - `available` only from the latest result's literal `visual_revision_recovery_available:true`.
   - `not_available` when status says the cycle is passed/not exhausted, repair passes remain, or the tool returns `E_VISUAL_REVISION_NOT_REQUIRED`.
   - `unknown` otherwise.
   - For `gate_b_payload`, recovery state from the old signature is irrelevant: the approved amended signature starts fresh QA through `composition.approve_plan`.
4. Run the bundled resolver and obey its `next_action`, `form`, `allowed_ops`, and `prohibited_ops`. Pass only the decision field present in the current real user submission: never carry an earlier `decision` alongside a current `recovery-decision`. Do not emit a user form that the resolver did not return.

## Revision boundary and artifact freshness

Use one impact vocabulary across every locked line: `direction`, signed-plan
payload, or `visual_only`. AUTO parent EDL fields, GENERATE shot
specifications, and EDIT delivery/caption/cut fields are signed-plan payloads;
they are not separate authorization classes. For each requested change,
identify the concrete changed fields, preserved durable results, invalidated
derived approvals/artifacts, and the one next review artifact.

When a control or recovery response represents executable work, every entry in
its call plan must be an exact operation token rather than a paraphrase.
Represent each file mutation separately as `edit_file <concrete path>`, then
name the exact native validator or transition. “Modify script.md” and “submit
the review” are explanations, not calls. Stop the plan at the first operation
whose returned result determines the next branch. In particular, a changed
narration-fit strategy is `edit_file script.md`, `edit_file shotlist.json`,
`edit_file composition-manifest.json`, then
`composition.check_narration_fit`; a draft design-review submission must name
`composition.submit_design_review`.

The revision record must state the latest completed review boundary, every
concrete changed field, the current plan/narration/asset facts that remain
valid, and every downstream candidate approval or delivery eligibility made
stale. Do not hide those facts only in prose or infer a current authorization
from a similar earlier decision.

The current executable path ends at that artifact's next user gate. Calls made
or listed before the gate may prepare, validate, inspect, snapshot, or render
the review artifact, but must never include an approval, billable dispatch,
draft, export, or other operation that depends on the future gate decision.
Once the form is shown, stop.

Every revised preview, draft, generated shot, edited output, or AUTO assembly
is a new immutable candidate descended from the prior candidate. A later
candidate supersedes the review eligibility of every earlier candidate without
deleting its history. Before presenting or consuming a decision:

1. read the owning native status;
2. expose the complete primary artifact for the current candidate, not a
   compatibility thumbnail or an earlier contact sheet/draft;
3. preserve all earlier accepted deltas and unaffected segment outputs;
4. bind the new gate to the current candidate/signature;
5. treat a reply or resumed form aimed at a superseded candidate as
   acknowledged but not applicable—show the current candidate and request no
   technical recovery confirmation.

For COMPOSE, a changed snapshot requires the full new `frame_paths` set and
contact sheet to be reviewed again. Preview approval for one signature never
authorizes a child revision. A changed draft similarly invalidates the earlier
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

Every executable COMPOSE Preview path must name and complete
`composition.submit_design_review` for the exact current snapshot before the
form. “Run a design check” or a conditional gate description is not a native
verdict and cannot open Visual preview confirmation. If that operation is not
yet in the call path, keep the preview gate closed.

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

- A Preview or Gate D `revise` on `visual_only` scope with recovery `not_available` goes directly to a localized edit and the owning line's reconcile/QA path, then the next real artifact gate. It emits no recovery form and never calls `composition.begin_visual_revision`.
- A changed raw script/shotlist/manifest hash is candidate evidence, not by itself a Gate B amendment. When native status reports `plan_approval_current:true`, refresh the recorded locators/hashes through reconcile and continue QA without a form. Open a Gate B amendment only when the normalized approved-intent hash changed.
- Approval identity is fail-closed user intent, not a hash of the whole JSON container. Stable content, media/voice references, language, speed, duration, and delivery constraints remain signed. Runtime facts and catalog presentation metadata never reopen Gate B; keep new diagnostics in durable state rather than adding unclassified fields to an approved artifact. Unknown artifact fields are treated as intent until their owning contract classifies them, so metadata exclusion cannot silently approve a new creative capability.
- Recovery `available` calls `composition.begin_visual_revision` internally, performs a materially different localized edit from the recorded evidence, and continues QA. No current user decision is required; never emit `visual_recovery_decision`.
- A `gate_b_payload` revision opens exactly one Gate B amendment form. On approval, apply the displayed bounded patch and call `composition.approve_plan`; the changed signature invalidates the old preview/draft/QA cycle and starts fresh QA without `visual_recovery_decision` or `composition.begin_visual_revision`.
- `composition.begin_visual_revision` is allowed whenever native status reports recovery `available`, or while consuming a legacy `recovery-decision=new_visual_revision` form that is already visible. It is not a user-authorized capability and must never create a form.
- `E_VISUAL_REVISION_NOT_REQUIRED` is a control-flow correction: continue the existing cycle and emit no form.
- `E_VISUAL_REVISION_EXPLICIT_AUTHORIZATION_REQUIRED` is a legacy control-flow result and does not justify a form. Query native status; if status says not exhausted, continue the current cycle, and if it says recovery is available, begin the internal revision immediately.
- `composition.submit_design_review` with `next_action=repair_visuals_then_composition.reconcile` stays in the current cycle and is never recovery availability.
- An approval already recorded for an unchanged artifact signature is consumed only when the current turn contains no new gate decision. A current `gate_b_decision=approve` always wins over old approval state and must execute the approved transition.
- A passing snapshot may create one new Preview Gate, and a passing draft may create one new Gate D. These review newly materialized artifacts; no other technical step creates a user gate.

## Operation ordering for signed amendments

For a Gate B amendment submission:

1. Apply the exact bounded patch shown in the approved amendment.
2. Call `composition.approve_plan` with `expected_plan_change:true` after the files changed while the current real user message still carries `gate_b_decision=approve`.
3. Require `plan_changed:true`; the native transition clears preview/draft/old visual QA and returns `next_action:composition.doctor`.
4. Continue doctor/prepare/QA. Never call `composition.begin_visual_revision` in this path.

If `E_GATE_B_AMENDMENT_NOT_APPLIED` is returned, synchronize the exact approved patch into script/shotlist/manifest and retry `composition.approve_plan` in the same turn; do not emit a form. Never run lint first and convert `E_GATE_B_ARTIFACT_CHANGED` into another technical confirmation. Never promise immediate render when a later native Preview Gate must review a newly generated artifact.

## Form budget

One user decision may produce at most one follow-up authorization form, and only when it requests a capability not already granted:

- signed payload changed -> `gate_b_decision`;
- one uncertain COMPOSE narration attempt and one displayed fresh request -> `narration_retry_decision`;
- same signed payload did not converge within one QA repair cycle -> no form; native evidence authorizes the internal restart immediately;
- an approved Gate B amendment starts fresh QA and never produces a combined or follow-up recovery form;
- neither -> no form.

Never place a custom or preliminary authorization form before a canonical gate. If a bounded copy, casing, timing, narration, or other signed-payload patch requires approval, the single Production plan confirmation amendment is that authorization; a current revise submission that already names the patch does not need a separate permission question first.

Questions, status checks, plan bookkeeping, advisory QA, repair passes that remain, QA-cycle restart, reconciliation, and tool misuse errors never create a form. `visual_recovery_decision` must not appear in newly emitted VideoStudio output.

Direction confirmation is always a reviewable summary, not a questionnaire
generator. Preserve every explicit user constraint. Its only universally
editable closed field is the supported video-language selector, prefilled from
the explicit request or UI fallback. Do not invent casting/style/audience
selectors for values the user already fixed. Replacing an unapproved Direction
candidate is presentation work and has no host `calls`; show the one updated
Direction confirmation directly.

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
exist, surface the returned script, shotlist, manifest, or authored HTML
instead. A non-user recovery decision still proceeds automatically after this
evidence is shown; a genuine user decision must be presented as concrete
evidence-grounded choices, never as a reason-only blocker or generic request
for instructions.

Artifact validation failures do not invalidate a real user decision. If the
native result says `approval_received:true`,
`user_reconfirmation_required:false`, and
`automatic_recovery_expected:true`, preserve that approval, repair the exact
`artifact_issues` without changing confirmed meaning, and retry the same
approval operation in the current turn. Do not emit another form and do not
stop with an “approval validation exception” status. User-facing copy must
omit native error identifiers and instead say which file/field needs repair,
that the existing confirmation remains valid, and which check is being rerun.
