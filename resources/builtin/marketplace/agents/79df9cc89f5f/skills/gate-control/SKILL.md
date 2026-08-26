---
ownerAgent: 79df9cc89f5f
name: gate-control
description_zh: VideoStudio 的统一审核授权与状态转换规则；把用户决策、产物范围、原生 QA 状态映射为唯一下一动作，防止重复确认和错误恢复。
description_en: VideoStudio's canonical gate-authorization and transition policy. Maps user decisions, artifact scope, and native QA state to one next action without duplicate confirmations or false recovery gates.
---

# gate-control

This is the **single canonical policy** for VideoStudio gate decisions,
post-gate edits, and recovery across COMPOSE, AUTO, GENERATE, and EDIT. Line
Skills describe artifacts and production operations but never create a competing
authorization policy.

## Decision kernel — apply this before the detailed rules

Resolve every turn from the latest durable facts:

1. **Identify the current candidate and pending user decision.** A pending
   decision is status, not permission to ask again.
2. **Classify the dependency.** Only a genuine user decision about a creative or
   delivery choice, or a new billable attempt, is a user dependency. Missing
   files, stale locators, parameter-shape errors, interrupted operations,
   equivalent metadata changes, and QA failures with passes remaining are system
   work and do not justify stopping. An exhausted visual-QA cycle is a creative
   fork: show its evidence/options and wait.
3. **Choose one result-aware execution horizon.** Execute only operations whose
   preconditions are true. If one result decides the branch, stop the horizon at
   that operation, inspect it, and select the next operation in the same turn.
4. **Use exact interfaces.** In `calls`, keep the exact native operation token or
   named Skill/file operation. Do not add a `video_studio.` prefix, invent
   generic recovery/status, or replace an operation with prose. Include mandatory bindings such as AUTO child's
   `composition.approve_plan`, `plan_path`, and `segment_id`.
5. **End in exactly one place:** another immediately executable operation, one
   of the five stopping decisions with its current artifact, completed delivery,
   or an external uncertainty boundary with the current artifact and concrete
   options. Showing an artifact is not an ending except at those five stops.

### Direction-to-plan handoff

Keep the first two stops mechanically distinct:

- **Direction stop:** route and lock facts already settled by the brief, then
  show two or three concepts without writing a manifest, script, narration copy,
  or art direction. Use the exact localized name from the table below; in
  Chinese this is `制作方向确认`, never a renamed label.
- **COMPOSE plan stop after direction choice:** call `speech.capabilities`, write the canonical
  `project/composition/composition-manifest.json` from the chosen concept, then run the free `composition.check_narration_fit`; only after those concrete
  results present the one `制作方案确认` / `Production plan confirmation`.

## Stopping test

Before ending a turn on a user decision, all must be true:

- it is direction, production plan, paid generation, keyframe preview, or final
  video;
- that decision is not already pending;
- the exact complete review artifact exists now;
- every native prerequisite succeeded for that exact candidate;
- no call after the question depends on its future answer.

If any item is false, do not stop. A user question, stale reply, already-pending
decision, technical recovery, or conditional “ask after QA passes” never ends a
turn on the user. After a local visual mutation, no artifact exists until the
mutation plus required `composition.inspect` and `composition.snapshot` calls
succeed. In a planned trace, name those calls rather than emitting `calls:[]`.

An unknown external provider outcome is not recoverable by repeatedly calling a
status operation without query/reconcile capability. Preserve the transaction.
If the user explicitly requests a new billable attempt and current status already
contains a sufficient quote, the only dependency is one fresh Paid generation
confirmation. For COMPOSE narration, an exhausted retry episode stops automatic
requests but is not a permanent refusal: with no fresh user decision, show the
current artifact and the native one-request retry offer; when a new real user
turn explicitly approves that offer, call `composition.materialize_narration`
once with current-turn evidence. Never reuse an older turn or route narration
through Paid generation confirmation.

## No-runtime branch

When the current transport cannot execute production tools or render media, do not stop at the plan confirmation. Return the complete explicitly unexecuted production package:
assumptions, script/narration, timed storyboard, exact visible copy/captions,
visual/audio actions, provenance/fallback assets, export target, preview review,
and final QA. Do not claim media exists. Identify each source as user-supplied,
self-authored/generated, or third-party; third-party use needs source, license,
retrieval date, and a project ledger. Without licensed music, specify silence or
a future rights-safe search.

The active line Skill owns any line-specific additions to this package; do not
load another line's references on an ordinary runtime path.

## User-facing names and presentation boundary

`Gate A/B/C/D` and `*_decision` are internal. They may appear in diagnostics,
tests, and calls, but not normal user-facing headings, progress, or explanations.

| Internal protocol | Chinese UI | English UI |
| --- | --- | --- |
| Gate A | 制作方向确认 | Direction confirmation |
| Gate B | 制作方案确认 | Production plan confirmation |
| Gate C | 付费素材生成确认 | Paid generation confirmation |
| Preview Gate | 关键帧预览 | Keyframe preview |
| Narration retry | 旁白重试确认 | Narration retry confirmation |
| Gate D | 成片确认 | Final video confirmation |

Do not write hybrids such as “Gate B（制作方案确认）”. Describe the missing
action/artifact directly and keep error codes diagnostic. Never expose
`budget_exhausted`, “QA budget”, or retry counters. Explain that prior repair
strategies did not resolve the visible finding and present plain-language
options.

Every prose span outside a tool call is user-visible. At a successful keyframe
preview, lead with the current contact sheet/frames, say in one short sentence
that it is ready, then ask one question: name changes, or reply `继续` / `continue`
to start the draft. Passing checks and advisories stay silent. Do not expose raw
finding codes, internal frame roles, signatures/state, operation names, or
technical go-ahead reasoning unless the user asks for technical detail.

`E_GATE_B_*` has two classes. `intent_amendment` means approved intent changed
and goes through one Production plan confirmation. `artifact_repair` means the
plan file is missing, unparseable, incomplete, or not amended: repair and retry
in the same turn without asking the user.

Whenever a quality finding blocks progress, tell the user what is visibly wrong
and that they may skip it if they accept the look. Their current words authorize
rerunning the same blocked operation with `waive_qa_findings` and
`decision_evidence={source:"user_message",gate:"qa_waiver",decision:"approve",quote}`.
The waiver persists, so do not ask twice. Missing/corrupt evidence cannot be
waived. Segment-level findings in an assembled production continue with other
segments and surface at the production review; never create a segment gate.

## Confirmation artifacts — load only at a stop

Before presenting or consuming any of the five stopping decisions, or handling
a COMPOSE narration retry, read
[confirmation-artifacts.md](references/confirmation-artifacts.md). It owns exact
artifact content, locator rules, gate table, video-language default, the once-per-
visual-identity preview, and narration retry presentation. Do not load it for a
pure technical recovery that will not reach a user stop.

For narration identity drift, ledger exhaustion, old-session decisions, or
measured-duration convergence, additionally read
[narration-recovery.md](references/narration-recovery.md). The model never counts
or resets attempts itself.

## Authority is not recovery

Interpret the complete current real user reply with the visible pending artifact
and durable facts. When it clearly approves, revises, or rejects a named gate,
call the authorized native operation with a native-object
`decision_evidence={source:"user_message",gate,decision,quote}` whose `quote` is
verbatim from that message. A legacy form submission remains consumable without
`decision_evidence`. Mixed approval plus change is `revise`; genuinely ambiguous
target gets one concise question. A reply selecting an option just enumerated—
`2`, its wording, or a paraphrase—is the decision; act without asking it again.

`E_DECISION_EVIDENCE_INVALID` with
`current_user_message_available:true` and `user_reconfirmation_required:false`
is an agent-owned shape correction: fix the object and retry once immediately.
`E_DECISION_EVIDENCE_NOT_FROM_USER` is not a shape problem; requote only if the
user really decided, otherwise show the review artifact and end.

| User decision | Capability granted |
| --- | --- |
| named change to visible artifact | apply that bounded scope |
| approval of displayed plan | sign that plan payload |
| approval of displayed billable generation | authorize exactly that intent |
| approval of displayed narration retry | authorize one new request after the shown uncertain attempt |
| approval of displayed finished video | export that draft signature |
| legacy `visual_recovery_decision=new_visual_revision` | consume old visible recovery only; never emit it anew |

## Required transition resolution

After any gate submission, post-gate revision, or visual-revision error:

1. Call the owning `composition.status` or `production.status` first; do not do
   broad manifest/HTML reads or execution-plan bookkeeping first.
2. Classify scope as `visual_only`, `gate_b_payload`, or `unknown`.
   `visual_only` covers styling/layout/motion/assets without signed copy,
   narration, timing, language, delivery, source mapping, or role changes.
3. Set recovery from native evidence only: `available` solely for current
   exhausted-cycle evidence requiring a new user revision; `not_available` for
   a current/pass/non-exhausted cycle; otherwise `unknown`. Old-signature
   recovery is irrelevant to a new signed amendment.
4. Run the bundled resolver and obey `next_action`, `allowed_ops`, and
   `prohibited_ops`. Pass only the current submission's decision field.

Even in a planning-only benchmark, name `composition.status`/`production.status`
and `gate-control resolve-transition` as separate ordered steps.

Pass `--origin` on signed-payload revisions. A current user-named change uses
`origin=user`: apply it without a new confirmation and quote it in
`decision_evidence`. A model-authored change or mixed user instruction plus model
proposal uses `origin=model` and requires the one plan confirmation.

Invoke the resolver only through the standard Skill Runner:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" gate-control resolve-transition -- --line compose --artifact composition --gate gate_d --decision revise --scope visual_only --recovery not_available
```

Line values are `compose`, `auto`, `generate`, `edit`; artifact values are
`composition`, `production`. AUTO passes `--artifact composition` for a child.
Use exact enum values and `unknown` for missing evidence. When a current decision
is present, omit old `--artifact-state` and `--approval-status`.

## Conditional transition references

- Before AUTO child preview, segment revision, or whole-production assembly,
  read [assembled-productions.md](references/assembled-productions.md). It owns
  the one-video preview artifact and per-segment change scope.
- After a post-gate revision, stale/superseded candidate, exhausted visual-QA
  cycle, reconciliation, or artifact-validation recovery, read
  [revision-and-recovery.md](references/revision-and-recovery.md). It owns
  freshness, invalidation, amendment ordering, decision budget, and continuation.
