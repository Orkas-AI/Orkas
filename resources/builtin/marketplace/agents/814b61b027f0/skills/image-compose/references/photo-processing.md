# Local photo processing

Run `image_asset` with the Skill's generic runner command and a request JSON
created with `write_file`. `--project` names an existing directory;
`--request` and all image paths resolve relative to that directory. Use actual
source names and a new output path. The returned JSON describes the executed
operation; no image generation is involved.

For capability discovery, use `write_file` to create `asset-capabilities.json`
in the project root with this content:

```json
{"op":"capabilities"}
```

Run from the project root with that same file as `--request`:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" image-compose image_asset -- --project . --request asset-capabilities.json
```

Read `sharp`, `photo_processing`, and `masked_composite` from the returned JSON.

## Source region before placement

For product-led compositions, resolve the source region from the supplied image
and its preserve/may-change contract first. Keep original framing when protected
by reproduction requirements or scoped edits. When reframing is allowed and
source padding interferes with the chosen presentation, verify a region that
contains the whole product or package, including its silhouette and markings.
Use the crop or trim operations below to prepare a new asset from that region
before choosing its final image-frame scale; retain the original as the fidelity
reference. Edge-color trimming is not subject detection.

Match the processed asset to its display frame. A `cover` fit can crop the product
after source padding has been removed. Use `contain`, proportional `inside`
resizing, or appropriate padding when the whole subject must remain visible.
Inspect the rendered silhouette and labels against the original; a large image
element does not establish a large or legible product inside it.

## Crop, edge trim and resize

Use `op:"process"` with `input_path`, a new `output_path`, and an `operations`
array. Replace the example paths and dimensions with the current image's values.

| Operation | Parameters |
| --- | --- |
| `extract` | `left`, `top`: integer pixel offsets from the input's top-left, starting at 0. `width`, `height`: positive integer pixel dimensions. The rectangle must fit inside the input. |
| `trim` | `background`: edge color to remove, such as `"#ffffff"`; default `"#00000000"`. Trims matching outer background, not semantic subject segmentation or interior background removal. |
| `resize` | Positive integer `width` and/or `height`; at least one is required. Optional `fit`: `cover` (default), `contain`, `fill`, `inside`, or `outside`. `inside` preserves aspect ratio within the given bounds; `fill` can distort, and `cover` can crop. |

For example, extract a 320×240 rectangle from a larger source:

```json
{
  "op": "process",
  "input_path": "photos/source.png",
  "output_path": "out/cropped.png",
  "operations": [{ "type": "extract", "left": 160, "top": 120, "width": 320, "height": 240 }]
}
```

Or trim white outer padding:

```json
{
  "op": "process",
  "input_path": "photos/source.png",
  "output_path": "out/trimmed.png",
  "operations": [{ "type": "trim", "background": "#ffffff" }]
}
```

Or resize proportionally to fit within 320×240:

```json
{
  "op": "process",
  "input_path": "photos/source.png",
  "output_path": "out/resized.png",
  "operations": [{ "type": "resize", "width": 320, "height": 240, "fit": "inside" }]
}
```

## Photo adjustments

For one photo, use `op:"process"`, `input_path`, `output_path`, and an
`operations` array. For a set, use `op:"batch"` as below. These operation fields
apply to both:

| Operation | Parameters |
| --- | --- |
| `linear` | `a`: gain, default 1, range 0–16; `b`: offset, default 0, range −255–255. Each accepts a number or three RGB numbers. Output follows Sharp's pixel rounding/clipping. |
| `modulate` | Optional `brightness` and `saturation`: 0–4; `hue`: −180–180 degrees; `lightness`: −100–100. Omitted fields retain Sharp's defaults. |

Each request accepts up to 16 operations. This is ordinary raster adjustment,
not RAW white balance, highlight recovery, or a complete color-managed editor.

## Batch with a per-photo override

This example applies a common gain and offset to two photos and reduces only
blue for the third. Change the settings to the user's requested adjustment.

```json
{
  "op": "batch",
  "operations": [{ "type": "linear", "a": 1.2, "b": 3 }],
  "items": [
    { "input_path": "photos/a.png", "output_path": "out/a.png" },
    { "input_path": "photos/b.png", "output_path": "out/b.png" },
    {
      "input_path": "photos/c.png",
      "output_path": "out/c.png",
      "operations": [{ "type": "linear", "a": [1, 1, 0.5] }]
    }
  ]
}
```

Batch accepts 1–128 items. Top-level `operations`, `quality`, `raw`, and `color`
are shared; an item's values override them. Item `operations` replaces the entire shared
array, so include every desired operation in an override; `[]` applies none.
`quality` is an integer from 1–100, default 92. Output extensions are PNG,
JPEG, WebP, AVIF, and TIFF. Batch does not accept `composite_layers` or overwrite
outputs, and no output or receipt may replace any input or another destination.

The result reports `completed`, `reused`, `failed`, and per-item status.
Inspect every failed item before claiming the set is complete. Repair a missing
or corrupt source and rerun the request: completed outputs are reused only when
their `.image-batch.json` receipt matches source bytes, effective parameters,
engine versions, and output bytes. Keep receipts with the working outputs.
Changed settings, changed sources, damaged outputs, or missing receipts require
a new output path; rerunning does not authorize replacing an existing delivery.

## Basic RAW development

Use the same `image_asset` runner for RAW: LibRaw 0.22.3 is bundled with the
application. Check `photo_processing.raw.available` in its `capabilities` result;
a system PATH lookup does not establish whether the bundled engine is available.
Add `raw` to a `process` or `batch` request to decode sensor data before Sharp
adjustments. Ordinary `linear`/`modulate` operations and an embedded JPEG do not
establish RAW development.

| `raw` field | Supported values |
| --- | --- |
| `exposure_ev` | Number from −2 to +3 EV; default 0. |
| `white_balance` | `"camera"` (default), `"auto"`, or `{"multipliers":[R,G,B,G]}` with four numbers greater than 0 and at most 16. These are channel multipliers, not Kelvin temperature. |
| `highlights` | `"clip"` (default), `"blend"`, or `"rebuild"`; basic engine modes, not a guarantee of recovered detail. |
| `preserve_highlights` | Number from 0 to 1; default 0. |

This example uses camera white balance and +1 EV for the set, with +2 EV for
the third photo. An item `raw` replaces the shared object; omitted members use
the defaults above, so repeat every non-default setting that must be retained.

```json
{
  "op": "batch",
  "raw": { "exposure_ev": 1, "white_balance": "camera" },
  "color": { "output": "srgb" },
  "items": [
    { "input_path": "photos/a.dng", "output_path": "out/a.png" },
    { "input_path": "photos/b.dng", "output_path": "out/b.png" },
    {
      "input_path": "photos/c.dng",
      "output_path": "out/c.png",
      "raw": { "exposure_ev": 2, "white_balance": "camera" }
    }
  ]
}
```

Preserve the RAW originals, request JSON, outputs and batch receipts. RAW
receipts retain effective development parameters and engine identity for resume.
The decoder uses a temporary 16-bit TIFF; deliver 8-bit sRGB PNG/JPEG, not a
claimed 16-bit master. RAW implies sRGB output; PNG in this path is lossless
truecolor. Dimensions stay unchanged unless a requested operation changes them.
Inputs are limited to 512 MiB per RAW; decoded images retain the helper's
100-million-pixel and 16,384-pixel-per-dimension limits. Camera support depends
on the bundled decoder, not the filename extension.

If `raw.available:false` or `E_RAW_UNAVAILABLE` is returned, preserve the work
and report that the app dependencies need repair or Orkas needs reinstalling;
do not install another engine or substitute a preview. For a decode failure,
check source integrity and camera support, then resume repaired inputs. Cancelled
batches leave unstarted items `pending`; inspect `failed` and `pending` items
before claiming completion. Changed settings still require new output paths.

## ICC conversion for screen delivery

For an ordinary raster, add `color:{"output":"srgb"}` to `process` or `batch`.
The helper converts an embedded input profile and embeds the output sRGB profile;
untagged input is assumed sRGB. Preserve the source profile with the original.

```json
{
  "op": "batch",
  "color": { "output": "srgb" },
  "items": [
    { "input_path": "photos/wide-gamut.png", "output_path": "out/srgb.png" }
  ]
}
```

Malformed profiles or conversion diagnostics fail before output publication;
preserve the source and resolve its profile rather than relabeling its pixels.
This is screen-oriented sRGB conversion, not print soft proofing, display
calibration, arbitrary output profiles or a complete color-managed editor.

## Exact binary-mask composition

Use this when existing source and replacement images must be combined with
exact protection of unselected pixels:

```json
{
  "op": "masked_composite",
  "input_path": "artwork/source.png",
  "background_path": "artwork/background.png",
  "mask_path": "artwork/mask.png",
  "output_path": "out/masked.png"
}
```

White mask pixels copy replacement RGBA; black pixels retain original RGBA,
including partial alpha. All three decoded inputs must have identical dimensions
and at most 16,777,216 pixels. Source and background must be 8-bit sRGB;
the mask must be 8-bit opaque binary black/white. Feathered or gray masks are
unsupported: do not silently threshold or resize a supplied mask to bypass this
boundary. Output must be a new PNG and cannot replace any input.

The script decodes the encoded output and checks it against the composed RGBA
before publishing. Success returns `protected_pixels_verified:true` and a
`protected_pixels` count. This establishes local pixel preservation, not native
model masking or editable layers. For a dimension, color, or mask rejection,
preserve inputs and resolve that specific mismatch; an existing output requires
a new path. This operation has no batch-style resume receipt.
