---
ownerAgent: 79df9cc89f5f
name: video-router
description_zh: 视频制作的产线路由与运行时锁定知识——按创意简报选「生成/合成/剪辑」能力轴并锁定主路径，开工前定调，避免中途无声切换。
description_en: Routing + runtime-lock knowledge for video production — pick the generate/compose/edit capability axis from the brief and lock the main path before work starts.
category: creation
---

# video-router

Host-neutral knowledge for picking a video production line and locking it before work begins. This skill is read for guidance; it describes **what to decide**, not any host's tool mechanics.

## Unavailable production runtime

If the current system explicitly says that production tools, rendering, or
paid operations are unavailable, routing still must produce useful work. For a
clear or safely default-filled brief, select and state the line, then continue
in the same response with a complete **unexecuted production package**:
assumptions, script/narration, timed storyboard or shotlist, on-screen
copy/captions, visual and audio direction, provenance/fallback assets, export
target, preview-review checklist, and final QA checklist. Do not stop at a
plan-confirmation form and withhold the package. Clearly distinguish
planned files/media from produced files/media, and reserve future confirmation
only for an operation the unavailable runtime would actually execute.
Do not title the package “Production plan confirmation”. Make every timed scene
production-usable with narration, exact visible copy/caption, visual action,
and edit/transition instruction.
For a narrated package, include the full verbatim caption line for every
narration line; a short scene headline is additional on-screen copy, not a
substitute for captions. Final QA must explicitly probe the produced file and
verify it can be opened and played through after encoding, in addition to
checking dimensions, duration, nonblank frames, captions, safe zones, and audio.
The package language follows an explicit deliverable language in the request;
otherwise it follows the current User UI language, with English only as the
unsupported-or-unavailable fallback. Apply that language consistently to
narration, exact on-screen copy, and captions even when benchmark or transport
instructions are written in another language.

## The three capability axes

A finished video is built from one or more of three orthogonal axes. Decide which dominate, then lock them.

- **Generate (A)** — AI-generated footage/imagery: photoreal shots, b-roll, motion, talking-head. Use when the brief needs real-looking or cinematic visuals.
- **Compose (B)** — deterministic HTML composition: explainers, kinetic typography, motion graphics, captions / lower-thirds / overlays, data viz, title cards, transitions. Use when the visuals are designed rather than filmed. This is the default for explainer/animation work.
- **Edit (C)** — intelligent editing of supplied footage: evidence-based selection/cleanup, deterministic cut/join/reframe/captions/audio work, and semantic AI video editing when the user requests a pixel-level change that timeline operations cannot make.

## Decision rules

1. Read the brief (topic, aspect ratio, language, duration) and classify the **dominant work object**:
   - "explain / teach / animate / motion-graphics / kinetic text" → **Compose (B)** primary, optionally Generate (A) for b-roll.
   - "make footage of / cinematic / a scene of / a character doing" → **Generate (A)** primary, Compose (B) to overlay captions.
   - "cut / clip / trim / repurpose / make highlights / remove or change something in my video" → **Edit (C)** primary. Keep EDIT as the route even when one billable `operation:"edit"` video-model segment is required.
2. Most explainer/animation requests are **Compose-primary**: typographic and motion-graphic scenes assembled as an HTML composition, with AI imagery only where a shot genuinely needs it.
3. For supplied reference media, classify the requested relationship before choosing execution: `reproduce`, `edit`, or `guide`. Apply the same classification to images and videos regardless of which app, model, camera, or authoring format produced them. Images can control content/identity/composition/structure/style; videos can additionally control motion/timing/audio through temporal anchors.
4. Aspect ratio drives the canvas: 16:9 → 1920×1080, 9:16 → 1080×1920, 1:1 → 1080×1080.

## End-to-end (AUTO) — when the job spans lines

Pick a **single line** when one axis cleanly dominates (just trim a clip; just an explainer; just generate a scene). Route to **AUTO end-to-end** when the deliverable genuinely needs MORE THAN ONE axis woven together — most often the user supplies their own material AND wants finished framing/voice/motion around it:

- "trim my clip, add a title card + captions, and a voiceover" (edit + compose + narration)
- "my footage in the middle, generate an opener, compose the stats" (edit + generate + compose)
- "make a finished video from these assets" where the assets alone are not the deliverable.

AUTO does not abandon the axes — it sequences them through one cross-modal plan (`stage-plan` builds the EDL, `stage-assemble` walks it), delegating each segment back to the generate / compose / edit lines. Choosing AUTO is itself the lock: the *primary* still gets named via the plan's `delivery_promise` (source_led / motion_led / compose_led / hybrid).

## Lock the runtime

- Decide the primary axis at the brief/proposal stage and **state it in the proposal**.
- Once locked, do not silently switch the primary axis mid-run. If a later step reveals the wrong choice, surface it to the user and re-confirm rather than quietly changing course.
- Layering is fine and expected (e.g. Compose captions over Generated footage); "locking" governs the **primary** path, not the allowed overlays.

## Runtime handoff

When the production runtime is available, routing ends at the direction
boundary, not at a production plan. For a Chinese UI, use the exact gate-control
title `制作方向确认` (never `创意方向确认`) and show only two or three direction
concepts plus the facts already locked by the brief. Do not write a manifest,
script, narration copy, or art direction before that choice.

## Boundary / non-goals

This skill only routes and locks. It does not author compositions or execute edits. Semantic editing is not a silent switch to GENERATE: it remains an EDIT/AUTO job whose EDL contains a signed, billable video `operation:"edit"` segment with the original reference video and preservation boundary.
