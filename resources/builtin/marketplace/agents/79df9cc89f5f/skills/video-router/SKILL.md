---
ownerAgent: 79df9cc89f5f
name: video-router
description_zh: 视频制作的产线路由与运行时锁定知识——按创意简报选「生成/合成/剪辑」能力轴并锁定主路径，开工前定调，避免中途无声切换。
description_en: Routing + runtime-lock knowledge for video production — pick the generate/compose/edit capability axis from the brief and lock the main path before work starts.
category: creation
---

# video-router

Host-neutral knowledge for picking a video production line and locking it before work begins. This skill is read for guidance; it describes **what to decide**, not any host's tool mechanics.

## The three capability axes

A finished video is built from one or more of three orthogonal axes. Decide which dominate, then lock them.

- **Generate (A)** — AI-generated footage/imagery: photoreal shots, b-roll, motion, talking-head. Use when the brief needs real-looking or cinematic visuals.
- **Compose (B)** — deterministic HTML composition: explainers, kinetic typography, motion graphics, captions / lower-thirds / overlays, data viz, title cards, transitions. Use when the visuals are designed rather than filmed. This is the default for explainer/animation work.
- **Edit (C)** — real-footage editing: cut / join / transitions / mix / reframe / burn-in subtitles, plus highlight selection. Use only when the user supplies source footage to cut.

## Decision rules

1. Read the brief (topic, aspect ratio, language, duration) and classify the **dominant work object**:
   - "explain / teach / animate / motion-graphics / kinetic text" → **Compose (B)** primary, optionally Generate (A) for b-roll.
   - "make footage of / cinematic / a scene of / a character doing" → **Generate (A)** primary, Compose (B) to overlay captions.
   - "cut / clip / trim / repurpose my video / make highlights from this recording" → **Edit (C)** primary.
2. Most explainer/animation requests are **Compose-primary**: typographic and motion-graphic scenes assembled as an HTML composition, with AI imagery only where a shot genuinely needs it.
3. Aspect ratio drives the canvas: 16:9 → 1920×1080, 9:16 → 1080×1920, 1:1 → 1080×1080.

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

## Boundary / non-goals

This skill only routes and locks. It does not author compositions (see the composition-authoring skill) and does not itself produce assets or render output.
