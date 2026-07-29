---
ownerAgent: 814b61b027f0
name: image-design-review
description_zh: 仅在 ImageStudio 已取得当前 inspect 或 snapshot 视觉证据后读取，用于多模态审美复核并绑定精确证据签名；任务启动和路由阶段不要读取。
description_en: Read only after current ImageStudio inspect or snapshot evidence exists; performs signature-bound multimodal review and must not be loaded at task start or during routing.
category: creation
---

# Image Design Review

Read this skill only after `image_studio project.inspect` or `project.snapshot` returns current visual evidence. Never load it at task start, during routing, or in the same parallel batch as `image-router`. Inspect the complete image, not a textual description of it.

## Review rubric

Check, in order:

1. Intent: the image communicates the manifest's `one_job` and honors required subject, copy, references, and exclusions.
2. Canvas and references: first read `reference_intent.mode`. For reproduce, compare every preserved attribute; for edit, verify every instruction while checking that protected/unaffected regions remain stable; for guide, ensure references influence only their declared role. Every planned region must remain visible in the intended reading order and no unrequested reference drift may appear.
   Review the exact candidate path returned by the generation/edit handoff. It must byte-for-byte match the planned `output_path`; a missing or retyped path is a blocker, not a candidate to guess.
3. Composition: focal hierarchy, crop, scale, balance, negative space, edge tension, and thumbnail legibility.
4. Craft: lighting logic, color relationships, depth, material behavior, typography, alignment, and purposeful detail. Verify that English titles use sentence case or natural title case and body/supporting copy uses sentence case unless exact required copy or an external brand/source explicitly preserves different casing.
5. Generation defects: anatomy, duplicated or fused objects, malformed hands/faces, unreadable pseudo-text, inconsistent perspective, and reference drift.
6. Specificity: the signature device is visible and the result does not collapse into a generic template or undirected model aesthetic.

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

Call `image_studio` with `project.submit_design_review`, the exact evidence path, `quality_scores` as one object containing every score named above, `passed`, `repair`, or `blocked`, a short review scope, and `findings` as a string array. Native policy calculates the overall score. `passed` requires overall >= 80, every scored dimension >= 70, `findings:[]`, and reference fidelity at or above `reference_intent.minimum_score` (reproduce >=85; edit >=80); put any optional polish note in the review scope instead of findings. `repair` or `blocked` requires concrete non-empty findings. Do not inflate scores to cross the gate. A review applies only to the returned evidence signature; any source change invalidates it.

Prefer one coherent repair batch. After repair, rerun inspect or snapshot and review the new evidence. Do not approve based on the previous image or on intention alone.
