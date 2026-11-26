---
ownerAgent: 814b61b027f0
name: image-generate
description_zh: 路线锁定为 GENERATE、语义 EDIT 或 HYBRID 的栅格生成阶段后，才负责编译提示词、控制调用预算并对生成结果做确定性文件校验；生成栅格不进入 ImageStudio 视觉复核。
description_en: After route lock, handles synthesized or reconstructed pixels for GENERATE, semantic EDIT, or the raster phase of HYBRID; skip COMPOSE and deterministic transforms.
---

# Image Generate

Read this skill only after route lock when the task needs synthesized or content-aware reconstructed pixels: `GENERATE`, semantic `EDIT`, or the raster phase of `HYBRID`. Do not load it for `COMPOSE`, deterministic transforms, or overlays. It governs `generate_image` calls.

This production skill is the earliest point at which a manifest for a direct `GENERATE` or `EDIT` task may be created. Initialize `image-manifest.json` from the `Canonical image-manifest v1` block in `image-router`; it is the single structural source. Replace the locked route and budget, then add the reference and generation fields below. Do not reconstruct the base schema from memory.

## Generation rules

- Respect `generation_budget.max_calls` within the current user turn. The host reapplies this limit independently for each new user turn while retaining older transactions only as audit history. `COMPOSE` has a budget of zero; `HYBRID`, `GENERATE`, and `EDIT` normally use one call. Set a two-call budget only when the user explicitly requests iterative refinement or authorizes another billable attempt. A review finding alone never authorizes that second call.
- Generate at the final aspect ratio whenever the provider supports it. Do not rely on destructive cropping to fix a mismatched composition.
- Use reference images only when they encode composition, identity, product fidelity, or edit continuity that the prompt cannot preserve reliably.
- Mirror manifest references into `generate_image.reference_bindings` using the exact concatenated reference order. Include role, strength, preserve, may-change, and target region. Send `generation_contract.negative_prompt` separately.
- Compile `reference_intent.mode` into the request: reproduction asks for the declared protected attributes to match; guide limits influence to declared roles; editing uses the required `edit_source` as the original. User-declared instructions and boundaries have priority over inferred defaults and provider convenience.
- Keep original/reference paths, the current candidate path, and delivery dimensions distinct, including on follow-up turns. `manifest.canvas` records the agreed delivery size; never replace it with provider dimensions merely to pass inspection.
- Treat each planned `output_path` as a stable artifact binding. After an intentional deterministic transform, retain the original and provider output, record the new candidate in `raster_source`, and use that exact path for `project.inspect` and export. Otherwise reuse the provider output path verbatim; never substitute the edit source or guess a downstream path.
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
- A completed stable request id is reused without a new quote or provider call only within the same user turn. A pending or failed id remains closed in that turn and cannot be bypassed. A later user turn receives a fresh call scope even when it resumes the same project; do not treat earlier-turn exhaustion as current-turn exhaustion.

When returning a cost decision or execution handoff, keep the state machine
machine-readable: state whether dispatch is allowed, whether external billing
applies, project call slots consumed in the current turn, the exact next operation, and the
`generation.quote` recheck. Do not replace these fields with a vague prose
summary.

`project.status` may include a next-call quote using provider-default size and manifest reference count. Use it for orientation only; `generation.quote` must carry the exact request immediately before a direct call.

## Review loop

On a raster size mismatch, compare the inspected path and decoded dimensions with the current candidate and agreed canvas. Correct a wrong input path; if the candidate itself has the wrong size, use `image-compose` for a deterministic resize compatible with the protected content and aspect ratio, then inspect the new candidate. Do not stretch or destructively crop protected content to satisfy the gate; ask only if meeting the delivery size requires a real framing tradeoff.

After generation, call `image_studio` with `project.inspect`, passing the current raster path. It verifies file decoding, canvas and signature, and derives `is_generation` from the exact production record. For `is_generation:true`, it never requests quality scores and returns `project.export`: do not load `image-design-review`. Reference reproduction, semantic edits and set consistency still belong in the provider request and reference bindings before generation. After local authoring, inspect the new candidate and follow its returned next operation; an EDIT or GENERATE route does not exempt a composite from review.

Export the exact validated raster through `image_studio`. Never start another provider call based on an ImageStudio post-generation judgment. Spend a second generation only after an explicit user request or approval, and make it address the user's requested change rather than an internal variation search. A definite pre-dispatch failure is recorded but does not consume a generation call; a dispatched, terminal failure or `pending_uncertain` attempt still counts in the current turn. If the authorized repair budget is exhausted in that turn, use `project.status.current_candidate` and `recovery_context`: keep the best image visible, apply any useful deterministic zero-call repair, report the remaining finding, and end the turn. Never raise manifest `max_calls` or request a quota-increase form to bypass the same-turn limit. A later direct user message starts a fresh turn-scoped allowance automatically; never carry earlier-turn exhaustion forward or request extra authorization solely because that earlier turn used its calls. Ask the user only for a material intent/quality/reference/delivery tradeoff, using normal chat rather than a recovery form.
