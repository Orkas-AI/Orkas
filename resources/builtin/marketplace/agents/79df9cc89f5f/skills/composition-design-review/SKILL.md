---
ownerAgent: 79df9cc89f5f
name: composition-design-review
min_app_version: "1.6.0"
description_zh: VideoStudio 的 COMPOSE 设计审查层 - 优先在 HTML 预览展示前完整检查首帧、每镜中点与收束帧；无预览时才在 draft 后兜底，只输出一次汇总的可执行修复。
description_en: Design review layer for VideoStudio COMPOSE. Prefer a complete first-frame, per-scene midpoint, and payoff review before exposing HTML preview; fall back to post-draft review only when preview was skipped, returning one batched set of actionable fixes.
category: creation
---

# composition-design-review

Use this first when `video_studio` `op:"composition.snapshot"` returns `preview_design_review_required:true`, before the preview is shown. Use it after `composition.draft` only when that draft still returns `design_review_required:true`, which is the no-preview fallback. It is a design QA layer, not a renderer, line router, or generic video craft checklist. Submit its verdict through `composition.submit_design_review`; prose alone does not satisfy the host state.

Do not open a new user Gate. For preview review, inspect every returned frame path at usable scale before choosing a verdict; the contact sheet is only an index. Do not stop after the first defect. Collect all concrete visible blockers across the full frame set, submit one `repair` verdict, make one batched localized repair to `manifest.art_direction` or affected HTML, and re-run inspect + snapshot. Submit `passed` only for the complete current snapshot signature. For the no-preview draft fallback, read `steps.inspect.draft_disposition` when present and re-run draft after a repair.

## Activation

The host requires this review before showing a captured preview and may require a post-draft fallback for short work that skipped preview. Review when either authoritative result requests it:

- The snapshot result contains `preview_design_review_required:true` (authoritative and preferred).
- A draft produced without a reviewed preview contains `design_review_required:true` (authoritative fallback).

- The approved brief is brand, product, promo, launch, version-update, portfolio, or other design-led COMPOSE work.
- `project/composition/composition-manifest.json::art_direction.style_source` is present.
- The draft report or sampled frames show a visible design risk that deterministic QA cannot judge, such as a weak first frame, flat hierarchy, repeated scene grammar, or motion that hides the message.

Do not run this review for non-COMPOSE edit/TTS/clip-selection work. For COMPOSE, always follow the current snapshot/draft result even when the visual concept is otherwise simple. When draft says `design_review_inherited_from_preview:true`, do not repeat the static design review.

## Review Inputs

Read only the relevant artifacts:

- `project/composition/composition-manifest.json`, especially `art_direction` and the affected canonical scene
- `project/composition/narration-map.json` as read-only evidence when detailed narration-line alignment matters
- `project/composition/qa/inspect.json`, or `project/render/draft-report.json` only for fallback review
- For preview review, the snapshot result's `contact_sheet` and every `frame_paths` item: first frame, every scene midpoint, and payoff/closing frame. Open every path individually; do not infer full coverage from a thumbnail sheet.
- For fallback review, sampled evidence frames from the draft report: `contact_sheet`, `frame_paths`, first frame, one mid-frame per scene, and payoff/closing frame
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
- English titles, body copy, captions, subtitles, or CTAs are forced to all caps, or two or more English text roles in one scene use all caps. Restore the approved natural casing and use scale, weight, width, color, or spacing for hierarchy. Existing all caps may remain only when the exact casing appears in approved user copy or an external brand/source and is limited to one short metadata label, acronym, or code; a model-authored art direction or style rationale is not an exception.
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

Return one compact review object or bullets after the entire evidence set has been inspected, then call the tool with the same evidence:

- `verdict`: passed | repair | blocked
- `review_scope`: why this review was triggered
- `reviewed_frame_paths`: every current snapshot frame path inspected; required for preview review
- `design_direction`: one line
- `blockers`: all concrete locations + evidence + repair, not only the first finding
- `fixes`: concrete location + repair
- `polish`: optional
- `next_action`: rerun inspect + snapshot, open the existing Preview Gate, rerun draft for fallback review, open Gate D, or surface blocker

```json
{"op":"composition.submit_design_review","composition_dir":"project/composition","review_verdict":"passed","review_scope":"first frame + every returned scene midpoint/payoff frame","review_findings":[],"reviewed_frame_paths":["/absolute/path/01-first-frame.png","/absolute/path/02-scene-mid.png","/absolute/path/03-payoff.png"]}
```
