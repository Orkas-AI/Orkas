---
ownerAgent: 7e91cb9ec9e9
name: ppt-review
description_zh: 在已有 office_check 和逐页 office_render 证据后，诊断单页审美、参考一致性与整套叙事节奏，以具体缺陷而非固定审美分数驱动定向修复和复验。
description_en: After structural validation and per-slide renders exist, diagnose slide aesthetics, reference fit, and whole-deck narrative rhythm, then repair concrete evidence-based defects from current evidence.
category: office
---

# PPT Review

Read this skill only after current `office_check` output and relevant `office_render` images exist. Do not use source code, a tool success flag, or the first-slide preview as a substitute for deck evidence.

## Evidence set

- Run `office_check` after every create or edit. Invalid OpenXML is a blocker, not a warning.
- For a new deck, render every slide. For an existing deck, render every changed slide plus the cover, a representative unchanged content slide, and any slide whose theme, master, or shared element could be affected. Every render intended as current visual-defect evidence must set `analysis_mode:"quality_review"`; ordinary source understanding keeps the default `understand` mode.
- After a repair affects multiple pages, request their independent `office_render` calls together in one assistant tool-call batch, each with `analysis_mode:"quality_review"`. Do not insert a model round between page renders; one collected image set lets managed visual preprocessing analyze the affected pages as a batch. If one render fails, retry only that page rather than rerendering the successful set.
- Rendered image blocks are transient after the next assistant response. In the first response that sees each collected `quality_review` image set, write one concise plain-language evidence sentence before any follow-up tool calls: name the reviewed pages, concrete pass/defect observations, and the next action. This sentence is the durable visual-review state for later tool rounds and compaction. When exact edit paths are needed, request the targeted `office_read` calls together in that same response; do not rerender an unchanged `artifact_revision` merely to recover forgotten pixels.
- Use the returned `artifact_revision` to distinguish current from stale check/render evidence and `image_revision` to compare rerenders. If an edit claimed to repair a visible defect but the affected page keeps the same `image_revision`, do not claim a visual repair: verify that the edited artifact revision was rendered, then make a supported layout/content change or retain the finding as unresolved.
- If rendering is unavailable, mark visual checks `not_run`; do not infer a pass from structural validity.

## Two review layers

Review every required render at slide level, then review the contact-sheet-like sequence as a whole. A slide can be individually tidy while the deck still fails because every page repeats the same card grid or the visual language drifts.

### Per-slide review checklist

Mark each item `PASS`, `WARNING`, or `BLOCKER` and attach a concrete observation from the current render. Do not derive a result from intent, source code, or self-description.

- `intent_fit`: the visual form makes the slide's takeaway easier to understand;
- `hierarchy`: the first, second, and supporting reading order is unmistakable;
- `composition`: focal point, balance, alignment, whitespace, and safe margins work together;
- `typography`: type scale, line length, wrapping, density, and CJK rendering are presentation-legible;
- `color_contrast`: palette is coherent and primary audience-facing text is readable in the current render;
- `visual_usefulness`: chart, diagram, table, or image explains rather than decorates.

For every chart, also verify from the current render that each visible value label
maps to one data point, appears only once, and does not collide with another label,
axis, or series mark. Duplicated manual and native labels, label-to-point
misalignment, and collisions are concrete repair defects even when the underlying
series values are correct.

When a visual reference exists, also record `reference_fit`: the result follows the declared `keep` and `adapt` traits without copying `do_not_copy` material. Do not mark an intentional, authorized deviation as a defect merely because it differs from an autonomous default.

Checklist results are diagnostic evidence used to find the weakest pages and prioritize repairs. Use `BLOCKER` only for a concrete delivery failure such as clipped or unreadable primary content, an unsupported or materially false claim, invalid structure, or a requested reference/template requirement that was not met. Otherwise classify a supported defect as `WARNING` and improve it when a proportionate edit is available. Never invent a numeric aesthetic score or average.

### Whole-deck review

- layout rhythm supports the narrative; there is no numeric family minimum or repetition ceiling;
- repeated geometry is coherent when it supports a series, comparison, recurring case, or reference-template rhythm, and mechanical when it obscures different communication jobs;
- density changes are intentional when useful, without requiring a prescribed sparse/dense alternation;
- background modes may vary when they serve a section, slide role, or semantic
  emphasis. Unexplained mechanical dark/light alternation or an isolated theme
  switch is a `WARNING` to record and repair, not an automatic blocker;
- equal-card grids communicate genuine parallelism rather than appearing by default;
- cover, opening, evidence, decision, and close feel intentionally designed for their roles;
- charts, image treatments, sources, page numbers, and recurring elements stay consistent.

When the same weakness recurs across multiple slides or a shared component, repair the underlying token, component, or layout pattern rather than nudging each page independently. After repair, rerender every affected slide and repeat the whole-deck pass.

## Three-dimensional review

Use the checklist and whole-deck evidence to complete the broader quality review below.

For a review-only request, make the report independently actionable. Cover every
reviewed slide and label each finding `Content`, `Design`, or `Coherence` plus
`BLOCKER`, `WARNING`, or `PASS`. Each non-pass finding must name the current
evidence, user impact, and smallest supported repair. Across the report, include
at least one explicit evidence-based result for each of the three dimensions;
do not collapse them into generic deck-level praise or a list of unlabelled
suggestions.

### Content

- The deck answers the brief and ends with the intended decision, action, or learning outcome.
- Each slide has one dominant takeaway and all supporting copy serves it.
- Claims, values, dates, labels, units, and sources match the evidence boundary.
- Explicit user-supplied slide titles, labels, and page order match the current
  output verbatim. A missing, renamed, synonymized, or reordered contracted
  string is a `BLOCKER`, even when the substitute reads more editorially.
- Supplied content has not been expanded into invented source facts merely to
  fill a layout; missing copy remains a neutral placeholder or visibly labeled
  draft rather than being presented as user-provided material.
- Placeholders, template residue, accidentally duplicated or overlapping text, broken glyphs, and unsupported promises are absent. Repeated wording in intentional, distinct roles is not a defect by itself.
- Tables and simple data visuals preserve the supplied category/series mapping and status labels, remain legible, use one non-colliding value-label system, and include the relevant period label, unit, and source.

### Design

- No primary content is clipped, overflowing, obscured, outside safe margins, or too small to present.
- Alignment, spacing, hierarchy, contrast, image crop, and text wrapping are intentional.
- The locked palette, typography roles, grid, and visual grammar remain consistent.
- When references exist, the result respects their declared role and reuse boundary; when they do not, the autonomous visual direction remains coherent and fully designed.
- Images are sufficiently clear and not stretched; raster content does not replace editable text or diagrams.
- Density matches the brief, and decoration does not compete with the message.

### Coherence

- Slide order forms an understandable argument, not a set of independent pages.
- Titles, terminology, numbers, tense, voice, source style, and layout rhythm are consistent.
- Transitions between sections are clear, and repeated information is deliberate.
- Cover, opening, evidence, decision/close, and appendix roles match the outline.

## Findings and repair

Classify each finding:

- `BLOCKER`: invalid OpenXML, missing/blank required slide, clipped or unreadable primary content, unresolved placeholder/template text, a material unsupported claim, or a deliverable that is not an editable PPTX when one was requested.
- `WARNING`: visible but non-blocking density, hierarchy, consistency, image-quality, source-placement, or target-viewer risk.
- `PASS`: supported by named structural or render evidence.

Repair blockers and straightforward warnings with the smallest edit. Before `edit_office`, use `office_read` to get the exact target path, then call `edit_office` with `preview:false`. Its automatic first-page preview must not run ahead of structural validation or substitute for current review evidence. Consolidate all known defects into one edit batch where possible before requesting new render evidence. After each repair batch, rerun `office_check`, then rerender only affected slides at a new `artifact_revision`; never rerender an unchanged page/revision. Continue only while current evidence identifies a concrete blocker or a proportionate repair. Stop when only non-blocking warnings remain or another pass would not materially improve the user-facing deck, and disclose those warnings. If a blocker remains unresolved, do not publish the deck as complete; preserve and report the last structurally valid artifact when useful and label the remaining boundary. Existing-deck edit work may continue with another safe, evidence-based pass when it can resolve a remaining blocker without changing the authorized scope.

Do not repair by hiding content, shrinking all text globally, flattening the page, removing source labels, or changing the locked narrative without evidence that the plan itself was wrong.

## Delivery gate

For a `REVIEW` route, the requested deliverable is the review report in the
assistant message. Do not call `create_pptx`, `edit_office`, or
`publish_outputs`, do not create a review copy, and leave the source byte-identical.
Do not create or update a runtime execution plan for review-only work; deliver
the evidence-based report directly after inspection so plan bookkeeping cannot
suppress it.
The PPTX publication rules below apply only to `CREATE` and `EDIT` routes.

Publish only when:

- OpenXML validation passes;
- every required render was reviewed or unavailable checks are explicitly disclosed;
- no blocker remains;
- the final whole-deck review records concrete observations and any remaining non-blocking warnings;
- the final path is the validated candidate, not an earlier draft or backup.

Do not call `publish_outputs` until the last current-render review and its
quality record are complete. If any edit or render-based review happens after
publication, treat the published result as stale and publish the validated
candidate again only after all gates pass.

Call `publish_outputs` with only that final `.pptx`. The handoff names the path, slide count, edits or produced scope, plain-language content/design/flow result, checks actually run, repair passes, source limitations, unsupported PowerPoint features, and any target-viewer review still needed. Do not expose the internal route or depth codes in the handoff.

The final handoff must make the review evidence auditable instead of saying
only “checked” or “looks good”. Include three short labeled lines—`内容`, `设计`,
and `连贯性` (or natural equivalents in the user's language)—plus the number of
slides structurally checked and rendered. Under `设计`, name the autonomous or
reference-derived direction, the weakest observed page, material repairs, and
remaining warnings. Do not include numeric aesthetic scores. Under `连贯性`, describe whether repetition,
variation, and density support the narrative without forcing a numeric family
count or prescribed rhythm. Do not invent observations that were not recorded
from current renders.

Use this compact handoff shape so the evidence is understandable and cannot be
lost during a long tool run (replace every bracket with observed evidence):

```text
内容：目标动作是 [企业购方在汇报后要做的决策]；[8] 页均使用结论式标题且每页一个主结论，例如 [P2 实际标题] / [P5 实际标题]；[页面覆盖与叙事路径]；[证据边界]；结构检查 [8/8] 页通过。
设计：[8/8] 页已逐页渲染；视觉来源为 [自主设计 / 文字方向 / 参考图 / 参考 PPT]；视觉系统为 [具体艺术方向、主要颜色、字体层级、画布/背景和图片处理]；最弱页面为 [P# 与实际观察]；[已完成的定向修复]；[原生可编辑文本、图形、图表/表格的实际覆盖]；[剩余非阻塞提示或无]。
连贯性：[重复和变化如何服务叙事]；[信息密度和章节节奏的实际观察]；[参考一致性或自主设计一致性]。
```

Do not replace concrete render observations with vague claims such as “整体良好”. Include the actual visual source, art direction, palette behavior, type hierarchy, background/canvas language, and image/chart treatment so the user can understand what visual system was delivered. Exact grid, margin, and palette values are useful when they materially explain the result, but their omission alone is not a publication blocker.

For a generated product deck, the Content line must include the action
objective and at least two actual conclusion-title examples from the current
file. If the current titles are bare topic labels, repair them before handoff
only when the user did not explicitly fix that visible wording. Never rewrite a
contracted title merely to make it more assertion-like.
After the three evidence lines, include a compact slide map for every slide in
the form `P# — [actual takeaway] | [actual visual focus]`. This map is required
for a generated deck so the story sequence and editable visual choices can be
reviewed independently; do not substitute a topic-only agenda or a count of
layout families.
Then include one compact audit row for every generated slide, derived from the
current render: `P# — Content PASS/WARNING/BLOCKER; Design
PASS/WARNING/BLOCKER; Coherence PASS/WARNING/BLOCKER`. Every non-pass result
must add the observed evidence in the same row. The takeaway/visual-focus map
does not replace these per-slide three-dimensional records, and a positive
summary does not override a page-level finding.
Build this audit block before `publish_outputs`, count its rows, and verify that
the count equals the generated slide count and that every page number appears
exactly once. Missing, duplicate, or deck-level-only audit evidence blocks
publication. After publishing, copy the already-counted block into the final
handoff instead of reconstructing it from memory.
For a generated deck grounded in supplied files or data, also include a compact
`来源事实` ledger. Name every source file, reproduce every numeric sequence with
its period or region, unit, and actual/target status, and list material
non-numeric constraints or risks that the deck carries forward. This ledger
must come from the current sources and deck; it is handoff evidence, not a
license to add or reinterpret facts.
The Design line should name the actual construction choices that matter to the current deck. Prefer concrete colors, type anchors, alignment logic, and crop/background treatment when they were recorded, but do not turn a fixed token checklist into a release gate for a reference-led or intentionally custom composition.
