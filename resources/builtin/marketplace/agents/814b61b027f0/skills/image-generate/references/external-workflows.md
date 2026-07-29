# External image workflow formats

All files below stay inside the image project. Endpoints and credentials are host-managed and never appear in these files.

## ComfyUI

Use API-format JSON exported by the user's working ComfyUI installation. Accepted forms are the raw prompt graph, `{ "workflow": { ... } }`, or `{ "prompt": { ... } }`. Optional top-level `output_node_id` and `output_index` select the output deterministically.

Real-ESRGAN, SAM/SAM2, GroundingDINO, IP-Adapter, and ControlNet may be used only when the exported graph already contains working nodes and the host has the corresponding models. Never synthesize a graph around guessed custom-node class names. Orkas dispatches the graph but does not install or certify its nodes.

## InvokeAI

Use an exported graph, `{ "graph": { ... } }`, or the complete `{ "batch": { ... }, "prepend": false }` enqueue request. Optional top-level `output_node_id` and `output_index` choose a result.

## AUTOMATIC1111

Text-to-image request:

```json
{
  "mode": "txt2img",
  "request": {
    "prompt": "compiled positive prompt",
    "negative_prompt": "compiled negative prompt",
    "width": 1024,
    "height": 1024,
    "steps": 28,
    "seed": 42
  },
  "output_index": 0
}
```

Image-to-image or inpaint request:

```json
{
  "mode": "img2img",
  "init_image_paths": ["references/source.png"],
  "mask_path": "references/mask.png",
  "request": {
    "prompt": "localized edit prompt",
    "negative_prompt": "unwanted changes",
    "denoising_strength": 0.45,
    "inpaint_full_res": true,
    "inpainting_mask_invert": 0,
    "steps": 28,
    "seed": 42
  },
  "output_index": 0
}
```

The kernel reads and embeds only project-local PNG, JPEG, or WebP references. Keep the source and mask dimensions equal. Set API defaults explicitly for reproducibility rather than relying on UI defaults.

## IOPaint

```json
{
  "image_path": "references/source.png",
  "mask_path": "references/mask.png",
  "request": {
    "prompt": "remove the distracting sign and reconstruct the brick wall",
    "negative_prompt": "new objects, changed person, text",
    "hd_strategy": "Crop",
    "sd_strength": 0.75,
    "sd_steps": 32,
    "sd_seed": 42,
    "sd_keep_unmasked_area": true
  }
}
```

The mask uses white for the edited area. Use an empty prompt for a host erase model such as LaMa; use a concrete prompt only when replacement or semantic reconstruction is intended. The engine returns one image, so `output_index` is always zero.

## Dispatch rules

1. Call `workflow.capabilities` and select only an `executable:true` engine.
2. Keep one stable `image_request_id` per generation intent.
3. Call `workflow.run` once. `pending_uncertain` means the request may be running; never retry blindly.
4. Inspect the returned raster, score current evidence, and repair only from concrete findings within the manifest budget.
