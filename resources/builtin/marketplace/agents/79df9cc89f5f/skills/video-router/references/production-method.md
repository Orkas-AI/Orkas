# Production method and current-video checks

## Decide before deep reference analysis

Users describe an outcome, not HTML or a provider. Use the requested changes,
reference availability/type/duration/canvas and a light look when needed to
choose the method. A representative frame or supplied thumbnail can distinguish
filmed action from designed typography; it does not establish every shot or word.
Do not transcribe or densely sample a reference merely to make this decision.

Realistic subject action, camera movement, atmosphere, or a semantic pixel edit
usually calls for a video model. Precisely editable copy, prices, diagrams,
layout, or timed overlays calls for composition or deterministic editing. A
reference can lead to either. For “recreate this with my product”, preserve the
requested commercial idea and visual relationship; choose from these constraints,
not the word “recreate” alone. Ask only when a missing fact changes the outcome.

Record `is_generation` in the current video's ingest notes once the method is
known; before then it is unknown, not an exemption. Keep those notes scoped to
that video's workspace and revise them when its requested output changes. This
does not require an EDL before the existing direction choice. Once the canonical
EDL exists, store the advisory value at `project/plan.json::_runtime.is_generation`.
Read `production.status.production_control.is_generation` for its authoritative
value: the host derives it afresh from this plan's executable operations alongside
its `plan_signature`, ignoring stale annotations. This classifies the plan; only
a delivery check bound to the recorded artifact establishes the delivered version.
An unbound file has unknown generation provenance. COMPOSE is always false.

- **true:** one video-model output is the finished video, including semantic
  `operation:"edit"` on the EDIT route. Input image/video preparation and real
  reference bindings do not turn it into local assembly.
- **false:** HTML, deterministic edits, multiple clips joined together, or local
  captions, overlays, independent narration/music or other output processing.
  Every EDL layer participates in the output; do not disguise a reference-only
  asset as an overlay/background layer. Existing input references stay inputs.

The flag applies to this video's current version, not its original source,
provider, route name, project or chat. Re-evaluate when work changes; a generated
clip later receiving local captions is false while its completed source is reused.
Do not carry the flag into another video's workspace or use an old status after
changing the plan. It changes analysis and QA depth, never authorization.

## Reference depth

For **true**, pass the actual accessible reference images/videos to the video
model using the signed reference arrays. State their roles, what to preserve and
what to change, and the output request. A whole-clip temporal anchor from probe
metadata is sufficient when the whole clip is the reference. Do not add shot
decomposition, dense frame extraction, transcript, or a reconstruction report.
Do not claim unseen details. Missing required media still blocks its dependent
call; a textual “see reference” is not a media binding.

For **false** and reference-led creative work, read
[reference-recreation.md](../../video-craft/references/reference-recreation.md)
and turn the relevant observations into executable design/timeline decisions.
An exact known-timecode cut needs its source probe and requested interval, not a
creative reconstruction exercise.

## Review before delivery

Read the current flag **before** choosing checks. For true, confirm provider task
success and an existing readable video stream through `production.status` with
`delivered_video_path`. Do not add creative scoring, reference/product-fidelity
inspection, transcription, dense frame QA, loudness normalization or repair loops.
Validate supported request settings before dispatch through the existing provider
contract; explain unsupported requirements and amend the plan through existing
gates rather than silently substituting them. A usable return with a different
duration or canvas can be delivered with the observed difference stated. Do not
automatically trim, stretch, crop or regenerate it. A broken/unreadable return is
a delivery failure; retain transaction evidence and use existing recovery rules.

For false, validate the actual local operations: HTML, cuts/joins, caption text
and placement, timing, and audio mixing as applicable. A mixed production does
not authorize creative reinspection or regeneration of model-produced pixels;
inspect the local integration and reuse the model source. Existing plan, paid
generation and final-review decisions remain owned by gate-control; the flag
does not add a review stop or permit another billable call.
