---
ownerAgent: 814b61b027f0
name: image-compose
description_zh: 路线锁定为 COMPOSE 后，或其他路线确实需要确定性排版、图表、覆盖层、裁切、遮罩与合成时，使用本地 HTML/CSS/SVG 和私有脚本制作图片。
description_en: After route lock, produces COMPOSE work or deterministic layout, diagram, overlay, crop, mask, and composite phases with local HTML/CSS/SVG and private updateable scripts.
category: creation
---

# Image Compose

Read this skill after route lock for `COMPOSE`, or later in `HYBRID`, `GENERATE`, or `EDIT` only when deterministic copy, layout, diagram, framing, crop, mask, or overlay work is required. Do not preload it during routing. Keep the artifact in one stable directory containing `image-manifest.json`, `index.html`, and local assets.

## Authoring contract

- Start from the canvas and art direction in the manifest. Make the first render meaningful without network access or user interaction.
- Use semantic HTML for text and SVG for geometry, diagrams, strokes, charts, patterns, and masks. Use CSS for layout, texture, lighting, and controlled effects.
- Preserve every required-copy string exactly in visible DOM text. Keep important text out of raster assets.
- Preserve natural English casing: use sentence case or natural title case for titles and sentence case for body, captions, labels, and CTAs. Keep all caps only when that exact casing is explicit in required user copy or an external brand/source, and then only for one short metadata label, acronym, or code. Never apply `text-transform: uppercase` through a broad selector or use multiple all-caps text roles; create hierarchy with family, width, weight, scale, color, or spacing.
- Use only local relative assets inside the project directory. Do not use scripts, CDNs, remote fonts, remote images, iframes, embedded pages, autoplay media, or a local server.
- In `HYBRID`, use the generated raster as one deliberate layer and let HTML/SVG own copy, logo placement, framing, and layout.
- Map every `visual_plan.regions[].id` to an HTML/SVG element with `data-image-region`. Treat supplied reference images as local assets: they remain usable in HTML through `<img>`, CSS backgrounds, SVG `<image>`, masks, crops, and overlays without a generation call.
- Declare the fixed canvas on the `index.html` root with `data-preview-layout="fixed-canvas"`, `data-preview-width="<canvas.width>"`, and `data-preview-height="<canvas.height>"`. The two dimensions must exactly match `image-manifest.json`; this is the shared HTML viewer contract, not ImageStudio-specific presentation logic.
- Size for the declared canvas. Avoid hidden overflow, tiny copy, edge collisions, and low-contrast focal content.

## Skill-owned zero-call helpers

Do not add native `image_studio` operations for authoring libraries. Run these private skill scripts through the generic skill runner; they can ship independently from the application security kernel:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" image-compose structured_visual -- --project project/image --input chart.json --output assets/chart.svg
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" image-compose image_asset -- --project project/image --request asset-request.json
```

Use `structured_visual` for deterministic `diagram`, `bar`, `line`, and `donut` SVGs. Read [structured-visuals.md](references/structured-visuals.md) before writing its JSON input. The output is static local SVG with no script, CDN, browser library, or model call. Use it for Mermaid/ECharts-class needs when a structured chart or graph is enough; author custom SVG when the visual idea needs an irregular editorial composition.

Use `image_asset` with a project-local request JSON:

- `capabilities`: report Sharp, optional `rembg`, and optional host-configured Real-ESRGAN.
- `process`: Sharp-backed orientation, resize, crop, extend, rotate, blur/sharpen, flatten/trim, format conversion, and compositing.
- `remove_background`: use host-managed `rembg` only when capability evidence says available.
- `upscale`: use host-managed `ORKAS_REALESRGAN_BIN` only when capability evidence says available. This is local enhancement and does not consume the paid image-generation budget.

Never install packages, download weights, or start a service. Keep input, request, and output paths inside the project. Prefer a new output path; set `overwrite:true` only for an explicitly replaceable intermediate.

HTML cannot semantically reinterpret a reference. It can faithfully place, crop, mask, recolor, annotate, and composite a supplied image. If the requested result needs a new viewpoint, changed identity, relighting, or content-aware reconstruction, lock `HYBRID` or `EDIT` instead.

## No-runtime production contract

If the required authoring, snapshot, or export tools are unavailable, do not claim a finished image. Return a compact production contract that is still executable later: canvas and export format, exact copy, layout and reading order, one distinctive signature device tied to the subject, local asset/reference roles, typography and palette, and the locked route. The signature device must name its geometry/material and placement; a list of ordinary subject objects is not enough. Include an explicit pre-export checklist for copy/date/time/place accuracy, contrast, safe margins, clipping/overflow, thumbnail legibility, output dimensions/color mode, and reference rights or provenance when relevant. Every item needs a concrete pass criterion, not only a pending label: exact copy match, all required bounds inside the declared safe area, readable required text at feed-thumbnail size, no clipping/overflow, sufficient text contrast, exact export dimensions/format/color mode, and recorded rights/provenance. Mark the unexecuted result pending.

## Native workflow

1. Call `image_studio` with `project.inspect` after the manifest and entry exist. Repair all structural blockers. The native tool is a stable capture/evidence/export security kernel, not an authoring library registry.
2. Call `image_studio` with `project.snapshot` and an output path. Inspect the returned image visually.
3. Apply one coherent repair batch if required, then repeat inspect and snapshot. Do not make serial cosmetic tweaks without new evidence.
4. Inspect the current evidence and submit a structured verdict with `project.submit_design_review`.
5. Call `project.export` only after a passing review of the exact current signature.

`project.export` is the delivery gate. A changed manifest, HTML file, or local resource invalidates the prior review and requires a new snapshot.

On a recoverable inspection, snapshot, review, or export result, use
`project.status.current_candidate` and `recovery_context` to resume from the
current files. Repair structural or visual findings and continue the native
chain without asking the user for a technical confirmation. If no automatic
repair remains, show the current candidate image and findings before asking
for the smallest real creative or delivery decision.
