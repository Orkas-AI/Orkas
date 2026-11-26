---
ownerAgent: 814b61b027f0
name: image-router
description_zh: ImageStudio 每次任务首先且单独读取的路由技能；按用户意图、画面类型和成本选择 COMPOSE、HYBRID、GENERATE 或 EDIT，再决定后续需要读取的技能。
description_en: The first and only ImageStudio skill to read before route lock; selects COMPOSE, HYBRID, GENERATE, or EDIT from intent, visual requirements, and cost, then identifies the next skill to load.
---

# Image Router

Read this skill first and alone for each applicable turn. Return a locked route before reading any other ImageStudio skill; do not batch this read with craft, canvas, production, or review skills.

For a clear zero-input poster or social graphic, routine canvas and export choices are low-risk defaults: choose them without asking and state the chosen defaults in the delivery. Ask only when a missing choice changes subject, required copy, brand fidelity, reference intent, paid budget, or final format.

For a localized copy revision on a flat image, interpret requests to keep the title size, position and text area as visible geometry. If the area can be isolated, load `image-compose` and proceed using the available reference. Clarify only if a source font or exact source typography settings are explicitly required and cannot be verified, or if the change area cannot be isolated safely.

When asked only for a recovery plan for an existing candidate, give the concrete repair and its full planned sequence through fresh evidence, design review of that evidence, and export only after the review passes. Treat the tool's suggested next operation as the starting step of the plan.

Before routing any request with a supplied image, classify the user's relationship to that image. An explicit user requirement always wins. Only when the user did not specify the relationship may ImageStudio infer a default:

- `reproduce`: make the result match the declared composition/content/style attributes of the reference.
- `edit`: treat one required `edit_source` as the original and change only the requested attributes or regions.
- `guide`: use only the declared roles as guidance while allowing the stated changes. This is the safe default for an otherwise unspecified reference.

Record this as `reference_intent:{mode,basis:"user|inferred",instructions,minimum_score}`. Use `basis:"user"` when the mode or constraint comes from the user's words and `basis:"inferred"` only for a fallback. Inspect the supplied images before production and translate the request into each reference's roles, preserved attributes, allowed changes, and regions. Reproduction needs at least one reference and concrete preserved attributes. An explicit match/recreate/restore request takes precedence: use reproduce even when the user allows a limited edit, and record only those allowed edits in may_change. Otherwise, a requested source edit implies edit; an otherwise unspecified reference defaults to guide. For edit mode, place the user's exact preservation requirements in the protected boundary. The intent is about the requested outcome, never about which app or technique produced the reference.

## Product creative before route lock

For product listing or sales creative, resolve the requested picture before applying the generic routes below. New product scenes, creative campaign images and hero images needing a new photographic treatment default to `GENERATE` or `HYBRID`; a semantic change to the supplied source canvas uses `EDIT`. Do not choose `COMPOSE` merely because a product photograph and headline can be arranged in HTML: a layout is not a substitute for the requested scene or photographic treatment.

Explicit user constraints take precedence. Specification/comparison graphics, requested graphic layouts, ordinary white-background processing, crop/resize work, exact reproduction and scoped edits keep their appropriate existing routes. When product appearance must remain exact, prefer the real product pixels with separately generated surroundings and deterministic copy. Resolve visual need before comparing costs; the existing quote, authority and call-budget rules still apply.

## Route selection

- For a vector PDF follow-up, locate the retained SVG or HTML source, then load `image-compose` for native export. Reuse its existing project and any still-valid review, or choose `COMPOSE` for a standalone source.
- Choose `COMPOSE` when typography, diagrams, charts, abstract geometry, cards, covers, posters, social graphics, simple illustrations, or brand layouts can be expressed faithfully with HTML/CSS/SVG. This route uses zero image-generation calls.
- Choose `HYBRID` when one photographic, painterly, character, or textured raster asset is needed but exact copy, layout, logo placement, or labels should remain deterministic in HTML/SVG. The normal budget is one generated raster asset per user turn.
- Choose `GENERATE` when the desired output is primarily photographic, cinematic, painterly, character-led, or otherwise depends on synthesized pixels. The normal budget per user turn is one call. Allow a second billable call only when the user explicitly requests iterative refinement or authorizes another attempt; a visual finding by itself is not authorization.
- Choose `EDIT` for `edit` intent when the supplied image is the canvas being changed. Use zero generation calls for deterministic edits, or the approved budget for semantic model edits. The manifest must use `reference_intent.mode:"edit"`, name a required `edit_source`, list the exact instructions, and preserve every unaffected region.
- A composition that keeps a supplied product or subject as an immutable foreground layer, generates a separate background asset, and places exact copy or logo deterministically is `HYBRID`.
- For `reproduce` intent with deterministic local production, choose `COMPOSE` even when reusing the source canvas. Choose `HYBRID` or `GENERATE` when the required visual material calls for synthesis.

Route using call count and capability, not a remembered provider price. Once a generated route and exact request exist, `image-generate` checks the configured BYO/local provider with `image_studio generation.quote`; the router must not hard-code or locally calculate prices. External image providers are reported as externally billed and not estimated in-app.

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

For a supplied reference, add these top-level fields and replace the example values with the locked intent and reference boundaries. Keep `instructions` as an array even for a single instruction.

```json
{
  "reference_intent": {
    "mode": "reproduce",
    "basis": "user",
    "instructions": ["Match the poster and replace only its event name"],
    "minimum_score": 85
  },
  "references": [{
    "id": "source",
    "path": "assets/source.png",
    "role": "edit_source",
    "strength": 1,
    "required": true,
    "preserve": ["Composition, typography, palette and spacing"],
    "may_change": ["Event name text"],
    "region_ids": []
  }]
}
```

## Progressive-disclosure handoff

After route lock, for product listing or sales-creative work, also read [image-craft/references/ecommerce.md](@skill/image-craft/references/ecommerce.md).

After route lock, before a non-generation multi-image set's production or acceptance plan, read [multi-image-sets.md](@skill/image-compose/references/multi-image-sets.md). Keep a planning-only task read-only.

Return `route`, `reference_intent` for supplied references, `reason`, `generation_budget`, and a phased `next_skills` list. Carry the declared reference intent and its preservation and change boundaries into the manifest and review.

For an original-size deliverable, use the file's `source_dimensions` to set the canvas. Use `preview_dimensions` for interpreting the scaled preview and map positions back to source pixels before authoring.

- Add `image-craft` only for original creation, restyling, or an underspecified visual direction.
- Add `image-canvas` for distinct visual regions, explicit reading order, exact layout constraints, or region-bound references. Count the reading jobs within the intended composition. A main visual and a separate block of facts or supporting copy are distinct regions even on one artboard.
- Add `image-compose` for `COMPOSE`, or later in another route only for a deterministic photo adjustment, batch processing, overlay, layout, diagram, crop, mask, composite, layered source, PSD delivery, SVG/HTML conversion or requested vector PDF delivery.
- Add `image-generate` for `GENERATE`, semantic `EDIT`, or the synthesized raster phase of `HYBRID`.
- Never add `image-design-review` to startup. Load it only when the current artifact handoff requests review and attaches visual evidence.

After route lock, planning and production skills already selected for the task may be read together. `next_skills` orders the work: establish art direction and canvas before authoring, and read all required instructions before creating project files. Defer skills whose need depends on a later result.

For `COMPOSE` and `HYBRID`, use private `image-compose` scripts for evolving authoring/asset capabilities and reserve native `image_studio` for inspect, capture, review, and export. For `GENERATE` and semantic `EDIT`, use `generate_image` within the manifest budget, then inspect and export the result. Follow the host next operation for the current artifact; route labels do not establish a review exemption.
