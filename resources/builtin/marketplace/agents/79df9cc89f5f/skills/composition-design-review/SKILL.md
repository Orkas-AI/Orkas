---
ownerAgent: 79df9cc89f5f
name: composition-design-review
min_app_version: "1.6.5"
description_zh: VideoStudio 的 COMPOSE 视觉自检清单 - 在展示 HTML 预览前，由作者自己完整检查首帧、每镜中点与收束帧，汇总一次可执行修复；不向宿主提交任何审查结果。
description_en: Advisory visual checklist for VideoStudio COMPOSE. The author reviews the first frame, every scene midpoint, and the payoff frame before exposing the HTML preview, batching actionable fixes; nothing is submitted to the host.
category: creation
---

# composition-design-review

Apply this checklist yourself after a successful `composition.snapshot`, before the preview is shown. It is advisory: nothing is submitted to the host, no operation records a verdict, and no gate waits on it — the host publishes the contact sheet with the passing snapshot. It is a design QA layer for your own authoring, not a renderer, line router, or generic video craft checklist.

Do not open a new user Gate. Native preflight/inspect/sampled-frame QA runs before this pass; a passing snapshot attaches the full-color contact sheet directly as model-visible evidence. Review every frame in that attached complete index, without reopening the sheet through generic `read_file`, and open at full scale only the frame-0 cover, frames named by QA findings, and frames whose sheet cell shows risk (dense or doubtful text, suspected overlap or blankness). Do not stop after the first defect. Collect all concrete visible blockers across the full frame set, make one batched localized repair to `manifest.art_direction` or affected HTML, and re-run inspect + snapshot; then re-check the complete new frame set.

## Activation

Apply the checklist whenever snapshot evidence exists, and give it extra weight when:

- The approved brief is brand, product, promo, launch, version-update, portfolio, or other design-led COMPOSE work.
- `project/composition/composition-manifest.json::art_direction.style_source` is present.
- Sampled frames show a visible design risk that deterministic QA cannot judge, such as a weak first frame, flat hierarchy, repeated scene grammar, or motion that hides the message.

Do not run this review for non-COMPOSE edit/TTS/clip-selection work. Do not repeat the full pass after the draft renders — post-draft QA is native and render-specific.

## Review Inputs

Read only the relevant artifacts:

- `project/composition/composition-manifest.json`, especially `art_direction` and the affected canonical scene
- Every composition-local image/video in `art_direction.references`, including declared roles, reproduce/edit/guide intent, preserve/may-change boundaries, target scenes, and layout/temporal anchors
- `project/composition/narration-map.json` as read-only evidence when detailed narration-line alignment matters
- `project/composition/qa/inspect.json`, or `project/render/draft-report.json` only for fallback review
- For preview review, the snapshot result's `contact_sheet` covering every `frame_paths` item: first frame, every scene midpoint, and payoff/closing frame. Open individual paths where the activation rule above points — cover, QA-named frames, risky cells.
- For fallback review, sampled evidence frames from the draft report: `contact_sheet`, `frame_paths`, first frame, one mid-frame per scene, and payoff/closing frame
- The approved script only when a finding depends on message intent

## Findings Rubric

Tag each finding as `blocker`, `fix`, or `polish`.

Blockers must identify a specific scene/frame, the visible evidence, and the smallest repair. A finding is not a blocker just because the design could be more distinctive, or because inspect reported a visual advisory that does not break the approved promise.

Blockers:

- First frame is blank, unreadable, or fails the dedicated cover contract: approved promise, dominant hero, and at least two recognizable signals of the actual video content.
- Text is unreadable in the supplied evidence frame, hides the approved promise/CTA, or materially blocks comprehension because of size, safe-zone, overlap, occlusion, or contrast.
- The draft report's `contract_html` step says approved scene copy, canvas, assets, or runtime dependencies do not match the model-authored HTML.
- Visual language contradicts an explicit style source or ignores required brand tokens.
- A reference image or video loses a declared preserve axis, changes something outside `may_change`, violates layout/temporal anchors, misses a requested edit, or is scored below `reference_fidelity.verification.minimum_score`.
- The piece reads as a slideshow when the approved promise was motion graphics.
- Motion hides the message, distracts from the focal point, or breaks narration timing.
- A protected logo/asset/layout was copied without ownership or permission.

Fix:

- First frame is truthful and readable but its topic signals are too generic or weak to work as a strong cover.
- Text has a visible safe-zone, size, overlap, occlusion, or contrast advisory, but the main message remains readable and the draft is useful for Gate D review.
- Repeated layout, transition, or card pattern three or more times in a row.
- Palette uses extra chromatic colors beyond the contract.
- Type hierarchy is flat or labels feel like UI residue instead of video graphics.
- English titles, body copy, captions, subtitles, or CTAs are forced to all caps, or two or more English text roles in one scene use all caps. Restore the approved natural casing and use scale, weight, width, color, or spacing for hierarchy. Existing all caps may remain only when the exact casing appears in approved user copy or an external brand/source and is limited to one short metadata label, acronym, or code; a model-authored art direction or style rationale is not an exception.
- Scene density is too high for phone viewing.
- Style-source adaptation is vague: it borrows mood words but no concrete tokens.
- Reference comparison is vague or based on provenance instead of the declared media intent, roles, protected attributes, allowed changes, and scene/time anchors.

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

Summarize your pass in a few bullets before continuing:

- `blockers`: all concrete locations + evidence + repair, not only the first finding
- `fixes`: concrete location + repair applied
- `polish`: optional notes that travel with the Gate D note

Then repair and re-run inspect + snapshot, or — when the frames read well — hand readiness to `gate-control`. There is no score to compute and nothing to submit: quality is judged by what is visibly broken in a specific frame, never by a number.
