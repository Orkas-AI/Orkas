<!-- gate-control reference. Read this after a post-gate revision, stale or
superseded candidate, exhausted visual-QA cycle, reconciliation, or artifact-
validation recovery. -->

# Revision, freshness, and recovery

## Revision boundary and artifact freshness

Use one impact vocabulary across lines: `direction`, signed-plan payload, or
`visual_only`. AUTO parent EDL fields, GENERATE shot specs, and EDIT delivery,
caption, and cut fields are signed-plan payloads. For every requested change,
record concrete changed fields, preserved durable results, invalidated derived
approvals/artifacts, and the one next review artifact.

Executable plans use exact tokens. Name mutations as `edit_file <concrete path>`
and send independent mutations in one message before the exact validator. Stop
at the first call whose result determines the next branch. The executable path
ends at the next user gate and never includes an approval, billable dispatch,
draft, export, or operation depending on that future answer.

Every revised preview, draft, generated shot, edited output, or assembly is a
new immutable candidate descended from its predecessor. A successor supersedes
earlier review eligibility without deleting history. Before presenting or
consuming a decision:

1. read owning native status;
2. expose the complete current primary artifact, never a compatibility thumbnail;
3. preserve earlier accepted deltas and unaffected segment outputs;
4. bind the gate to current candidate/signature;
5. acknowledge a reply aimed at a superseded candidate but do not apply it—show
   the current candidate without requesting technical recovery confirmation.

For COMPOSE, a changed snapshot publishes its full new `frame_paths` and contact
sheet. A visual change gets one new preview stop; narration-only change preserves
the silent preview. A changed draft invalidates earlier Final video confirmation
and export. EDL lines reprocess only affected segments, while the review artifact
represents the complete current video.

Local scene edits preserve unaffected sources, narration, paid transactions, and
accepted deltas. Aggregate contact sheet, sampled frames, design verdict,
preview go-ahead, draft, and final approval are bound to the whole candidate and
become stale for its successor. Invalidating aggregate review never means
rebuilding unaffected scenes. Before publishing COMPOSE frames, name and complete
your own frame check of the exact current snapshot; a conditional description is
not a native verdict.

## Transition invariants

- Gate D `revise` with `visual_only` and recovery `not_available` goes directly
  to localized edit plus owning reconcile/QA, then the next real artifact gate.
- A changed raw file hash is candidate evidence, not automatically a plan
  amendment. If status says `plan_approval_current:true`, refresh locators/hashes
  through reconcile and continue QA. Amend only when normalized approved intent
  changed.
- Approval identity is fail-closed user intent. Content, media/voice refs,
  language, speed, duration, and delivery constraints remain signed. Runtime
  facts and catalog presentation metadata do not reopen the plan. Unknown fields
  remain intent until their owner classifies them.
- No operation restarts an exhausted visual-QA cycle. Show current frames and
  findings, offer another repair round or skipping the named check, and end. A
  later real reply grants the next cycle; make a materially different edit.
- `gate_b_payload` revision opens exactly one plan amendment. Approval applies
  the bounded patch and `composition.approve_plan`; visual evidence survives
  only when native reports unchanged visual identity.
- Legacy `recovery-decision=new_visual_revision` input consumes the already
  visible old request and continues QA; never emit it anew.
- `E_VISUAL_REVISION_NOT_REQUIRED` continues the existing cycle.
- `E_VISUAL_REVISION_EXPLICIT_AUTHORIZATION_REQUIRED` requires status: continue
  a non-exhausted cycle; for exhausted recovery without a current decision, show
  findings/options and end. The error never starts a cycle.
- Old approval for an unchanged signature is usable only when the current turn
  has no new decision. Current decision always wins.
- Passing snapshot may create one preview only without recorded go-ahead;
  passing draft may create one final-video stop. No technical step creates other
  user gates.
- Export is authorized here only. Default technical settings are host-owned; do
  not ask users for container/resolution/bitrate. Successful export creates no
  new preview or final-video gate.

## Signed amendment ordering

For a plan-amendment submission:

1. Apply the exact bounded patch shown in the approved amendment.
2. Call `composition.approve_plan` with `expected_plan_change:true` after the
   files change while the current real message carries approval. A current-turn
   message that explicitly names the change ("换成XX的声音", "把结尾标语改成…")
   IS that approval for exactly the named change: submit
   `decision_evidence={source:"user_message",gate:"plan",decision:"approve",quote:<the user's change request>}`
   and do not present the amended plan for another confirmation round. Only
   what goes beyond the named change still needs presenting.
3. Require `plan_changed:true`; native clears the draft and reports whether
   visual evidence survived. Narration-only keeps it; visual change clears
   preview/go-ahead/visual QA together.
4. Continue from `next_action`, rerunning visual QA/preview only if visual identity
   changed.

On `E_GATE_B_AMENDMENT_NOT_APPLIED`, synchronize the exact approved patch and
retry approval in the same turn; do not ask. Never run lint first and turn
`E_GATE_B_ARTIFACT_CHANGED` into a technical confirmation. Never promise
immediate render when a later preview must review a new artifact.

## Decision budget

One user decision creates at most one follow-up authorization request, only for
a capability not granted:

- signed payload changed -> Production plan confirmation;
- uncertain COMPOSE narration plus one displayed fresh request -> narration retry;
- same payload exhausted one QA cycle -> show evidence/options and wait; later
  reply grants the next cycle;
- approved plan amendment -> fresh QA, never combined recovery question;
- otherwise -> do not ask.

Never add a preliminary authorization before the five stops. A current revise
message that names its patch needs no separate permission. Questions, status,
bookkeeping, advisory QA, remaining passes, reconciliation, and tool misuse do
not stop for the user. An exhausted cycle does. The plan confirmation is a
reviewable summary, not a questionnaire; preserve constraints and resolved
language. Replacing an unapproved candidate is bounded file editing plus exactly
one updated plan message, with no gate operation.

## Reconciliation and continued execution

Treat simultaneous non-user inconsistencies as one fact-reconciliation problem:
orphaned `active_operation`, relocated equivalent plan records, stale derived
approvals, recoverable transactions, or candidate drift. COMPOSE uses
`composition.reconcile`. Production EDL lines have no `production.reconcile`:
refresh excluded runtime locators/records, then run the concrete affected
edit/generate/assembly. Never invent a production reconcile or send locator-only
repair through the gate resolver.

Preserve approved intent, paid-transaction identity, and candidate ancestry;
invalidate only mismatched derived facts. Continue in the same turn through
non-billable operations/QA until a real user artifact or completed delivery is
ready. Do not stop at “state recovered”, defer rebuilding, blindly repeat the
interrupted operation, or ask how to continue.

If current status is already available, do not repeat it or call the resolver
for non-user reconciliation. The resolver is for real gate submissions or
revision boundaries; technical recovery follows native facts directly.

Every quality result also delivers an artifact. Keep native
`current_candidate` HTML locator, content hash, preview/contact sheet, sampled
frames, draft, findings, and report attached to one revision. On failure, show
available artifact/findings as the current unapproved version while continuing
internal recovery. When `review_package.presentation_required:true`, surface
its primary artifact and plain-language conclusion in the same response. If
media does not exist, surface manifest or authored HTML. Passes remaining
continue; exhausted cycle shows evidence-grounded choices and waits.

Artifact validation failure does not invalidate a real user decision. If native
returns `approval_received:true`, `user_reconfirmation_required:false`, and
`automatic_recovery_expected:true`, preserve approval, repair exact
`artifact_issues` without changing meaning, retry the same approval in the
current turn, and continue. User copy omits error identifiers and explains the
file/field repair and preserved confirmation.

When `next_step_owner:agent` and `execution.continue_in_current_turn:true`, this
is an execution instruction. A valid trace includes concrete
`edit_file <path>`, retry, then the next result-aware production operation. A
diagnosis-only answer or new question is incomplete.
