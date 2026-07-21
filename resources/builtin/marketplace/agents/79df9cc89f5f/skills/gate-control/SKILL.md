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

## User-facing confirmation names

`Gate A/B/C/D`, `HTML Preview`, and the `*_decision` ids are internal protocol terms. They may appear in logs, diagnostics, tests, and tool calls, but **must not appear in normal user-facing headings, forms, progress updates, or error explanations**. Use the current User UI language and these plain-language names instead:

| Internal protocol | Chinese UI | English UI |
| --- | --- | --- |
| Gate A | 制作方向确认 | Direction confirmation |
| Gate B | 制作方案确认 | Production plan confirmation |
| Gate C | 付费素材生成确认 | Paid generation confirmation |
| HTML Preview | 画面预览确认 | Visual preview confirmation |
| Gate D | 成片确认 | Final video confirmation |

Do not write hybrids such as “Gate B（制作方案确认）” in normal user output. Show only the localized plain-language title. When explaining a blocker, describe the missing user action or artifact directly—for example, “请先确认制作方案” or “Please confirm the production plan”—while keeping internal error codes available only in diagnostic details.

## Canonical confirmation forms (internal protocol)

Every user confirmation shows its current review artifact, a concise next-action/cost/QA note, one form, and then `<plan-interaction status="open" />`. Do not call another tool after opening the form. Each decision select uses `approve` and `revise`, with free-text feedback in a separate `adjustments` field. A new turn, question, or unrelated message is never approval.

| Gate | Required review artifact | Decision id | Approved transition |
| --- | --- | --- | --- |
| Gate B | COMPOSE script + shotlist + narrator, or production EDL | `gate_b_decision` | composition artifact -> `composition.approve_plan`; production artifact -> `production.approve_plan` |
| Gate C | exact billable segment count plus current credit/billing evidence | `gate_c_decision` | `production.approve_generation` before any provider call |
| HTML Preview | contact sheet for the current composition signature | `preview_decision` | `composition.approve_preview` before draft |
| Gate D | draft video plus QA/design-review headline | `gate_d_decision` | composition artifact -> `composition.approve_draft` before export; production artifact -> owning production finalization path |

The direction-confirmation proposal is non-production: show the locked line, aspect, duration, video language, audio mode, one to three concepts, supplied-asset usage, and any billable cost note. Its form must always include an editable `language` select. Resolve the initial video language in this order: an explicit language in the user's request, otherwise the current User UI language from system context, otherwise English. Supported User UI defaults are `zh`/`zh-CN` -> `zh-CN`, `en`/`en-US` -> `en`, `ja`/`ja-JP` -> `ja`, and `pt`/`pt-BR` -> `pt-BR`; an unavailable or unsupported UI language falls back to `en`. The select must offer English, Simplified Chinese, Japanese, and Brazilian Portuguese, and its submitted value overrides the inferred default. Once direction confirmation is submitted, keep that video language locked unless the user explicitly changes it; a later UI-language change must not rewrite the locked deliverable language. Direction confirmation does not authorize production-plan approval, paid work, rendering, or export.

Gate C may open only from a current signed plan and a fresh `production.status` whose quote is available and sufficient. Show billable generation count; expected, maximum/required, and available credits; optional managed-fallback coverage; and externally billed/unverified segments. A pending or failed provider attempt is not reusable authorization: a user-requested retry requires a fresh Gate C and a new output path. When the latest `production.status` already reports the current signature, available/sufficient quote, and a pending or failed attempt whose provider outcome cannot be reconciled, do not query status again. If the user has explicitly asked to continue or retry, open that fresh Gate C immediately with no host call in the form-opening turn; only its later approval turn may call `production.approve_generation` and dispatch the new output path. Never interleave per-shot confirmations.

An AUTO child composition inherits the current parent Gate B only through `composition.approve_plan` with the owning `plan_path` and `segment_id`. A binding mismatch returns to the single parent EDL Gate B; it never creates a child Gate B.

## Authority is not the same as recovery

Normalize every real user form submission into capabilities:

| User decision | Capability granted |
| --- | --- |
| any named Preview/Gate D `revise` with adjustments | edit the currently reviewed artifact within the stated scope and restart an exhausted non-billable visual-QA cycle when required |
| `gate_b_decision=approve` | sign the displayed plan payload |
| `gate_c_decision=approve` | authorize the displayed billable generation intent |
| `preview_decision=approve` | render the displayed HTML preview signature |
| `gate_d_decision=approve` | export the displayed draft signature |
| legacy `visual_recovery_decision=new_visual_revision` | consume an already-visible recovery form emitted by VideoStudio 1.1.5 or older; never emit this form in a new task |

`revise` is the complete user authorization for that bounded modification. Restarting an exhausted internal visual-QA cycle is non-billable implementation detail, so it never requires a second user confirmation. `visual_recovery_decision` is backward-compatible input only. A Gate B amendment creates a new signed signature and therefore a fresh QA cycle; it never also needs visual recovery.

## Required transition resolution

After any gate submission, post-gate revision request, or visual-revision error:

**Gate-submission fast path:** after reading this skill, call the owning native status operation and run the resolver before `manage_execution_plan` or any broad `read_file` of manifest/HTML. Status and the submitted form already contain the authorization facts. Read only the exact artifacts needed after the resolver returns an edit/approval action.

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
- The same `revise` with recovery `available` calls `composition.begin_visual_revision` internally, performs the localized edit, and continues QA. The existing revise decision is sufficient; never emit `visual_recovery_decision`.
- A `gate_b_payload` revision opens exactly one Gate B amendment form. On approval, apply the displayed bounded patch and call `composition.approve_plan`; the changed signature invalidates the old preview/draft/QA cycle and starts fresh QA without `visual_recovery_decision` or `composition.begin_visual_revision`.
- `composition.begin_visual_revision` is allowed only when the resolver receives recovery `available` plus the current Preview/Gate D `revise`, or while consuming a legacy `recovery-decision=new_visual_revision` form that is already visible.
- `E_VISUAL_REVISION_NOT_REQUIRED` is a control-flow correction: continue the existing cycle and emit no form.
- `E_VISUAL_REVISION_EXPLICIT_AUTHORIZATION_REQUIRED` does not justify a form. If recovery availability was not already established, resolve to `query_status`; if status says not exhausted, continue the current cycle; if it is exhausted and there is no current revise decision, report the QA blocker and wait for the user's next real revision request.
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
- same signed payload exhausted its QA budget -> no form; the next real Preview/Gate D `revise` authorizes the internal restart;
- an approved Gate B amendment starts fresh QA and never produces a combined or follow-up recovery form;
- neither -> no form.

Questions, status checks, plan bookkeeping, advisory QA, repair passes that remain, QA-cycle restart, reconciliation, and tool misuse errors never create a form. `visual_recovery_decision` must not appear in newly emitted VideoStudio output.
