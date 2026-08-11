---
ownerAgent: 814b61b027f0
name: image-craft
description_zh: 路线锁定后，仅为原创、改风格或视觉方向不明确的图片需求补充具体且反模板化的艺术指导；精确机械编辑或视觉体系已明确时跳过。
description_en: After route lock, turns original, restyled, or underspecified image requests into specific anti-template art direction; skip for precise mechanical edits or already-defined visual systems.
category: creation
---

# Image Craft

Read this skill only after route lock when the task needs original art direction, restyling, or clarification of an underspecified look. Skip it for crop, resize, format conversion, background removal, deterministic placement, or a narrow edit whose visual system is already defined.

## Art-direction pass

Populate all of the following inside the canonical `image-manifest.json` template's `art_direction` object; never place them at the manifest top level:

1. `subject_world`: the concrete subject, setting, era, material culture, and audience expectation.
2. `one_job`: the single thing the image must communicate at thumbnail size.
3. `visual_tradition`: a real visual tradition or production language, not only mood adjectives.
4. `composition`: focal point, camera or viewing angle, scale relationships, negative space, and reading order.
5. `signature_device`: one memorable subject-specific device that prevents a generic template result.
6. `typography`: type role, casing, weight, width, tracking, and copy hierarchy when text is present. Default English titles to sentence case or natural title case and body/supporting copy to sentence case. Preserve all caps only when exact user-approved copy or an external brand/source requires it, and limit it to one short metadata label, acronym, or code. A generic tech, editorial, premium, or cinematic mood never authorizes all caps.
7. `color_light_material`: palette roles, light direction/quality, surface character, and depth treatment.
8. `must_avoid`: visual clichés, unwanted objects, misleading claims, garbled text, and style failures.

Reject vague defaults such as “modern, premium, cinematic” unless each word is translated into visible choices. Prefer one strong thesis over a collage of styles.

For a multi-image set, define this art direction once for the set instead of independently re-expanding the style for every member. Treat the first image that passes design review as the style anchor. Later images may change their subject-specific content and local composition, but must carry forward the anchor's palette roles, typography roles, spacing/grid rhythm, shape and icon language, material treatment, and signature device unless the user explicitly requests a variation.

## Prompt compiler

For generated assets, order the prompt as: subject and action; environment; composition and camera; lighting; palette and material; visual tradition; required continuity; technical crop/aspect constraints; negative constraints. Do not ask the model to render important long-form copy, logos, UI labels, or diagrams; reserve those for the deterministic HTML/SVG layer.

Use a Fooocus-inspired expansion pass without importing its runtime: preserve the user's core request verbatim as the prompt thesis, then expand only visible decisions supported by the brief and `visual_plan`. Separate positive description from `generation_contract.negative_prompt`. Do not add random quality tags, conflicting styles, named-artist mimicry, or details that change the requested subject.

For references, first obey explicit user requirements, then the manifest-level reproduce/edit/guide intent, and only then inferred defaults. Assign a role and strength, state what to preserve, what may change, and which region it controls. Pass the same contract to `generate_image.reference_bindings`. Never request a protected artist imitation; describe observable visual properties and broader traditions instead.
