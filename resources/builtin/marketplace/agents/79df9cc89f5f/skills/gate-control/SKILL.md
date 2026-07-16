---
ownerAgent: 79df9cc89f5f
name: gate-control
min_app_version: "1.6.0"
description_zh: VideoStudio 的统一审核授权与状态转换规则；把用户决策、产物范围、原生 QA 状态映射为唯一下一动作，防止重复确认和错误恢复。
description_en: VideoStudio's canonical gate-authorization and transition policy. Maps user decisions, artifact scope, and native QA state to one next action without duplicate confirmations or false recovery gates.
category: creation
---

# gate-control

This is the **single canonical policy** for VideoStudio gate submissions, post-gate edits, and recovery forms across COMPOSE, AUTO, GENERATE, and EDIT. Workflow and line skills may describe artifacts and production operations, but must not create a second authorization state machine.

## Authority is not the same as recovery

Normalize every real user form submission into capabilities:

| User decision | Capability granted |
| --- | --- |
| any named gate `revise` with adjustments | edit the currently reviewed artifact within the stated scope |
| `gate_b_decision=approve` | sign the displayed plan payload |
| `gate_c_decision=approve` | authorize the displayed billable generation intent |
| `preview_decision=approve` | render the displayed HTML preview signature |
| `gate_d_decision=approve` | export the displayed draft signature |
| `visual_recovery_decision=new_visual_revision` | reset an exhausted native visual-QA cycle |

`revise` is already edit authorization. It never means “reset QA.” `visual_recovery_decision` is not ordinary edit authorization; it exists only when the immediately preceding native result explicitly reports `visual_revision_recovery_available:true`.

## Required transition resolution

After any gate submission, post-gate revision request, or visual-revision error:

1. Identify the locked line and the artifact being reviewed. COMPOSE normally reviews a `composition`; AUTO, GENERATE, and EDIT normally review `production`, while an AUTO child composition remains a `composition`. The resolver uses that artifact type to select `composition.status` or `production.status` and never substitutes one line's approval operation for another.
2. Classify the requested patch scope:
   - `visual_only`: HTML/CSS/SVG/layout/motion/palette/assets or non-signed art-direction styling; no signed script, shotlist, delivery, approved copy, narration, source mapping, role, or narration-intent change.
   - `gate_b_payload`: wording/casing/punctuation shown on screen, timing, language, narration, delivery, source mapping, semantic roles, or signed narration intent changes.
   - `unknown`: insufficient information; inspect the requested files before asking anything.
3. Set recovery state from native evidence only:
   - `available` only from the latest result's literal `visual_revision_recovery_available:true`.
   - `not_available` when status says the cycle is passed/not exhausted, repair passes remain, or the tool returns `E_VISUAL_REVISION_NOT_REQUIRED`.
   - `unknown` otherwise.
4. Run the bundled resolver and obey its `next_action`, `form`, `allowed_ops`, and `prohibited_ops`. Do not emit a user form that the resolver did not return.

```bash
node <gate-control-dir>/scripts/resolve-transition.mjs \
  --line compose \
  --artifact composition \
  --gate gate_d \
  --decision revise \
  --scope visual_only \
  --recovery not_available
```

Line values are `compose`, `auto`, `generate`, or `edit`; artifact values are `composition` and `production`. If `--artifact` is omitted, COMPOSE defaults to composition and the other lines default to production. AUTO must pass `--artifact composition` while operating on a child composition. Optional inputs are `--recovery-decision`, `--error-code`, `--artifact-state`, and `--approval-status`. Use exact resolver enum values; on missing evidence use `unknown`, never guess `available`.

## Transition invariants

- A Preview or Gate D `revise` on `visual_only` scope with recovery `not_available` goes directly to a localized edit and the owning line's reconcile/QA path, then the next real artifact gate. It emits no recovery form and never calls `composition.begin_visual_revision`.
- A `gate_b_payload` revision opens at most one Gate B amendment form. When recovery is also `available`, that one form contains both `gate_b_decision` and `visual_recovery_decision`.
- `composition.begin_visual_revision` is allowed only when the resolver receives both recovery `available` and `recovery-decision=new_visual_revision` from the current real user turn.
- `E_VISUAL_REVISION_NOT_REQUIRED` is a control-flow correction: continue the existing cycle and emit no form.
- `E_VISUAL_REVISION_EXPLICIT_AUTHORIZATION_REQUIRED` does not by itself justify a form. If recovery availability was not already established, resolve to `query_status`; if status says not exhausted, continue the current cycle.
- `composition.submit_design_review` with `next_action=repair_visuals_then_composition.reconcile` stays in the current cycle and is never recovery availability.
- An approval already recorded for an unchanged artifact signature is consumed once and followed forward; it is not requested again.
- A passing snapshot may create one new Preview Gate, and a passing draft may create one new Gate D. These review newly materialized artifacts; no other technical step creates a user gate.

## Operation ordering for signed amendments

For a combined or Gate B amendment submission:

1. Begin visual recovery only when the resolver explicitly allows it.
2. Apply the exact bounded patch.
3. When the signed Gate B payload changed, call `composition.approve_plan` after the files changed while the current real user message still carries `gate_b_decision=approve`.
4. Then reconcile/doctor as required and continue native QA.

Never run lint first and convert `E_GATE_B_ARTIFACT_CHANGED` into another technical confirmation. Never promise immediate render when a later native Preview Gate must review a newly generated artifact.

## Form budget

One user decision may produce at most one follow-up authorization form, and only when it requests a capability not already granted:

- signed payload changed -> `gate_b_decision`;
- exhausted QA reset -> `visual_recovery_decision`;
- both -> one combined form;
- neither -> no form.

Questions, status checks, plan bookkeeping, advisory QA, repair passes that remain, reconciliation, and tool misuse errors never create a form.
