---
ownerAgent: 814b61b027f0
name: image-generate
description_zh: 路线锁定为 GENERATE、语义 EDIT 或 HYBRID 的栅格生成阶段后，才负责编译提示词、控制调用预算并把生成结果送入统一视觉复核。
description_en: After route lock, handles synthesized or reconstructed pixels for GENERATE, semantic EDIT, or the raster phase of HYBRID; skip COMPOSE and deterministic transforms.
category: creation
---

# Image Generate

Read this skill only after route lock when the task needs synthesized or content-aware reconstructed pixels: `GENERATE`, semantic `EDIT`, or the raster phase of `HYBRID`. Do not load it for `COMPOSE`, deterministic transforms, or overlays. It governs direct `generate_image` calls and the stable host workflow kernel; engine-specific request formats and reusable graphs remain private skill resources rather than new application tools.

## Generation rules

- Respect `generation_budget.max_calls`. `COMPOSE` has a budget of zero; `HYBRID` normally has one; `GENERATE` and `EDIT` normally allow one initial call and one evidence-based repair.
- Generate at the final aspect ratio whenever the provider supports it. Do not rely on destructive cropping to fix a mismatched composition.
- Use reference images only when they encode composition, identity, product fidelity, or edit continuity that the prompt cannot preserve reliably.
- Mirror manifest references into `generate_image.reference_bindings` using the exact concatenated reference order. Include role, strength, preserve, may-change, and target region. Send `generation_contract.negative_prompt` separately.
- Compile `reference_intent.mode` into the request: reproduction asks for the declared protected attributes to match; guide limits influence to declared roles; editing uses the required `edit_source` as the original. User-declared instructions and boundaries have priority over inferred defaults and provider convenience.
- Treat every planned `output_path` as one stable artifact binding. Reuse that exact string byte-for-byte for the provider/workflow result, later `project.inspect`, review candidate, and export input; never retype, derive, or silently correct the path in a downstream handoff.
- For edits, send the manifest instructions, protected regions, unchanged attributes, and allowed changes explicitly. Prefer a localized edit over regenerating the full scene, and never reinterpret an edit as a fresh variation.
- For reproduction, do not silently change subject, crop, layout, identity, typography, palette, or other preserved axes merely because regeneration is easier. Choose the provider/control path that can honor the declared fidelity floor.
- For hybrid work, generate only the difficult raster layer. Exclude final copy, logos, labels, diagrams, and UI text from the model request.
- Save every generated output inside the image project and record its relative path in `image-manifest.json` before inspection.

`generation_contract.controls` records provider-neutral IP-Adapter/ControlNet-style intent. Translate its reference, strength, and target region into the generic reference contract. A provider may additionally consume structured fields, but never claim that it applied a native control unless returned capability or provider evidence says so.

## Provider availability and billing disclosure

Before every direct `generate_image` call, call `image_studio generation.quote` with the same stable `image_request_id`, exact `size`, and combined local-plus-URL `reference_count` that will be dispatched.

- Treat the returned quote as a local capability check. `external` means the configured BYO/local provider can handle the request and may bill through its own account; `unavailable` is a blocker.
- The open build does not estimate provider prices or maintain an in-app credit balance. Never infer a price from model names, cache a local price table, or multiply a remembered per-image rate.
- Stop when the quote reports an unavailable provider or `sufficient:false`. Do not spend a new request id, consume a manifest call slot, or silently switch to another billing path.
- `generate_image` checks provider availability again immediately before it creates the durable generation transaction.
- A completed stable request id is reused without a new quote or provider call. A pending or failed id remains closed and cannot be bypassed.

When returning a cost decision or execution handoff, keep the state machine
machine-readable: state whether dispatch is allowed, whether external billing
applies, project call slots consumed, the exact next operation, and the
`generation.quote` recheck. Do not replace these fields with a vague prose
summary.

`project.status` may include a next-call quote using provider-default size and manifest reference count. Use it for orientation only; `generation.quote` must carry the exact request immediately before a direct call.

## External workflows

Use an external workflow only when the user or host has already configured ComfyUI, InvokeAI, AUTOMATIC1111, or IOPaint and a reusable project-local request offers a concrete control or model advantage. First call `image_studio workflow.capabilities`; never infer availability from a file or a prior session. Read [external-workflows.md](references/external-workflows.md) for the project-local formats.

- The endpoint and credential are host-managed. Never accept, construct, print, or persist them in agent output or project files.
- Read the engine-specific reference before drafting its request and preserve
  exact field names instead of paraphrasing the protocol. For IOPaint edits
  that protect unaffected pixels, set `request.sd_keep_unmasked_area:true`.
- Validate the drafted request against the selected engine schema before
  handing it off. An IOPaint masked edit that protects unaffected pixels is
  incomplete unless the nested `request` object contains the exact boolean
  `"sd_keep_unmasked_area": true`; a prompt, `protected_content`, or review
  instruction saying "preserve unmasked pixels" does not replace this field.
- `workflow_path` must be a project-local engine request JSON. Prefer a user-exported, reviewed graph; do not invent custom server nodes or install missing nodes/models.
- Call `workflow.run` with the configured engine, stable `image_request_id`, project-local output, and optional output node/index. It consumes the manifest's durable generation budget exactly like `generate_image`.
- A host-configured workflow does not use in-app billing. Its host/provider may still have separate billing; report that billing as external and not estimated.
- Treat `pending_uncertain` as a dispatched call. Do not retry it or create a replacement request id; inspect the host queue and report the pending state.
- Capability evidence proves protocol reachability, not that a particular graph node or model exists. Report the executed engine and returned dispatch evidence without claiming broader native-control support.

An execution handoff must retain concrete, executable fields: the exact
`workflow.run` operation, engine, project-local `workflow_path`, stable
`image_request_id`, output path, manifest `max_calls`, and output node/index
when applicable. The next-evidence chain must name `project.inspect` and
`project.submit_design_review` exactly; natural-language approximations are not
an executable handoff.

For missing capabilities:

- Prefer the private `image-compose image_asset` script with host-managed Real-ESRGAN for zero-paid-call upscaling; a reviewed ComfyUI graph is the fallback.
- Use an IOPaint request or a reviewed ComfyUI graph for mask-preserving inpaint/object removal. Keep unaffected pixels protected.
- Use SAM/SAM2 or GroundingDINO only through an already installed, user-reviewed host workflow that materializes a mask. These projects are capability sources, not bundled Orkas runtimes.
- Use AUTOMATIC1111 for existing host installations and `txt2img`/`img2img` compatibility. Never put HTTP credentials or base URLs in its request file.

## Review loop

After either generation path, call `image_studio` with `project.inspect`, passing the raster path. Inspect the evidence and the actual reference side-by-side for subject accuracy, changed-versus-protected regions, composition, anatomy, material behavior, text artifacts, continuity, and the manifest's must-avoid constraints. A repair call must address concrete findings from the current evidence; never spend the second call on an ungrounded variation search.

Submit a signature-bound design review and export the exact approved raster through `image_studio`. A definite pre-dispatch failure is recorded but does not consume a generation call; a dispatched, terminal failure or `pending_uncertain` attempt still counts. If the repair budget is exhausted, use `project.status.current_candidate` and `recovery_context`: keep the best reviewed image visible, apply any useful deterministic zero-call repair, and report the remaining finding. Ask the user only before an additional paid call or a material intent/quality tradeoff; a direct chat reply is sufficient and no recovery form is required.
