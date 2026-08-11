---
ownerAgent: 814b61b027f0
name: image-design-review
description_zh: 仅在 ImageStudio 已取得当前 inspect 或 snapshot 视觉证据后读取，用于多模态审美复核并绑定精确证据签名；任务启动和路由阶段不要读取。
description_en: Read only after current ImageStudio inspect or snapshot evidence exists; performs signature-bound multimodal review and must not be loaded at task start or during routing.
category: creation
---

# Image Design Review

Read this skill only after a passing `image_studio project.inspect` or `project.snapshot` returns `visual_evidence.attached:true`. Never load it at task start, during routing, or in the same parallel batch as `image-router`. Inspect the attached complete full-color image, not a textual description of it, a media URL, or the generic `read_file` grayscale preview of the same path. Failed deterministic inspection intentionally returns no visual attachment and must be repaired before this review begins.

## Review rubric

Check, in order:

1. Intent: the image communicates the manifest's `one_job` and honors required subject, copy, references, and exclusions. Supplementary creative copy is allowed unless strict fidelity was requested. For strict, exact-only, or no-added-copy requests, treat any visible text outside the user's supplied copy as a blocker.
2. Canvas and references: first read `reference_intent.mode`. For reproduce, compare every preserved attribute; for edit, verify every instruction while checking that protected/unaffected regions remain stable; for guide, ensure references influence only their declared role. Every planned region must remain visible in the intended reading order and no unrequested reference drift may appear.
   Review the exact candidate path returned by the generation/edit handoff. It must byte-for-byte match the planned `output_path`; a missing or retyped path is a blocker, not a candidate to guess.
3. Composition: focal hierarchy, crop, scale, balance, negative space, edge tension, and thumbnail legibility. Read each required headline line by line. An automatic wrap that leaves a one-glyph orphan line is a `fix`; widen the text box, reduce the type size, or use an intentional balanced break before passing. A decorative rule, stroke, or signature device that crosses, crowds, masks, or visually splits required copy is a `fix` (or a `blocker` when the copy becomes unreadable), never a passing flourish.
4. Craft: lighting logic, color relationships, depth, material behavior, typography, alignment, and purposeful detail. Verify that English titles use sentence case or natural title case and body/supporting copy uses sentence case unless exact required copy or an external brand/source explicitly preserves different casing.
5. Generation defects: anatomy, duplicated or fused objects, malformed hands/faces, unreadable pseudo-text, inconsistent perspective, and reference drift.
6. Specificity: the signature device is visible and the result does not collapse into a generic template or undirected model aesthetic.

## Multi-image style consistency

When the user requests multiple images as one set, use the first image that passes design review as the style anchor. For every later image, place a project-local copy of that anchor in `references` as a required reference with `role:"style"`; use `reference_intent.mode:"guide"`, recording `basis:"user"` only when the user explicitly requested the shared style and `basis:"inferred"` otherwise; preserve palette roles, typography roles, spacing/grid rhythm, shape/icon/stroke language, material or lighting treatment, and the signature device; allow only the content and local composition changes needed by that member; and set `reference_intent.minimum_score` to at least 85.

Inspect each later candidate and the style anchor side by side. Use the existing `reference_fidelity` score as the style-consistency score for that comparison. Treat an undeclared change in the preserved style axes as a `fix`, while normal content differences are not drift. Before delivery, inspect all final images side by side once, repair and re-review any visual outlier, and only then report that the set is style-consistent. Separate high individual scores are not evidence of set-level consistency.

Classify findings as:

- `blocker`: wrong subject or promise, missing required copy, unreadable key content, serious artifact, unsafe/misleading content, or an output that cannot serve the requested use.
- `fix`: useful output with a concrete hierarchy, crop, color, typography, continuity, or craft issue that should be repaired before delivery.
- `polish`: optional improvement that does not prevent delivery.

Classify forced English all caps as `fix` when a title, body line, caption, label, or CTA was converted without an explicit casing requirement, or when two or more English text roles use all caps. Restore natural casing and use family, width, weight, scale, color, or spacing for hierarchy. Permit only one short metadata label, acronym, or code when its exact casing comes from required user copy or an external brand/source. Do not pass while native inspection reports `A_ENGLISH_ALL_CAPS_OVERUSE`.

## Submit the verdict

Score the actually viewed evidence from 0 to 100 before choosing the verdict:

- `intent_alignment`: the requested promise and `one_job` are immediately visible.
- `composition`: hierarchy, crop, balance, eye travel, negative space, and thumbnail legibility.
- `craft`: color, lighting, depth, material, typography, alignment, and detail coherence.
- `text_legibility`: required copy is exact, readable, and not model-garbled.
- `defect_freedom`: no material generation, anatomy, duplication, perspective, clipping, or rendering defect.
- `specificity`: the result has its declared signature device and avoids generic template/model defaults.
- `reference_fidelity`: required only when the manifest has references; score the declared reproduce/edit/guide intent, roles, preserved attributes, allowed changes, and edit instructions.

These mandatory dimensions are the comparable baseline, not a closed list. Add an `additional_dimensions` entry for every material task-specific quality axis that the baseline does not already cover, whether it comes from the user's request, the manifest, the medium, the visual system, or a concrete risk visible in the evidence. Examples may include brand coherence, product recognizability, icon-language consistency, data-encoding clarity, or set-level continuity, but the reviewer may define any other applicable axis. Do not add synonyms of the mandatory dimensions or easy dimensions merely to pad the review. Each entry requires a stable lowercase `id`, a user-facing `label`, a concise `reason` why it applies, concrete visible `evidence`, and a 0-100 `score`. Omit the array or send `[]` only when no material uncovered axis exists. Additional scores never raise the mandatory overall, but every one must meet the native dimension floor for a passing verdict.

Call `image_studio` with `project.submit_design_review`, the exact evidence path, `quality_scores` as one object containing every mandatory score named above, any applicable `additional_dimensions`, `passed`, `repair`, or `blocked`, a short review scope, and `findings` as a string array. Native policy calculates the mandatory overall. `passed` requires overall >= 80, every mandatory or additional scored dimension >= 70, `findings:[]`, and reference fidelity at or above `reference_intent.minimum_score` (reproduce >=85; edit >=80); put any optional polish note in the review scope instead of findings. `repair` or `blocked` requires concrete non-empty findings. Do not inflate scores to cross the gate. A review applies only to the returned evidence signature; any source change invalidates it.

Prefer one coherent repair batch. After repair, rerun inspect or snapshot and review the new evidence. Do not approve based on the previous image or on intention alone.
