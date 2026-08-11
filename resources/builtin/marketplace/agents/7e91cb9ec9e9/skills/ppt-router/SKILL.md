---
ownerAgent: 7e91cb9ec9e9
name: ppt-router
description_zh: PptMaker 每次任务首先且单独读取的路由技能；识别新建、编辑、审查或仅策划任务，锁定快速或标准深度，并按阶段指定后续技能。
description_en: The first and only PptMaker skill to read before route lock; classifies create, edit, review, or outline-only work, selects quick or standard depth, and names later skills by phase.
category: office
---

# PPT Router

Read this skill first and alone for every PptMaker request. Lock the route before reading `ppt-planner`, `ppt-craft`, `ppt-review`, or the shared `office-ppt` Skill.

## User-facing progress

The route and depth are private execution metadata. Keep them in working context only; never print the route contract, YAML fields, skill names, tool names, or labels such as `路线锁定`. Never show raw codes such as `CREATE / STANDARD` to the user.

If a progress update is useful, write one short sentence in the current User UI language that describes the real presentation work. Prefer concrete, reassuring copy such as:

- `正在梳理内容结构，确认每一页要表达的重点…`
- `已确定内容结构：8 页，面向企业客户。接下来开始设计页面。`
- `正在制作幻灯片，并统一版式、字体和配色…`
- `正在逐页检查内容和版式，发现问题会直接修正…`
- `PPT 已完成，正在整理交付文件…`

Translate these examples naturally when the User UI language is not Chinese. Use actual task facts instead of repeating the example values. Do not narrate every internal step, repeat near-identical updates, or make the user decode implementation terminology.

## Route

Choose exactly one:

- `CREATE`: the user needs a new editable PPTX from a topic, outline, documents, data, or mixed source material.
- `EDIT`: the user supplied an existing PPTX and wants supported content or layout changes, cleanup, or a bounded redesign.
- `REVIEW`: the user wants inspection, critique, risk findings, template-residue detection, or QA without an authorized file change.
- `OUTLINE`: the requested deliverable stops at a brief, outline, storyboard, or slide plan rather than a PPTX.

For `OUTLINE`, the requested storyboard is itself the plan. For `REVIEW`, the
requested evidence-based review report is itself the result. Answer either one
in the current turn and do not create a separate runtime execution plan; an
unfinished runtime plan can suppress the useful storyboard or report and leave
the user with only a completion status.

Do not route a mixed Word/Excel/PDF package here merely because it contains one deck. Do not treat legacy `.ppt`, WPS `.dps`, Keynote `.key`, a browser slide site, or a PDF as an editable PPTX source. They may inform a new deck or a review, but direct mutation requires a converted `.pptx`.

## Depth

- `QUICK`: use when the user explicitly asks for a fast draft, the deck is small and low risk, or the content and visual direction are already complete. QUICK compresses planning; it does not skip the brief, evidence boundary, storyboard, design lock, validation, or render review.
- `STANDARD`: use for source-heavy work, executive/board/customer/investor/sales/teaching/defense decks, more than six slides, ambiguous narrative, an existing-deck redesign, or any request where weak structure would be expensive.

An explicit review gate is part of the lock. If the user did not request one, do not stop merely to ask approval for an internal outline or visual direction. Continue with recorded assumptions unless one missing decision would materially change the result.

A named reference file plus an explicit role such as “style inspiration”,
“strict template”, “edit this deck”, or “review only” is enough to proceed. Do
not respond with a generic client/product/content questionnaire before
inspecting that input. Missing factual copy may be represented by neutral
headings, visible placeholders, or clearly labeled draft assumptions; it does
not block reference inspection, visual planning, or safe template mapping.

## Visual source

Resolve the visual source without making reference material a prerequisite:

- `autonomous`: no reference image, brand system, template, or visual direction was supplied. This is a complete first-class creation path, not a degraded fallback. Continue without asking the user to provide inspiration, and let `ppt-planner` derive an art direction from the audience, communication job, content, and evidence.
- `text-direction`: the user described a mood, style, brand character, or visual preference without supplying a visual file.
- `reference-image`: one or more supplied images, screenshots, or rendered pages influence the visual language. Do not assume the images may be reused as slide assets unless the user supplied them for that purpose.
- `reference-deck`: a PPTX or rendered deck is inspiration or a template source for a new presentation. Distinguish style inspiration from authorized template reuse before construction.
- `existing-deck`: the supplied PPTX is the artifact to edit or review.

Infer the mode from the request and files. Ask only when confusing a style reference with an editable/template source would materially change the artifact. User instructions and authorized reference/brand material outrank autonomous defaults. A reference never authorizes copying third-party claims, logos, unique illustrations, or proprietary assets.

For reference-led creation, the first concrete action is to inspect the named
reference within its declared role. Continue from that evidence into planning
and production without asking whether the user wants you to begin. If the
current transport cannot execute file operations, provide the complete
unexecuted inspection, visual-extraction, construction, and review sequence in
plain presentation language in the same reply; do not expose private tool or
skill names.

## Internal lock

Record this compact route contract in working context before any later skill read. Do not include it in a user-facing message:

```yaml
route: CREATE|EDIT|REVIEW|OUTLINE
depth: QUICK|STANDARD
primary_deliverable: editable-pptx|review-report|outline|storyboard
source_role: none|content|data|visual-reference|editable-source|mixed
visual_source: autonomous|text-direction|reference-image|reference-deck|existing-deck
reference_mode: none|inspiration|brand-source|template-source|editable-source
reference_strength: loose|balanced|strict
reference_asset_reuse: allowed|reference-only|unknown
review_gate: none|outline|storyboard
known_constraints: []
assumptions: []
blocking_unknowns: []
next_skills: []
```

Populate `next_skills` progressively:

- `CREATE`: `ppt-planner`, then `ppt-craft`, then `ppt-review` only after validation/render evidence. When a PPTX is a visual or template source, read the shared `office-ppt` Skill and inspect that deck before `ppt-planner` locks its visual interpretation.
- `EDIT`: shared `office-ppt`, then `ppt-craft`, then `ppt-review` only after validation/render evidence.
- `REVIEW`: shared `office-ppt`, then `ppt-review` after validation/render evidence; omit craft unless the user later authorizes repair.
- `OUTLINE`: `ppt-planner` only.

`next_skills` is execution order, not permission to preload them in one batch.
