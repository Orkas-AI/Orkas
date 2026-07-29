---
ownerAgent: 814b61b027f0
name: image-canvas
description_zh: 路线锁定后，仅为多区域画面、明确阅读顺序、精确布局或区域绑定参考图建立共享画布契约；简单单区域图片跳过。
description_en: After route lock, creates a shared canvas contract only for multi-region images, explicit reading order, exact layout, or region-bound references; skip simple single-region images.
category: creation
---

# Image Canvas

Read this private ImageStudio skill only after route lock when the result has multiple meaningful visual regions, an explicit reading order, exact layout constraints, or references bound to regions. Skip it for a simple single-region image. If art direction is also needed, read `image-craft` first. This adapts the Canvas-as-intermediate-representation method popularized by Omost into Orkas's provider-neutral manifest; it does not import an Omost model runtime.

## Canvas contract

Add `visual_plan` when the image has more than one meaningful visual zone:

- `global_description`: the complete visual thesis in one concrete sentence.
- `reading_order`: every region id in intended eye-travel order.
- `regions`: stable ids with normalized `x`, `y`, `width`, and `height`; `background`, `midground`, or `foreground` depth; exactly one supported role (`hero`, `support`, `copy`, `decoration`, or `background`); a visible description; `detail_prompts` as a string array; and `reference_ids` as a string array. Use empty arrays when a region has no detail prompts or references.

Use as few regions as possible. Regions describe visible image logic, not implementation components. Reserve meaningful negative space deliberately and prevent hero, copy, and support regions from competing for the same focal priority.

For `COMPOSE` and `HYBRID`, map every region to at least one HTML/SVG element with `data-image-region="<id>"`. ImageStudio blocks snapshots when the plan and DOM diverge. For `GENERATE` and `EDIT`, compile the global description and region details into the provider prompt, preserving the same reading order and crop.

## Reference contract

Before declaring individual references, write `reference_intent:{mode:"reproduce|edit|guide",basis:"user|inferred",instructions:[],minimum_score}`. Explicit user constraints always win; only an unspecified reference defaults to guide with inferred basis. Then declare each project-local reference with a stable id, one role (`style`, `identity`, `composition`, `structure`, `content`, `mask`, or `edit_source`), influence strength from 0 to 1, required state, attributes to preserve, attributes that may change, and target region ids. Reproduce uses a floor of at least 85; edit uses at least 80 and a required edit source with explicit instructions and non-empty change boundaries.

Treat role as a constraint, not a vague inspiration label. A style reference must not silently become an identity reference; a composition reference must not copy unrelated content. Required reference files participate in the project signature, so changing them invalidates previous review evidence.

For provider controls, use `generation_contract.controls` with an existing reference id, control type (`image_prompt`, `canny`, `depth`, `pose`, or `mask`), strength, and start/end window. This records IP-Adapter/ControlNet-style intent without coupling the project to one provider.
