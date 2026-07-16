---
ownerAgent: 79df9cc89f5f
name: composition-design-review
min_app_version: "1.5.1"
description_zh: VideoStudio 的 COMPOSE 设计审查层 - 在 stage-compose draft/inspect 后,检查 HTML/动态图形视频的模板感、首帧、视觉层级、可读性、风格一致、动效目的和 DESIGN.md/品牌 token 执行情况,只输出可执行修复。
description_en: Design review layer for VideoStudio COMPOSE drafts. Use after stage-compose draft/inspect to assess template feel, first frame, hierarchy, readability, style consistency, purposeful motion, and adherence to DESIGN.md/brand tokens, returning only actionable fixes.
category: creation
---

# composition-design-review

Use this after `video_studio` `op: "composition.draft"` returns `design_review_required: true`. It is a design QA layer, not a renderer, line router, or generic video craft checklist. Submit its verdict through `composition.submit_design_review`; prose alone does not satisfy the host gate.

Do not open a new user Gate. Read `steps.inspect.draft_disposition` when present. Host-classified semantic readability blockers must already be repaired before draft succeeds. For the remaining design judgment, make at most one localized repair to `manifest.art_direction` or the affected HTML and re-run the draft command before Gate D. Submit `repair`/`blocked` with concrete evidence when needed, or `passed` before Gate D.

## Activation

The host requires this review for long/scene-dense drafts and may also require it for design-sensitive work. Review when any of these is true:

- The draft result contains `design_review_required: true` (authoritative).

- The approved brief is brand, product, promo, launch, version-update, portfolio, or other design-led COMPOSE work.
- `project/composition/composition-manifest.json::art_direction.style_source` is present.
- The draft report or sampled frames show a visible design risk that deterministic QA cannot judge, such as a weak first frame, flat hierarchy, repeated scene grammar, or motion that hides the message.

Do not run this review for non-COMPOSE edit/TTS/clip-selection work. For COMPOSE, always follow the draft result even when the visual concept is otherwise simple.

## Review Inputs

Read only the relevant artifacts:

- `project/composition/composition-manifest.json`, especially `art_direction` and the affected canonical scene
- `project/composition/narration-map.json` as read-only evidence when detailed narration-line alignment matters
- `project/composition/qa/inspect.json` or `project/render/draft-report.json`
- Sampled evidence frames from the draft report when available: `video_qa.contact_sheet`, `video_qa.frame_paths`, first frame, one mid-frame per scene, and payoff/closing frame
- The approved script/shotlist only when a finding depends on message intent

## Findings Rubric

Tag each finding as `blocker`, `fix`, or `polish`.

Blockers must identify a specific scene/frame, the visible evidence, and the smallest repair. A finding is not a blocker just because the design could be more distinctive, or because inspect reported a visual advisory that does not break the approved promise.

Blockers:

- First frame is blank, unreadable, or fails to state the approved promise in a promo/version-update/launch deliverable.
- Text is unreadable in the supplied evidence frame, hides the approved promise/CTA, or materially blocks comprehension because of size, safe-zone, overlap, occlusion, or contrast.
- The draft report's `contract_html` step says approved scene copy, canvas, assets, or runtime dependencies do not match the model-authored HTML.
- Visual language contradicts an explicit style source or ignores required brand tokens.
- The piece reads as a slideshow when the approved promise was motion graphics.
- Motion hides the message, distracts from the focal point, or breaks narration timing.
- A protected logo/asset/layout was copied without ownership or permission.

Fix:

- First frame is truthful and readable but could be a stronger thumbnail.
- Text has a visible safe-zone, size, overlap, occlusion, or contrast advisory, but the main message remains readable and the draft is useful for Gate D review.
- Repeated layout, transition, or card pattern three or more times in a row.
- Palette uses extra chromatic colors beyond the contract.
- Type hierarchy is flat or labels feel like UI residue instead of video graphics.
- Scene density is too high for phone viewing.
- Style-source adaptation is vague: it borrows mood words but no concrete tokens.

Polish:

- Easing, stagger, spacing, shadow, stroke, or texture could better support the tone.
- A stronger thumbnail frame or payoff hold would improve memorability.
- A minor token mismatch that does not hurt comprehension.

## Repair Preference

Fix the highest-level canonical artifact that caused the issue:

1. `composition-manifest.json::art_direction` when the thesis, style source, tokens, layout budget, or per-scene visual plan is wrong.
2. `composition-manifest.json` when canonical scene timing or source-shot mapping is wrong; use the normal `stage-compose` reconciliation path after changing protected fields.
3. `index.html` for visual hierarchy, typography, layout, motion, asset, or scene variation fixes.

Use `narration-map.json` only to diagnose detailed narration-line alignment. Do not edit it from design review; hand alignment findings back to `stage-compose`, which owns narration materialization and reconciliation.

Do not solve design problems by only nudging pixels. If the issue is "too generic", change the signature device or scene grammar. If the issue is "too dense", remove or split content.

## Output Format

Return a compact review object or bullets, then call the tool with the same evidence:

- `verdict`: pass | repair | block
- `review_scope`: why this review was triggered
- `design_direction`: one line
- `blockers`: concrete location + evidence + repair
- `fixes`: concrete location + repair
- `polish`: optional
- `next_action`: rerun draft, open Gate D, or surface blocker

```json
{"op":"composition.submit_design_review","composition_dir":"project/composition","review_verdict":"passed","review_scope":"contact sheet + per-scene midpoint/payoff frames","review_findings":[]}
```
