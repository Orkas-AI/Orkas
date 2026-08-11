---
ownerAgent: 814b61b027f0
name: image-router
description_zh: ImageStudio 每次任务首先且单独读取的路由技能；按用户意图、画面类型和成本选择 COMPOSE、HYBRID、GENERATE 或 EDIT，再决定后续需要读取的技能。
description_en: The first and only ImageStudio skill to read before route lock; selects COMPOSE, HYBRID, GENERATE, or EDIT from intent, visual requirements, and cost, then identifies the next skill to load.
category: creation
---

# Image Router

Read this skill first and alone for every image creation or revision request. Return a locked route before reading any other ImageStudio skill; do not batch this read with craft, canvas, production, or review skills.

Before routing any request with a supplied image, classify the user's relationship to that image. An explicit user requirement always wins. Only when the user did not specify the relationship may ImageStudio infer a default:

- `reproduce`: make the result match the declared composition/content/style attributes of the reference.
- `edit`: treat one required `edit_source` as the original and change only the requested attributes or regions.
- `guide`: use only the declared roles as guidance while allowing the stated changes. This is the safe default for an otherwise unspecified reference.

Record this as `reference_intent:{mode,basis:"user|inferred",instructions,minimum_score}`. Use `basis:"user"` when the mode or constraint comes from the user's words and `basis:"inferred"` only for a fallback. A requested source edit implies edit; an explicit match/recreate/restore request implies reproduce; an otherwise unspecified reference defaults to guide. If instructions combine editing with strong preservation, keep mode edit and place the user's exact preservation requirements in the protected boundary. The intent is about the requested outcome, never about which app or technique produced the reference.

## Route selection

- Choose `COMPOSE` when typography, diagrams, charts, abstract geometry, cards, covers, posters, social graphics, simple illustrations, or brand layouts can be expressed faithfully with HTML/CSS/SVG. This route uses zero image-generation calls.
- Choose `HYBRID` when one photographic, painterly, character, or textured raster asset is needed but exact copy, layout, logo placement, or labels should remain deterministic in HTML/SVG. The normal budget is one generated raster asset per user turn.
- Choose `GENERATE` when the desired output is primarily photographic, cinematic, painterly, character-led, or otherwise depends on synthesized pixels. The normal budget per user turn is one initial call and at most one repair call after evidence-based review.
- Choose `EDIT` when the user supplied a raster image and requested a semantic pixel change that HTML overlays cannot accomplish. The manifest must use `reference_intent.mode:"edit"`, name a required `edit_source`, list the exact instructions, and preserve every unaffected region.
- Distinguish `HYBRID` from `EDIT` by the final artifact contract, not merely by the presence of a supplied photo. A poster or layout that keeps a supplied product/subject image as an immutable foreground layer, generates a separate background asset, and places exact copy/logo deterministically is `HYBRID`. Use `EDIT` only when the final raster remains the supplied source canvas and pixels inside that source must be semantically reconstructed, such as replacing a portrait background in place.
- A `reproduce` request does not force `EDIT`: choose COMPOSE, HYBRID, or GENERATE according to the visual material required to reproduce the declared attributes.

Route using call count and capability, not a remembered provider price. Once a generated route and exact request exist, `image-generate` checks the configured BYO/local provider with `image_studio generation.quote`; the router must not hard-code or locally calculate prices. External providers and host workflows are reported as externally billed and not estimated in-app.

## Lock output

Lock the route in the routing handoff, but do not create or edit project files during routing. `image-manifest.json` is written only after the selected production skill (`image-compose` or `image-generate`) has been read and the routed planning skills have supplied their values. It uses numeric `schema_version:1`. For every reference, lock whether it controls style, identity, composition, structure, content, mask, or edit source; record what must remain and what may change. User-declared instructions, roles, regions, preserve, and may-change items override inferred defaults. Reproduction requires `minimum_score >= 85`. Editing requires `minimum_score >= 80`, at least one instruction, and non-empty non-overlapping preserve/may-change boundaries on the required edit source. Do not switch routes after authoring begins unless the user changes the deliverable or the current route is technically incapable of satisfying it.

Supplementary creative copy is allowed when the user did not request strict fidelity; keep it editable and do not present it as user-supplied fact. When the user asks for strict, exact-only, or no-added-copy output, `brief.required_copy` is the complete visible-copy allowlist: do not add subtitles, quantities, credentials, promises, or CTAs.

## Canonical image-manifest v1

This is the single structural template for `image-manifest.json`. Production skills must copy its nesting and value types instead of reconstructing the schema from memory. Replace every example value with the current brief, route, and budget; the host applies `generation_budget.max_calls` independently to each user turn and keeps prior-turn transactions only for audit. Omit optional `visual_plan` only when `image-canvas` was not selected. Route-specific reference and generation fields extend this template without changing its existing nesting.

```json
{
  "schema_version": 1,
  "route": "compose",
  "canvas": { "width": 1080, "height": 1350 },
  "brief": {
    "purpose": "What this image is for",
    "audience": "Who should respond to it",
    "required_copy": ["Exact visible copy"],
    "must_include": ["Required visual or fact"],
    "must_avoid": ["Concrete visual failure"]
  },
  "art_direction": {
    "subject_world": "Specific subject world",
    "one_job": "The single communication job",
    "visual_tradition": "Named visual tradition",
    "composition": "Concrete hierarchy and placement",
    "signature_device": "Distinctive geometry or material device",
    "typography": "Typeface roles and casing",
    "color_light_material": "Palette, light, and material"
  },
  "visual_plan": {
    "global_description": "One concrete sentence describing the complete visual thesis",
    "reading_order": ["hero", "details"],
    "regions": [
      {
        "id": "hero",
        "bounds": { "x": 0, "y": 0, "width": 1, "height": 0.65 },
        "depth": "foreground",
        "role": "hero",
        "description": "Primary focal region",
        "detail_prompts": [],
        "reference_ids": []
      },
      {
        "id": "details",
        "bounds": { "x": 0, "y": 0.65, "width": 1, "height": 0.35 },
        "depth": "midground",
        "role": "support",
        "description": "Supporting information region",
        "detail_prompts": [],
        "reference_ids": []
      }
    ]
  },
  "generation_budget": { "max_calls": 0 }
}
```

## Progressive-disclosure handoff

Return `route`, `reason`, `generation_budget`, and a phased `next_skills` list:

- Add `image-craft` only for original creation, restyling, or an underspecified visual direction.
- Add `image-canvas` only for multiple meaningful regions, explicit reading order, exact layout constraints, or region-bound references.
- Add `image-compose` for `COMPOSE`, or later in another route only for a deterministic overlay, layout, diagram, crop, mask, or composite.
- Add `image-generate` for `GENERATE`, semantic `EDIT`, or the synthesized raster phase of `HYBRID`.
- Never add `image-design-review` to startup. Load it only after current inspect or snapshot evidence exists.

When more than one skill is required, `next_skills` expresses execution order, not a parallel preload request. Read each skill only when its phase begins.

For `COMPOSE` and `HYBRID`, use private `image-compose` scripts for evolving authoring/asset capabilities and reserve native `image_studio` for inspect, capture, review, and export. For `GENERATE` and `EDIT`, use `generate_image` by default; choose a host-configured ComfyUI, InvokeAI, AUTOMATIC1111, or IOPaint workflow only after `workflow.capabilities` proves it executable and the project-local request provides a specific model/control advantage. Both paths use the same manifest budget, then converge on `image_studio` inspect, scored review, and export.
