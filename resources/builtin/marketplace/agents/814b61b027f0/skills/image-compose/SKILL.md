---
ownerAgent: 814b61b027f0
name: image-compose
description_zh: 路线锁定为 COMPOSE 后，或其他路线确实需要确定性排版、图表、覆盖层、裁切、遮罩、合成、SVG/HTML 转换或用户要求的矢量 PDF 交付时，使用本地 HTML/CSS/SVG 和私有脚本制作图片。
description_en: After route lock, produces COMPOSE work or deterministic layout, diagram, overlay, crop, mask, composite, SVG/HTML conversion or requested vector PDF delivery with local HTML/CSS/SVG and private updateable scripts.
---

# Image Compose

Read this skill after route lock for `COMPOSE`, or later in `HYBRID`, `GENERATE`, or `EDIT` only when deterministic copy, layout, diagram, framing, crop, mask, overlay, SVG/HTML conversion or requested vector PDF delivery is required. Do not preload it during routing. Keep the manifest, final source, and local assets in one stable directory.

## Safe project bootstrap

Create `image-manifest.json` and, for an HTML final source, its `index.html` entry file with `write_file`. Repair them with `apply_patch`. Do not assemble either file through `bash`, PowerShell, shell redirection, or an inline script: quoting damage can leave a partially written project and shell safety checks can block recovery.

For a fixed-page booklet or catalogue, read [multipage-documents.md](references/multipage-documents.md) before creating its document manifest.

This production skill is the earliest point at which a `COMPOSE` manifest may be created. Initialize it from the `Canonical image-manifest v1` block in `image-router`; that block is the single structural source, so do not redefine or reconstruct the manifest shape here. Replace every example value with the current brief and planning output. Keep its nesting and value types exactly: `brief.purpose` and every `art_direction` field are required by native inspection, and any region coordinates belong under `visual_plan.regions[].bounds`.

Keep the locked lowercase route and generation budget. On every route, carry the declared `reference_intent` and reference boundaries into the manifest, set `required:true` for reproduction references, and add any generation request fields required by `image-generate`. Read the first manifest back once and repair missing or conflicting fields with `apply_patch` before native inspection.

Declare one final source: `entry` for an HTML composition, or `raster_source` for a finished raster. Remove the other final-source field when the candidate changes form; keep generated layers as local HTML assets. Set `entry` explicitly for HTML work under EDIT or GENERATE. After a script transform, bind its actual output as `raster_source` and inspect that path.

## Authoring contract

- Start from the canvas and art direction in the manifest. Make the first render meaningful without network access or user interaction.
- For new product-led artwork, complete [source-region preparation](references/photo-processing.md#source-region-before-placement) before sizing and placing the supplied product or package asset.
- Keep decorative rules, strokes, and signature geometry outside every required-text bounding box. After any headline revision, recheck the full phrase at thumbnail size and repair any line or shape that crosses, crowds, masks, or visually splits a glyph or line of copy.
- Fit every multi-glyph required headline as a complete phrase before snapshot. Automatic wrapping must never leave a line with only one glyph: widen the text box, reduce the type size, or author an intentional balanced `<br>` before capture. Do not approve a source merely because the DOM contains the exact string; line-by-line rendered legibility is the gate.
- For a non-generation multi-image set, follow [multi-image-sets.md](references/multi-image-sets.md) for the shared production and acceptance contract.
- Use semantic HTML for text and SVG for geometry, diagrams, strokes, charts, patterns, and masks. Use CSS for layout, texture, lighting, and controlled effects.
- For authored HTML, preserve each required-copy string exactly in visible DOM text.
- For copy revisions limited to one area of a supplied raster with the rest held fixed, typeset the replacement as a complete glyph or text run. If an editable source is available, replace only the editable text and retain its typography and text box. With only a flat raster, use the original pixels to locate the old text and sample matching background pixels outside the old glyphs for a uniform background. Preserve the original title area, alignment, visible type size, weight and color. Wrap the replacement naturally within the original title area. Keep the original line count only if the user explicitly requires it. Use similar letterforms that support the replacement copy when the original font is unknown or lacks the required glyphs and the user did not require that font. When loading a font file directly, use the exact font path returned by local font discovery and verify it opens in the renderer before drawing. Pass discovery output directly to the font loader. For example, with fontconfig and Pillow, pass `subprocess.check_output(["fc-match", "-f", "%{file}", pattern], text=True).strip()` to `ImageFont.truetype`, with `pattern` set to the desired installed family and language. Skip missing or unreadable candidates. Render HTML/SVG only as needed for the replacement pixels. Cover only the old text area by using the unchanged source as the base of `masked_composite`, set its output as the final raster (`raster_source`), and call `project.inspect`. Verify the rendered wording and typography against the source at export size. If the wording, typography, and protected area meet the brief, submit the current evidence with `project.submit_design_review` as the next step of the [native workflow](#native-workflow). Revise again only to fix a concrete defect in the current candidate. After its review passes, complete `project.export` before calling `publish_outputs` or linking the final file. Deliver the exported file.
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

For local raster processing and SVG-to-PNG conversion, use `image_asset` through the runner above. Create the request JSON with `write_file` under `--project` before invoking the script. Pass its project-relative path to `--request`; paths in the request are relative to the same project. The script uses the application's existing Sharp dependency. If another Python image library is needed, first verify the selected interpreter and required imports; do not assume Pillow (`PIL`) is installed.

For an existing SVG with PNG-only delivery, save `asset-request.json` with the current paths and run the `image_asset` command above to preserve canvas dimensions and transparency. If the same SVG also needs a vector PDF, use the [native workflow](#native-workflow) for both outputs:

```json
{"op":"process","input_path":"assets/icon.svg","output_path":"exports/icon.png"}
```

Supported `image_asset` operations:

- `capabilities`: report Sharp, RAW, batch processing, and masked composition.
- `process`: Sharp-backed orientation, resize, crop, extend, rotate, blur/sharpen, flatten/trim, format conversion, compositing, `linear` RGB gain/offset, and `modulate` brightness/saturation/hue/lightness.
- `batch`: apply shared photo settings with explicit per-photo replacements and resume verified completed items.
- `masked_composite`: replace only a binary mask's white pixels while retaining the source's exact RGBA in black regions, including partial alpha.
Before raster cropping, edge trimming, resizing, RAW development, ICC conversion, photo adjustments, batches, or exact masked composition, read [photo-processing.md](references/photo-processing.md) for request fields, runnable examples, limits, and recovery.

If RAW development is unavailable, preserve the originals and the requested development settings, including per-photo overrides, and report the RAW work as pending. If suggesting a developed TIFF or JPEG fallback, explain that it loses access to RAW sensor data and editable RAW development, and get the user's agreement before changing the deliverable.

Use `layered_document` for a durable layered source, PNG preview and verified PSD export. Read [layered-documents.md](references/layered-documents.md) at `@skill/image-compose/references/layered-documents.md`. Preserve existing layer structure; a flattened image stays a single layer, and unsupported native editability must be disclosed.

Never install packages, download weights, or start a service. Keep input, request, and output paths inside the project. Prefer a new output path; set `overwrite:true` only for an explicitly replaceable intermediate.

HTML cannot semantically reinterpret a reference. It can faithfully place, crop, mask, recolor, annotate, and composite a supplied image. If the requested result needs a new viewpoint, changed identity, relighting, or content-aware reconstruction, lock `HYBRID` or `EDIT` instead.

## No-runtime production contract

If the required authoring, snapshot, or export tools are unavailable, do not claim a finished image. Return a compact production contract that is still executable later: canvas and export format, exact copy, layout and reading order, one distinctive signature device tied to the subject, local asset/reference roles, typography and palette, and the locked route. The signature device must name its geometry/material and placement; a list of ordinary subject objects is not enough. Include an explicit pre-export checklist for copy/date/time/place accuracy, contrast, safe margins, clipping/overflow, thumbnail legibility, output dimensions/color mode, and reference rights or provenance when relevant. Every item needs a concrete pass criterion, not only a pending label: exact copy match, all required bounds inside the declared safe area, readable required text at feed-thumbnail size, no clipping/overflow, sufficient text contrast, exact export dimensions/format/color mode, and recorded rights/provenance. Mark the unexecuted result pending.

## Native workflow

1. For an HTML final source, call `image_studio` with `project.snapshot` and an output path after the manifest and entry exist. Snapshot validates structure before capture; repair returned blockers before recapturing. A failed structural inspection carries no model image.
2. The passing snapshot attaches the exact full-color candidate as model-visible evidence. Inspect that attachment directly; do not reopen the same path through generic `read_files`, which is not the design-evidence transport.
For a raster final source, `project.inspect` supplies the evidence and next operation directly. The host derives `is_generation` from verified production records: direct model outputs and verified format/proportional-size normalization may remain generation artifacts; crop, mask, overlays and composites do not inherit that exemption. Do not write this host property into the manifest. Follow the returned next operation, skipping the scored-review steps only for `is_generation:true`.

3. For each repair, identify a concrete issue in the current evidence, make a change that can affect it, then capture fresh evidence through inspect (raster) or snapshot (HTML) to check the result. Continue while a concrete issue remains and a viable new correction exists, even across several rounds. Once requirements pass, deliver; optional polish must not delay delivery.
4. For non-generation artifacts, after current visual evidence is attached, read `image-design-review` unless already loaded, then inspect that evidence and submit a structured verdict with `project.submit_design_review`.
5. Call `project.export` only after a passing review of the exact current signature.

`project.export` is the delivery gate. A changed manifest, HTML file, or local resource invalidates the prior review and requires a new snapshot.

- For vector PDF from a standalone SVG, place the unchanged SVG markup inline in a local HTML entry at the SVG's canvas size and retain its background transparency. Snapshot that entry and review the current evidence. Export the requested PNG first when both formats are requested, then export the vector PDF from the same reviewed source with `project.export`, `format:"pdf"`, and an explicit workspace-relative `.pdf` output path. On a PDF-only follow-up, use the retained source and preserve the earlier PNG and SVG as delivered.
- For native PNG delivery or PSD preparation, export to an explicit workspace-relative `.png` output path. After PNG export succeeds, export any requested PSD from the same verified layered source.

Deliver the requested files instead of handing a completed direct request back to Commander.

Put essential export dimensions/format before the first preview. Show only exported final deliverables unless the user asks for review evidence, and write nothing after the last preview; the host may add its own produced-file footer.

Before repeating a failed operation, check whether its relevant files, parameters, or environment changed. Retry after a relevant correction; if the same failure recurs under unchanged conditions, diagnose its cause or choose a supported alternative first. A missing dependency requires an available capability, not repeated parameter changes against the unavailable tool. Preserve the candidate and report the blocker when no supported repair remains.

On a recoverable inspection, snapshot, review, or export result, use
`project.status.current_candidate` and `recovery_context` to resume from the
current files. Repair structural or visual findings and continue the native
chain without asking the user for a technical confirmation.

If no automatic repair remains, show the current candidate image, name the repairs tried and the remaining defects, and give one practical way to continue in an ordinary reply.
