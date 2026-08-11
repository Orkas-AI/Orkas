---
ownerAgent: 7e91cb9ec9e9
name: ppt-craft
description_zh: 把已锁定的 storyboard、版式语法和视觉系统映射为一次完整的 create_pptx 调用，优先生成有视觉焦点、原生可编辑且可复检的页面；已有 PPTX 只做基于元素路径的最小安全编辑。
description_en: Map the locked storyboard, layout grammar, and visual system to one complete create_pptx call that produces visually focused, native-editable, reviewable slides; existing decks receive only minimal element-path edits.
category: office
---

# PPT Craft

Read this skill only when an actual PPTX will be created or changed. Read the shared `office-ppt` Skill before the first PPTX tool call.

## Execute the visual source

Honor the resolved visual source before choosing slide geometry:

- `autonomous`: treat the planner's audience- and content-derived visual DNA as a complete design source. No reference file is required, and the result must still use purposeful backgrounds, visual hierarchy, media/data treatments, and content-led composition rather than falling back to plain title-and-bullets pages.
- `text-direction`: construct from the interpreted visual DNA without claiming an exact match to an external brand or designer.
- `reference-image`: use the declared palette behavior, canvas, type character, geometry, image treatment, and motifs. Do not copy the image's exact composition or reuse the pixels unless `reference_asset_reuse: allowed`.
- `reference-deck` with `inspiration`: inspect the source deck, then rebuild the relevant design language with supported native objects. Map each output slide to a reference role or visual-DNA trait, not necessarily to an exact source page.
- `reference-deck` with `template-source`: inspect the source with `office_read` and current renders before mutation. When the requested result can be expressed through supported edits, use the authorized PPTX as the source for one separate working copy, preserve its masters/layouts/theme, and fill or adapt identified elements. Do not overlay a parallel default design. If strict template fidelity requires unsupported master/layout or duplication operations, report that boundary rather than silently switching to a vibe-matched rebuild.
- `existing-deck`: follow the source-preserving edit path below.

Before reference-led construction, make the inspection evidence explicit:

- inspiration deck: structurally inspect every source slide, then render enough
  source slides to cover opening, section, data, close, and every recurring
  layout family before locking the extracted visual DNA;
- strict template: structurally inspect and render every source slide before
  mapping each requested output role to an inherited source pattern.

These are required evidence steps, not optional review detail. When execution
is unavailable, state this complete unexecuted coverage in the production
specification instead of shortening it to “inspect the reference”. Do not claim
that either inspection occurred. Keep source-reference renders distinct from
output-deck renders: rendering every new slide does not prove that the source
reference families were visually inspected, and rendering the source does not
replace structural validation plus rendered review of every new output slide.

A strict-template result must contain the exact requested output slide count.
Select, duplicate, or remove source patterns only through supported path-based
operations. Do not keep unused template slides in a requested six-slide result;
if the exact count cannot be produced without unsafe structural mutation, report
that blocker instead of claiming a complete six-slide deck.

When the user explicitly supplies slide titles, labels, or page order, treat
those strings and that order as a verbatim content contract. Do not rename them
to satisfy autonomous assertion-title preferences. Before publication, read the
current output slides and compare every contracted string and position against
the request; repair any omission, substitution, or reordering before handoff.

User instructions and authorized reference/brand material outrank autonomous defaults. Reference fidelity is scoped by `keep`, `adapt`, and `do_not_copy`; it never authorizes copying unsupported claims, third-party logos, proprietary illustrations, or unlicensed assets.

Do not make missing factual copy a construction blocker when the user has
already authorized a draft. Use neutral editable placeholders or visibly
labeled assumptions in the planned slots, keep unsupported claims out of
assertion titles, and continue through the chosen reference-safe route. Ask
only when a source role, destructive change, or strict-fidelity decision is
actually unresolved.

## Scratch new editable deck

Use `create_pptx` as the only initial construction route. Call it exactly once with the complete slide array and `preview:false`; accept the exact path it returns, including a collision-safe rename. Run `office_check` on that exact path before requesting any output render. Only after the structural check succeeds, request every required initial `office_render` call together in one assistant tool-call batch, with `analysis_mode:"quality_review"` on every output-deck render and no model round between pages; the collected image set is the evidence for `ppt-review`. In the first response that receives this image batch, write one concise page-specific evidence sentence before loading `ppt-review` or making any other tool call. That sentence must record the reviewed pages, concrete pass/defect observations, and the next action. Loading review guidance never justifies rendering the same page at the same `artifact_revision` again: use the persisted sentence for unchanged pages, and after an edit rerender only affected pages. The create call's first-slide preview must not start visual review ahead of structural validation. Do not create one slide at a time, issue a second create call for the same deck, or use shell/file tools to copy or rename the result. Source-reference renders used only to understand a visual language keep the default `analysis_mode:"understand"`; defect checking is an explicit output-review operation.

Map every storyboard card to supported native objects:

- `title` and `body` for simple layout-driven pages;
- `shapes` for assertion titles, panels, labels, dividers, diagrams, timelines, processes, and simple data visuals;
- `images` only from sandbox-allowed local paths for photography, illustration, screenshots, or supplied brand assets;
- `charts` for supplied or approved quantitative comparisons, distributions, and ordered series that must remain natively editable;
- `tables` for comparison, schedule, responsibility, metric, or appendix grids;
- `background` and restrained `transition` only when the plan calls for them.

Before the create call, run a construction preflight over the complete slide array. Block only mechanical or presentation-integrity failures: a missing required slide, unsupported remote asset, quantitative encoding that does not map to supplied or approved values, missing primary content, unreadable intended text, or an object expected to exceed the canvas. Scan every visible string: any numeral, percentage, duration, rank, benchmark, or source-claim phrase such as “according to research” must map to supplied or explicitly approved evidence, be visibly labeled as an assumption, or be rewritten as qualitative/editable placeholder copy before the tool call. Treat color count, accent area, layout repetition, cards, gradients, radii, density rhythm, and use of `custom` geometry as design observations, not construction blockers.

On a 16:9 canvas, translate the working alignment logic and practical primary-content safe zones into explicit coordinates. An unbranded `0.60–0.75in` inset is a useful starting range, not a fixed frame; authorized references, intentional media bleed, and optical composition may use different geometry. Establish a few strong alignment lines per slide. Use either placeholders or free-positioned shapes as the primary layout system in a region; do not accidentally stack both there. When both systems are intentional, give them explicit roles and non-conflicting geometry. Do not infer a construction failure from equal strings alone: repeated wording can be intentional, while accidental overlap or redundant visual hierarchy must be decided from the intended role and current render. Reserve placeholders for genuinely simple or template-led pages; designed content pages may use named free-positioned objects.

Build in visual layer order: background, structural regions, media/chart/diagram, primary takeaway, supporting labels, then source/footer. Compose the background as part of the page rather than treating it only as a color token: use a quiet field, structured color region, image-led field, restrained gradient, grid/line language, subtle texture, or another reference/content-led treatment when useful. Keep primary audience-facing text inside a readable zone while allowing intentional image or decorative bleed.

Make the planned visual focus obvious at a glance. A dominant region around 30–55% of the usable canvas is a useful starting range, not a validation threshold. Keep titles concise, preserve a legible hierarchy, and never solve overflow by shrinking all text. Use whitespace, scale, alignment, image crop, and contrast before decoration.

Treat fill opacity as a modifier, not a standalone style. Add `opacity` only
when the same shape has an explicit `fill`, `gradient`, or `pattern`; add
`lineOpacity` only with an explicit `line`. An unfilled text box needs neither
property, and orphan opacity modifiers can invalidate an otherwise complete
Office batch.

Choose, adapt, or bypass layout recipes according to the communication job—hero statement, editorial split, process, comparison, data story, image-led page, close, or a custom composition. Recipes define relationships and content capacity, not fixed templates. Repeating a strong geometry is appropriate for a sequence, comparison, recurring case pattern, or source-template rhythm; vary it only when the story benefits. Equal-weight cards are useful for genuinely parallel information but should not become an accidental universal layout. Treat excessive pills, decorative gradients, ornamental icons, fake dashboards, and arbitrary style changes as warnings that require visual judgment, not automatic rejection rules.

Use raster images for photographic or illustrative content, not for text, labels, tables, diagrams, or the entire slide. Follow each page's asset plan: role, source, aspect ratio, crop, focal point, and treatment. Crop intentionally to support the composition; do not stretch. Preserve attribution, source notes, and useful alternative text. Never pass remote URLs as image paths or claim an image right that was not established. Use image generation only when the available image tool, user authorization, and asset plan allow it. When no suitable asset exists, adapt the layout to a native typographic, chart, table, or diagram composition instead of inserting a decorative placeholder.

Use native charts for supplied or approved numeric data. Choose the chart for the communication job—bar/column for comparison, line/area for an ordered series, scatter for relationship, waterfall for a supplied contribution breakdown—and remove unnecessary chart furniture. Keep categories, units, period labels, data labels, legend, and source legible. Preserve the provided category/series mapping and status labels; never invent a value to make a chart look complete. Use one value-label system: do not place manual value labels over chart-native data labels. A current render with duplicated labels, label-to-point misalignment, or label collisions is a repair defect, not decoration to accept. If a simple labeled-shape diagram communicates better than a chart, use the simpler visual.

The current creation contract supports native text, shapes, pictures, charts, tables, backgrounds, and transitions. It does not establish SmartArt, animation sequences, speaker notes, or master/layout authoring. Disclose those limits instead of flattening or fabricating support.

## Existing or authorized template PPTX

Protect the supplied source:

1. Use `office_read` with `outline`, `query`, or `get` to identify the exact slide and element paths.
2. Translate the authorized change into the smallest `set`, `add`, or `remove` operation batch.
3. Pass the pre-existing source to `edit_office`; set `output_path` in that call when a specific final name is required. Let the tool create the separate validated working copy.
4. Do not guess shape indexes, globally replace text without enumerating affected elements, or rebuild an existing slide as a picture.

Preserve masters, layouts, theme, notes, charts, media, relationships, and transitions unless the user explicitly requests a supported change. If a requested feature is visible but not safely addressable through returned paths and supported operations, leave it intact and report the boundary.

For a template source, distinguish inherited visual furniture from editable content. Prefer identified placeholders and existing component slots. Do not flatten the template, erase all text-bearing objects by heuristic, or place a second visual system over inherited elements. If the source lacks a usable pattern for requested content, either adapt the nearest authorized pattern within supported operations or, when the declared reference strength permits inspiration, create a scratch deck from the extracted visual DNA. Never switch modes silently.

After the template edit, use `office_read` on the output—not only the source—to
verify exact slide count, contracted page order, verbatim user-supplied titles
and labels, and the absence of unused template residue before visual review.

## Repair after creation

If `ppt-review` finds a defect in a deck produced in this conversation, use `office_read` to locate the exact target and `edit_office` to refine the exact returned artifact. Do not restart with `create_pptx`, fork a second draft, or patch OpenXML directly. Each repair batch must correspond to concrete validation or render evidence.

Hand the exact final-candidate path to `ppt-review`; construction is not complete merely because the create or edit tool returned successfully.

## Generated-deck handoff audit

Before publishing a generated deck, prepare exactly one row per slide in page
order. Use this literal shape and these exact status tokens:

`P1 | Content: PASS — evidence | Design: WARNING — evidence | Coherence: PASS — evidence`

Replace the page number, status, and evidence from the current render, but keep
the labels `Content`, `Design`, and `Coherence` and use only `PASS`, `WARNING`,
or `BLOCKER`. Do not substitute unlabeled prose such as “完整、清晰、正常” for
the status fields. Count the rows before `publish_outputs`; every generated page
must appear exactly once, and any `BLOCKER` must be repaired before publication.
