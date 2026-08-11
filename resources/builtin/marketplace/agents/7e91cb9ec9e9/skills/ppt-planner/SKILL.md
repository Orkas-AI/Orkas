---
ownerAgent: 7e91cb9ec9e9
name: ppt-planner
description_zh: 为新建 PPT 或策划稿建立简报、证据边界、叙事大纲、逐页 storyboard、版式语法和可执行视觉锁，确保页面从第一次生成起就具备清晰层级和稳定审美。
description_en: Build the brief, evidence boundary, narrative outline, per-slide storyboard, layout grammar, and executable visual lock so the first generated deck already has clear hierarchy and coherent aesthetics.
category: office
---

# PPT Planner

Read only after `ppt-router` chooses `CREATE` or `OUTLINE`. Planning is the source of truth for construction, not optional prose around the deck.

## 1. Presentation brief

Lock these fields from the request and inspected materials:

- audience and decision, learning, sales, or communication job;
- desired audience action or takeaway;
- language, slide-count range, tone, and content density;
- source boundary: supplied-only, supplied-plus-current-research, or clearly labeled draft assumptions;
- must-include, must-avoid, confidentiality, brand, and template/reference constraints;
- delivery format and aspect ratio; default to editable `.pptx` and 16:9 when unspecified.

When the user explicitly supplies slide titles, labels, or an ordered page
list, record those visible strings and their order as a verbatim content
contract. Do not improve, synonymize, shorten, or replace them with autonomous
assertion titles. Assertion-title guidance applies only where the user did not
fix the visible wording.

Ask only when a missing answer would change the deck's purpose, evidence boundary, or deliverable. Otherwise choose a sensible default and record it.

## 2. Visual source and references

Resolve one visual source before choosing an art direction:

- `autonomous`: no visual reference exists. This is a normal, complete path. Do not ask the user to find a reference and do not reduce the deck to a generic title-and-bullets template. Derive a suitable visual character from the audience, communication job, subject matter, tone, and available evidence.
- `text-direction`: translate the user's words into a usable visual system without inventing a named brand or claiming an exact external style match.
- `reference-image`: inspect every supplied reference image and extract only the relevant visual signals: palette hierarchy, canvas/background treatment, typography character, grid and alignment, whitespace, dominant-object scale, image crop/focal point, surface treatment, and recurring motifs. Record uncertain inferences as low confidence. A reference image is not a reusable slide asset unless the user supplied or authorized it for reuse.
- `reference-deck`: decide whether the PPTX is `inspiration` or an authorized `template-source`. Inspect all source slides structurally. For strict template following, also render and inspect every source slide before mapping output roles to reusable source patterns; for inspiration, render enough slides to cover every recurring layout family and the opening/section/data/close roles. Extract theme colors, font evidence, margins, alignment lines, background language, image treatment, chart/table treatment, recurring furniture, and slide-role patterns.
- `existing-deck`: preserve its current visual system unless the user authorizes a bounded redesign.

Reference material is production input, not a routine clarification trigger.
When its role is explicit, inspect it before requesting optional business copy.
If the deck topic, customer facts, product proof, or quarterly values are still
missing, complete the structure with neutral titles and visibly labeled
placeholders or assumptions. Do not end with “send these details and I will
start”; the reference interpretation, story skeleton, visual system, and
production route can all be completed safely first.

If tools are unavailable, distinguish observed evidence from planned evidence:
never claim that a reference was inspected, but still return a self-contained
unexecuted specification naming what will be inspected, which visual-DNA fields
will be extracted, how each output page will adapt them, how the source remains
unchanged, and what structural and rendered evidence will be reviewed. Use
plain presentation language rather than private tool names.

Do not fill an uninspected reference-image record with a plausible palette or
named art direction based on the deck topic. Mark palette, typography,
background, geometry, crop/focal behavior, and motifs as pending reference
inspection. If a construction-ready fallback is useful, label it explicitly as
a provisional autonomous fallback, not as evidence extracted from the image.

Record this compact interpretation:

```yaml
visual_source: autonomous|text-direction|reference-image|reference-deck|existing-deck
reference_mode: none|inspiration|brand-source|template-source|editable-source
reference_strength: loose|balanced|strict
reference_asset_reuse: allowed|reference-only|unknown
visual_dna:
  character: "visual personality appropriate to the communication job"
  palette_behavior: "dominant, support, accent, and semantic-color behavior"
  canvas: "background composition and whitespace behavior"
  typography: "hierarchy and typographic character; exact family only when evidenced"
  geometry: "grid, alignment, scale, and spacing tendencies"
  imagery: "subject, crop, focal point, ratio, and treatment"
  motifs: []
  avoid: []
confidence: high|medium|low
```

References control only their declared role. Record `keep`, `adapt`, and `do_not_copy`. Do not copy third-party logos, unique illustrations, proprietary claims, or exact layouts without authorization. User instructions and authorized brand/reference material override autonomous defaults; narrative clarity and source fidelity still take precedence over irrelevant reference structure.

A known authoring limitation does not require pretending that source inspection
already occurred. When the user requires an unsupported feature with exact
fidelity, state the limitation and preserve the source immediately. Inspect or
render the source only when that evidence can identify a supported preservation
path or user-selectable alternative; do not perform ceremonial inspection merely
to restate a capability boundary that is already known.

## 3. Content boundary

Inspect supplied material before outlining and separate user-provided content,
explicit draft assumptions, and missing copy. Preserve the visible meaning of
supplied wording, figures, labels, units, dates, page order, and status labels.
PptMaker does not independently verify business truth or infer missing domain
definitions unless the user explicitly asks for research or analysis.

Do not invent source facts merely to complete a layout. Use a neutral editable
placeholder, a question, or visibly labeled draft copy when a requested slide
role lacks content. Keep source labels where the user supplied them or where
they are needed to distinguish supplied material from draft presentation copy.
An assertion-style title must summarize the content shown on that slide rather
than introduce an unsupported claim or contradict the body.

## 4. Narrative outline

Build one argument, not a list of topics. Select a structure that fits the presentation job, such as situation-complication-resolution, problem-evidence-choice, before-after-bridge, lesson-concept-example-practice, or context-progress-risk-decision.

Convert every user-specified content role into a coverage checklist before
outlining, then map each role to at least one slide. Do not silently replace a
requested use-case page with capability pages, a requested risk page with a
generic problem page, or another named role with a nearby topic. Run the
coverage checklist again before returning the storyboard.

For a product-introduction use-case page, include at least three concrete
actor–task–result examples (for example, who supplies what input, what the
assistant does, and what editable or reviewable result is produced). Category
labels such as “documents, meetings, and knowledge” alone are not use cases.

For an enterprise product-introduction deck, reserve a distinct slide for
customer value and expected outcomes. Keep its outcomes qualitative or visibly
labeled as hypotheses when proof is missing, and state what pilot evidence or
measurement would validate them. Do not bury customer value inside a capability,
security, implementation, or closing page merely to satisfy the word “value”.

Each slide gets one primary takeaway. Prefer assertion-style titles that state the conclusion, except for covers, section dividers, agendas, neutral reference pages, and titles whose visible wording the user fixed verbatim. The sequence must explain why each slide follows the previous one and what question it answers.

Do not add a filler slide merely to reach the requested count. An overview,
bridge, decision, or close is useful only when it has a distinct audience job;
do not repeat the previous target, chart, or action list under a new title. If
the source content is sparse, use a purposeful navigation, synthesis, or next-
step role with visibly bounded content instead of duplicating another page.

## 5. Slide storyboard

Create one card per slide:

```yaml
slide: 1
role: cover|agenda|context|argument|evidence|comparison|process|decision|appendix
takeaway: "one sentence"
evidence: ["source or assumption label"]
pattern: cover|hero-statement|editorial-split|timeline|process|comparison|data-story|image-led|quote|close
layout_mode: recipe|adapted|custom
visual_focus: "the single dominant object or contrast the audience notices first"
visual_encoding: "native shapes, editable chart, styled table, diagram, or local image"
background_intent: "plain canvas, structured field, image-led field, texture, or another purposeful treatment"
reference_anchor: "reference page/image/design-DNA trait or autonomous"
asset_plan: "hero/evidence/context/decorative role, source, ratio, crop, and focal point; or none"
content_budget: "title, body word count, item count, and source-note allowance"
continuity: "link from previous and to next slide"
```

Every content slide needs one semantic visual focus. A visual focus explains, compares, proves, or sequences the takeaway; it is not decoration. Use an editable native chart for supplied or approved quantitative comparison or trend data, with the relevant labels, unit, and source visible. Do not prescribe SmartArt, animations, master edits, or speaker notes.

## 6. Adaptive design lock

Choose one coherent art direction that fits the audience and message. When the user supplies no brand, reference, or style, choose the best-fit direction autonomously and continue; a missing visual reference is not a blocker and does not require a preference question. Supported starting directions include, but are not limited to:

- `Swiss editorial`: strict grid, strong type hierarchy, restrained color, high whitespace;
- `editorial analysis`: oversized assertion, annotated evidence, asymmetric split, quiet surfaces;
- `product showcase`: dark or light product stage, cropped UI/photo, benefit-led callouts;
- `data journalism`: annotated native charts, source-forward labels, minimal chart furniture;
- `photo-led`: one strong licensed/supplied image with disciplined text overlay or split;
- `technical blueprint`: modular diagrams, connectors, numbered steps, precise labels.

These are starting points, not a closed style menu. Do not force every unbranded enterprise deck into `Swiss product editorial` or a fixed blue palette. A product launch, investor narrative, teaching deck, technical proposal, cultural topic, or image-led story may require a different autonomous direction.

Lock only the decisions needed to construct a coherent first draft; keep aesthetic values adaptable:

- canvas and aspect ratio (`13.333in × 7.5in` for default 16:9), plus practical safe zones for primary content rather than a universal decorative boundary;
- working alignment logic: a grid, asymmetric split, optical alignment, or reference-derived geometry with named anchors;
- an exact working palette for construction, derived from authorized references when present or selected autonomously when absent. Color count, accent area, and background variation are guidance, not publication gates;
- target-safe fonts and working size anchors appropriate to the reference and audience. Suggested unbranded ranges are cover `32–44pt`, slide title `26–32pt`, body `17–20pt`, label `11–14pt`, and source `9–10pt`, but reference fidelity, language, and rendered legibility decide the actual values;
- a canvas language covering purposeful background treatments such as quiet fields, structured color regions, image-led fields, restrained gradients, grids/lines, or subtle texture;
- component and media behavior for whitespace, line/border treatment, connectors, charts, image ratios, crop, focal point, and source labels;
- enough purposeful layout variation for the narrative. There is no numeric layout-family minimum, and repeated geometry is acceptable when it strengthens a sequence, comparison, or reference-template rhythm;
- explicit anti-patterns relevant to this deck, such as unreadably small primary text, accidental UI-card walls, unlicensed imagery, fake screenshots, or style drift.

Treat contrast ratios, color-count heuristics, density rhythm, layout repetition, accent proportions, cards, gradients, radii, and whitespace targets as diagnostic guidance. They may trigger an adaptation or warning, but must not override the user's authorized reference, brand system, or a deliberate content-led composition. Primary audience-facing text must still be readable in the final render.

For each page, choose a layout recipe, adapt one, or use `custom`. Recipes describe useful relationships and content capacity, not mandatory templates. A custom page is valid when its hierarchy, asset availability, and primary reading order are explicit.

## 7. Build-readiness gate

Do not hand a new deck to construction until all are true:

- every slide has a takeaway, visual intent, evidence label, bounded content budget, background intent, and an asset plan or an explicit no-asset composition;
- the visual source is resolved, including an autonomous visual DNA when no reference exists;
- one usable art direction, exact working palette, typography hierarchy, canvas/alignment logic, and image/chart treatment are available for construction;
- reference roles, reuse permission, confidence, and `keep` / `adapt` / `do_not_copy` boundaries are explicit when references exist;
- every quantitative visual maps to supplied or approved values, labels, units, categories, and a source;
- no page depends on an unsupported feature or a remote image path.

Do not reject a build merely because it uses an unusual color count, repeats a successful layout, chooses a custom composition, or lacks an external visual reference. Those are design-review observations, not construction blockers.

## 8. Planning-only visible output contract

When the requested deliverable stops at an outline, storyboard, or production
plan, make the locked decisions visible instead of returning only topical slide
titles. The response must be usable by a different slide builder without
guessing. Use ordinary presentation language and include:

1. one short opening sentence that says what is being organized now and what
   the next production step would be;
2. the audience, decision/action, evidence boundary, and total slide count as
   explicit values;
3. a `视觉方案` block with `自主设计 / 文字方向 / 参考图 / 参考 PPT` as the
   visual source, the named art direction and reasoning, visual-DNA summary,
   exact working palette, point-size anchors, canvas/alignment logic,
   background language, crop/chart treatment, and reference reuse boundary;
4. a numbered card for every slide containing its takeaway, semantic visual
   focus, layout mode, background intent, asset plan, reference anchor,
   evidence label, and content budget;
5. a final deck-rhythm line explaining how repeated and varied silhouettes
   support the story. Do not invent a numeric layout-family quota, density
   sequence, or repetition ceiling merely to satisfy the plan format.

Density labels such as `信息较少 / 信息适中 / 信息较多` are optional planning aids.
Use them only when they help explain pacing; their presence, alternation, or
count is not a quality gate.

Also show a one-line must-include coverage check. If a requested slide lacks
content, use a visible neutral placeholder or explicitly labeled draft copy
rather than relying only on a preamble or footer disclaimer.

For a data presentation, add a compact `信息与图表映射` block. Copy every supplied
value, label, unit, period, and category that will be visible; keep user-provided
status labels such as actual, target, forecast, sample, or placeholder visually
distinct; and name the native editable chart or other visual form for each data
group. Specify category/series mapping, label placement, annotation behavior,
unit, source note, and a zero baseline for bar or column comparison unless the
page explicitly explains another choice. Write the bar/column baseline decision
explicitly in the visible plan rather than treating it as an implied chart
default. Do not make the audience reconstruct these mappings from slide notes.

PptMaker may format user-provided conclusions and calculations, but it should
not invent a new derived metric or business conclusion merely to fill a page.
When the requested presentation needs content that was not supplied, reserve a
clearly labeled editable placeholder or describe the missing content input. This
is a presentation-fidelity boundary, not an instruction to audit the external
truth or business reasonableness of the source material.

Give each slide a distinct communication job. Do not spend adjacent pages
restating the same information with a second decorative chart; combine closely
related annotations or use the next page for a different comparison, action,
or decision role.

Before returning a planning-only answer, perform a text-level completeness
check against these visible fields. Do not expose private route/depth codes,
skill names, tool names, or YAML workflow metadata while doing so.
The storyboard is already the execution plan for an `OUTLINE` request; do not
create or update a separate runtime execution plan. Return the complete visible
storyboard directly in this turn.

## Planning handoff

For QUICK work, return a compact brief, outline, storyboard, and design lock in the working context. For STANDARD decks with more than eight slides, multiple sources, or likely context continuation, also save a compact `ppt-plan.md` in the workspace so later repair can recover the approved direction.

If the route is `OUTLINE`, stop with the requested planning layer. If the route is `CREATE`, hand the locked plan to `ppt-craft` without silently changing its audience, evidence boundary, takeaways, or visual system.
