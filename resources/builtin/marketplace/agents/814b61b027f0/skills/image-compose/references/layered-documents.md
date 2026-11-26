# Layered source and PSD delivery

`layered_document` uses existing Sharp and the bundled PSD writer without a
model call. Run it through the ordinary private Skill runner:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" image-compose layered_document -- --project . --request layered-request.json
```

Both arguments name existing project files/directories. Every path in the
request and source resolves against `--project`, including asset paths in a
source saved in a subdirectory. The source below is a separate design document,
not `image-manifest.json`.

## Source document

Save as `design.json`. Layers and group children are ordered bottom to top.

```json
{
  "schema_version": 1,
  "canvas": { "width": 320, "height": 240 },
  "layers": [
    { "id": "base", "type": "image", "name": "Base", "path": "assets/base.png" },
    {
      "id": "caption", "type": "group", "name": "Caption",
      "children": [
        { "id": "badge", "type": "image", "name": "Badge", "path": "assets/badge.png", "left": 240, "top": 192, "opacity": 0.75, "mask_path": "assets/badge-mask.png" },
        { "id": "headline", "type": "text", "name": "Headline", "text": "Field notes", "left": 16, "top": 20, "width": 288, "height": 40, "font_family": "Arial", "font_postscript_name": "ArialMT", "font_size": 24, "color": "#223355" }
      ]
    }
  ]
}
```

- Each node needs a unique `id` (1–64 letters, digits, underscores or hyphens),
  `type` and non-empty `name` (up to 128 characters). Optional `visible` defaults
  to `true`. A group has non-empty `children`; group opacity/masks are unsupported.
- Image layers use `path`; `left`/`top` default to zero and `opacity` defaults to
  one (range 0–1). Images must fit inside the canvas without implicit resizing.
  Inputs are single-frame, 8-bit sRGB PNG/JPEG/WebP/AVIF/TIFF.
- Text layers use the fields shown above. Text is horizontal, uniformly styled,
  up to 1024 characters and 16 LF-separated lines. `font_size` is 1–512 pixels;
  optional `line_height` defaults to 1.2 times that size, is at least the size
  and at most 1024. `color` is `#RRGGBB`. The declared box must fit all text.
  `font_family` supplies preview rendering; `font_postscript_name` identifies
  the PSD font. Fonts are not embedded; a missing/different editor font can
  change appearance. Position, opacity and `mask_path` also apply to text.
- An optional raster `mask_path` must match that layer's pixel dimensions and
  contain opaque grayscale: white reveals, black hides, gray partially reveals.
  The original layer pixels and mask remain separate in the PSD.

Limits: canvas dimensions 1–8192, at most 4,194,304 canvas pixels, 64 total nodes,
8 group levels, 16,777,216 summed image/text layer pixels, 1 MiB source/request
JSON, 16 MiB per input file and 64 MiB unique inputs. Output is 8-bit RGB PSD.
Rich/vertical/warped text, smart objects, complex effects, 16/32-bit output and
arbitrary PSD import are outside this helper's supported fields.
The existing native PNG delivery flow additionally requires each canvas
dimension to be 128–4096; helper rendering alone does not complete that flow.

## Requests and export

Write one request JSON and execute the command above for each operation.

```json
{ "op": "capabilities" }
```

This returns `psd_available` and actual supported operations. Older apps without
the writer retain rendering but cannot export PSD.

```json
{ "op": "render", "document_path": "design.json", "output_path": "out/preview.png" }
```

Rendering writes a PNG and `out/preview.png.layered-source.json`, binding it to
the source and input hashes. Use that PNG as the manifest's `raster_source` with
the same canvas, and follow the existing native inspection and PNG export flow.
Scored visual review applies only when the host reports `is_generation:false`.
For unchanged full-canvas single-image packaging of a generated original, bind
the recorded original as `raster_source` instead; its pixels must equal the
helper preview. The host verifies generation provenance. Adding text, masks,
cropping or compositing uses the new preview and does not inherit that exemption.
For every revision, write the helper PNG and PSD to working paths distinct
from the user's requested delivery paths. Keep the helper preview and receipt.
Inspect that version, complete any required review, and use native export to
write the requested final PNG before exporting the requested final PSD.

### Native project mapping

Choose the directory containing `image-manifest.json` before rendering. Use it
for both `--project` and `image_studio.project_dir`, including on revisions.
Keep the original raster reference, current helper preview and PSD draft inside
that directory. Bootstrap the manifest from the router's canonical template.
Set `raster_source` and `references[].path` relative to the manifest directory.
For example, with `project_dir:"poster-work"`, the file
`poster-work/out/preview.png` is `raster_source:"out/preview.png"` in the
manifest. Call `project.inspect` with `project_dir` and let the manifest select
the raster.

If the locked route is `EDIT`, its original is a raster reference. For an
existing layered design, render a preserved copy of the original document to
`out/original.png` before changing the working source. A top-level `edit_source`
field or a JSON path does not register that original. These are the native
manifest additions for an edit; replace the instruction and boundaries with
the actual request, retaining the required original raster:

```json
{
  "reference_intent": {
    "mode": "edit", "basis": "user",
    "instructions": ["Replace the headline copy"], "minimum_score": 80
  },
  "references": [
    {
      "id": "original", "path": "out/original.png", "role": "edit_source",
      "strength": 1, "required": true,
      "preserve": ["base image", "badge pixels and position"],
      "may_change": ["headline copy"], "region_ids": []
    }
  ]
}
```

For a flat original, `references[].path` can directly name that preserved image
under the same project root. Route selection still belongs to `image-router`.

After that PNG export, use the same unchanged source and helper preview:

```json
{ "op": "export_psd", "document_path": "design.json", "preview_path": "out/preview.png", "output_path": "out/candidate.psd" }
```

Export verifies source/preview binding, decoded preview pixels, and PSD readback
of hierarchy, native text, image channels, masks, visibility, positions and
opacity. Partial-alpha merged previews permit PSD's one-level white-matte
quantization; editable layer/mask channels remain exact. Results identify
`verification:"local_psd_readback"` and `external_editor_verified:false`;
this does not establish a Photoshop reopen test or visual approval.

The helper returns `delivery_state:"candidate"` and `final_export` for that
file. Call `image_studio` with `op:"project.export"`, the same `project_dir`
and `format:"psd"`. Pass `final_export.input_path` unchanged as `input_path`.
Choose a new workspace-relative or absolute `output_path` for the delivered
file. The host keeps the PSD bytes intact,
checks its merged pixels against the current evidence and requires the current
native PNG export. It requires a passing visual review only for authored
non-generation evidence; a verified generation needs no scores. A missing,
stale or changed PNG export requires repeating the native PNG step. A PSD pixel
mismatch requires rendering/exporting a new matching candidate. Source and
candidate files remain available after rejection.

Keep the source JSON and referenced assets for later revisions. Basic native
text can be changed in an external PSD editor; this adds no in-app text editor.
A supplied flat PNG/JPEG becomes one image layer, with no recovered text,
objects or masks. Existing structured work retains its actual layers.

## Failure and recovery

Outputs never overwrite inputs or existing files. After changing source/assets,
render to a new PNG path, repeat the native flow, then export a new PSD.
If publication reports `blocked_candidates`, complete the native flow in the
current turn. Move any draft occupying a requested delivery path to a working
path, and publish the successful native exports.
`E_LAYERED_STALE` means the source or preview changed; the old receipt cannot
authorize a new export. `E_LAYERED_EXISTS` requires a new output path. A process
interruption may leave a preview or receipt; retain useful files and choose new
paths rather than treating partial output as verified delivery. Missing writer
or unsupported fields leave the source/preview available; disclose the precise
remaining deliverable boundary. PSD `structure_verified` is only true after
successful export/readback.
