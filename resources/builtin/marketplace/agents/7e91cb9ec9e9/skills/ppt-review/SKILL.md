---
ownerAgent: 7e91cb9ec9e9
name: ppt-review
description_zh: 在首次质量检查前读取，指导结构检查、逐页视觉审查和整套叙事检查，记录具体问题并定向修复、复验。
description_en: Guide structural checks, slide and deck review, evidence records, and targeted repairs; read before the first quality review.
---

# PPT Review

Read this skill before the first deck or output quality review, so its criteria are available when the rendered images arrive. Apply the criteria to current `office_review` structural output and relevant rendered images. Do not use source code, a tool success flag, or the first-slide preview as a substitute for deck evidence.

## Evidence set

- Run `office_review` with `action:"check_and_render"` after every create or edit. Invalid OpenXML is a blocker, not a warning.
- For a new deck, render every slide. For an existing deck, render every changed slide plus the cover, a representative unchanged content slide, and any slide whose theme, master, or shared element could be affected. Every render intended as current visual-defect evidence must set `analysis_mode:"quality_review"`; ordinary source understanding keeps the default `understand` mode.
- After a repair affects multiple pages, request them together in one `office_review` call with `action:"check_and_render"`, a `pages` array, and `analysis_mode:"quality_review"`. One collected image set lets managed visual preprocessing analyze the affected pages as a batch. If one render fails after a valid check, retry only that page with `action:"render"` rather than rerendering the successful set.
- In the first response that sees each collected `quality_review` image set, record concrete findings with page numbers, supporting observations, and repair or retain decisions before follow-up tool calls. These are working notes, not the final handoff table; preserve observations for all reviewed pages, including pages without defects. Update only the affected findings after a repair, using the current render; retain unchanged-page evidence. When exact edit paths are needed, request targeted `office_read` calls together; do not rerender an unchanged `artifact_revision` merely to recover forgotten pixels.
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

Repair blockers and straightforward warnings with the smallest edit. Before `edit_office`, use `office_read` to get the exact target path, then call `edit_office` with `preview:false`. Its automatic first-page preview must not run ahead of structural validation or substitute for current review evidence. Consolidate all known defects into one edit batch where possible before requesting new render evidence. After each repair batch, call `office_review` with `action:"check_and_render"`, rerendering only affected slides at a new `artifact_revision`; never rerender an unchanged page/revision. Continue only while current evidence identifies a concrete blocker or a proportionate repair. Stop when only non-blocking warnings remain or another pass would not materially improve the user-facing deck, and disclose those warnings. If a blocker remains unresolved, do not publish the deck as complete; preserve and report the last structurally valid artifact when useful and label the remaining boundary. Existing-deck edit work may continue with another safe, evidence-based pass when it can resolve a remaining blocker without changing the authorized scope.

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

### Prepare the complete handoff before publication

Assemble the complete handoff below from current structural checks, per-page
observations, repairs, and the whole-deck review, whether or not an earlier audit
table exists. Reuse available current evidence; do not depend on intermediate
notes already having the final format. If a required record is missing, first
reconcile the retained observations and current file, then verify only the
missing evidence. Never default an unassessed dimension to PASS. When visual
evidence is unavailable, disclose `not_run` rather than claiming a review.
An omitted text record alone does not justify rerendering an unchanged revision.

For a generated deck, fill one slide-map entry and one Content/Design/Coherence
row per slide. Use `PASS`, `WARNING`, or `BLOCKER` for assessed findings, with
concrete evidence; unavailable checks remain `not_run`. Every non-pass result
retains its repair or retain decision. Complete the whole-deck review before
finalizing Coherence. A positive summary or slide map cannot replace these rows.
Count the rows against the actual generated slide count and check that every
page number appears exactly once. Missing, duplicate, or deck-level-only audit
evidence blocks publication. EDIT keeps its required review scope; disclose
which pages were inspected rather than claiming unreviewed pages passed.

Use this single handoff structure in the user's language, replacing every
bracket with actual evidence. Include the slide map and page rows for generated
decks, and the source ledger when supplied files or data ground the deck:

```text
交付：[最终 PPTX 路径]；[页数与制作或修改范围]。
内容：目标动作是 [受众需要做出的决策或行动]；[实际页面覆盖与叙事路径]；结论式标题例如 [P2 实际标题] / [P5 实际标题]；[证据边界]；结构检查 [已检查/总页数] 页通过。
设计：[已渲染/总页数] 页已逐页审阅；视觉来源为 [自主设计 / 文字方向 / 参考图 / 参考 PPT]；视觉系统为 [艺术方向、颜色、字体层级、画布/背景和图片或图表处理]；最弱页面为 [P# 与比较其他页面后的具体观察]；定向修复：[修复页面、问题与复验结果，或无需修复]；[原生可编辑元素的实际覆盖]；剩余提示：[具体非阻塞问题或有证据支持的无]。
连贯性：[重复、变化、信息密度和章节节奏如何服务叙事]；[参考一致性或自主设计一致性]。
逐页内容与视觉重点（生成的每一页各一项）：
P# — [实际主结论] | [实际视觉重点]
逐页审阅（生成的每一页各一行）：
P1 | Content: PASS — evidence | Design: WARNING — evidence | Coherence: PASS — evidence
来源事实（有来源文件或数据时）：[每个来源文件；数值序列及期间或地区、单位、实际/目标状态；沿用的重要非数值约束或风险]。
交付边界：[来源限制、不支持的 PowerPoint 特性、未执行检查与仍需在目标查看器核验的内容；没有时说明无]。
```

For a generated product deck, include at least two actual conclusion-title
examples from the current file. Repair bare topic titles only when the user did
not fix their visible wording; never rewrite a contracted title for this format.
Use concrete render observations, not vague praise.
Explain the actual visual source, art direction, palette behavior, type hierarchy,
background/canvas language and image/chart treatment; exact token values are
useful only when they explain the result, not a fixed release gate. Do not include numeric aesthetic scores.
Keep the labels `Content`, `Design`, and `Coherence`; unlabeled adjectives do not
replace status fields. The source ledger reports supplied facts, not permission
to add or reinterpret them.

Once this complete handoff and all gates are satisfied, call `publish_outputs`
with only the final `.pptx`, then send the prepared handoff with the returned file
path. Preserve its page records, weakest-page finding, repairs and remaining
warnings rather than shortening it to a success summary. The handoff provides a
plain-language content/design/flow result and checks actually run. Do not expose the internal route or depth codes.
