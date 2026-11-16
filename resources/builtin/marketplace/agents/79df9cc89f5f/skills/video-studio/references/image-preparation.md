# Preparing still images for shots

Use the private `image_asset` script through this Skill's bound runner command:

```bash
production_root="<absolute production directory>"
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" video-studio image_asset -- --project "$production_root" --request-file inspect.json
```

Set `production_root` to the actual absolute production directory for this
invocation, rather than resolving the folder name again after changing cwd.
Write `inspect.json` inside that directory. `--request-file`, `input_path` and
`output_path` resolve inside `--project`, not the shell's cwd. Keep those paths
production-relative so the production can move without rewriting its files.

Alternatively pass the JSON object directly, without a request file:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" video-studio image_asset -- --project "$production_root" --request-json '{"op":"inspect","input_path":"media/package.jpg"}'
```

Choose exactly one request form. Legacy `--request` is a file-only alias for
`--request-file`; JSON content belongs in `--request-json`. Both forms use the
same validation and processing, with media paths relative to `--project`.

This is local Sharp processing, with no generation or service call. Requests are
JSON objects of at most 64 KiB; still images are limited to 16,384 pixels per
dimension and 100 million pixels. Animated/multipage images need a selected
still first. Outputs are new PNG, JPEG or WebP files; existing files stay intact.

First inspect the original, not the compressed image shown by `read_files`:

```json
{"op":"inspect","input_path":"media/package.jpg"}
```

The result gives `width`, `height`, EXIF `orientation`, encoded dimensions and
`coordinate_space:"oriented_original_pixels"`. Processing applies EXIF
orientation before cropping. A displayed preview can have different dimensions;
convert its observed bounds proportionally to these original dimensions and
verify them on the source. Do not treat preview pixel coordinates as original
pixels. Dimensions establish the coordinate system, not the product's bounds.

Prepare only the region the shot needs, preserving the original:

```json
{
  "op":"process","input_path":"media/package.jpg","output_path":"media/package-detail.png",
  "source_size":{"width":720,"height":1280},
  "crop":{"left":165,"top":350,"width":390,"height":550},
  "resize":{"width":720,"height":1080,"fit":"inside"}
}
```

Replace every dimension with verified values. `source_size` is required for a
crop and must match `inspect`. Crop offsets start at zero in the oriented
original, and the whole rectangle must fit. `resize` takes positive integer
width and/or height and `fit`: `inside` (default), `contain`, `cover` or `fill`.
`inside` preserves proportions; `contain` adds transparent bars when needed;
`cover` can cut off details and `fill` can distort. Optional `padding` takes
nonnegative integer `left`, `right`, `top`, `bottom` and a Sharp `background`
color, default transparent. Order is orientation, crop, resize, padding.

Look at the new image before placing it: verify the intended detail, silhouette
and required labels against the original. A detail crop is not a whole-product
view. Register the new image in `assets.json` with `origin:"edited"`; retain the
source row and adjust any `subject` bounds to the new asset. Then inspect the
actual scene frames under the timeline's framing guidance. A successful crop
does not establish a meaningful story or readable labels in the final video.
