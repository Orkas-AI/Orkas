---
ownerAgent: 79df9cc89f5f
name: stage-generate
description_zh: AI 生成视频线的知识——口播/数字人、电影感/AI b-roll：用形象图 + 图生视频保镜头内一致、按分镜逐镜生成再组装成片；「生成为主」产线的核心。
description_en: Knowledge for the AI-generated-footage line — talking-head / avatar and cinematic / AI b-roll: a character still + image-to-video for in-shot consistency, generate per shot, then assemble; core of the generation-primary line.
category: creation
---

# stage-generate

How to produce a video whose **primary visuals are AI-generated footage** — as opposed to designed HTML graphics (composition skill) or cutting the user's real footage (editing skill). Host-neutral: describe the outcome; use generic built-in generation/speech capabilities — in Orkas `generate_image` (stills), `generate_video` (clips; supports image-to-video and built-in audio), `generate_speech` (narration) — and assemble through the VideoStudio `stage-edit edit_video` skill script. VideoStudio's billable image/video calls are host-controlled: every call belongs to a signed `project/plan.json` generate segment and carries `production_plan_path` plus `production_segment_id`.

## Pattern A — talking-head / spokesperson (口播 / 数字人)

1. **Character still:** generate one image of the presenter / avatar with the intended look. **Keep this reference image** and reuse it for every shot of the same character.
2. **Bring it to life:** generate a video *from* that image (image-to-video). When the provider returns speech + **built-in audio**, that audio is the deliverable voice — it is **lip-synced to the mouth in the clip** — so keep it and do NOT synthesize a separate narration. Only when the clip comes back **silent** do you synthesize the narration (`generate_speech`) and add it as the audio track. Synthesizing a fresh TTS track over a clip that already speaks is the #1 talking-head defect: the new audio has different wording/timing/length, so the voice no longer matches the lips.
3. **Polish:** add captions / a lower-third / a hook by authoring a small composition (composition skill) and overlaying it onto the clip — **visual-only**. Preserve the clip's own (lip-synced) audio through assembly; a captions composition must not carry a narration `<audio>` track that would replace the clip's voice.

## Pattern B — cinematic / AI b-roll montage

1. **Storyboard** the shots (each: prompt, camera motion, duration).
2. **Generate each shot** (one generate-video call per shot; reuse a shared reference image / consistent style prompt for visual continuity).
3. **Assemble:** concatenate the shots in order, add transitions, and overlay a title / captions from a composition.

## Consistency (basic — deep consistency is a later capability)

- **Within a shot:** drive the clip from a reference image (image-to-video) to lock the subject.
- **Across shots:** reuse the **same** reference image / style prompt.
- Full multi-shot character consistency, Cameo (upload-a-photo-as-the-lead), and long-narrative planning are a separate, more advanced capability — out of scope here.

## Director judgment (generation line)

Craft calls specific to AI-generated footage, on top of the shared craft reference (video-craft):

**Talking-head / spokesperson**
- Understand what's said before placing overlays; time graphics to the spoken words.
- **3–6 overlays/min**, varied types; keep them in speaker-safe zones — never over the face.
- Cut silences and filler; for vertical, keep subtitles low so they don't cover the face.

**Cinematic / AI b-roll**
- Open on a hero frame; keep a small transition palette (cut / fade-to-black / slow dissolve / restrained push-in).
- Protect earned moments — don't over-cut a held look or a deliberate silence.
- Design each shot first-frame → last-frame and let audio dynamics carry momentum (shot language: video-craft §10; identity across shots: stage-consistency).
- **Frames are static snapshots, never an action in progress** (`video-craft` §10); in motion / last-frame text, name characters by visible features, not names (the model conditions on pixels, not labels).
- **Spend keyframes by how much the shot changes (cost gate).** If a shot's start and end look nearly the same — a talking head, a small pose/expression change, a gentle pan — it needs only ONE keyframe and motion fills the rest (variation_type `small`). Only a shot that ends somewhere visually different — a new subject enters, a wide→close transition, a big camera move — needs TWO keyframes for the model to interpolate (`medium` / `large`). Don't pay to generate an end-frame you don't need.

## Default scope caps (cost control — do not exceed without explicit user request)

Generated clips and images are **billable hosted calls**, so bound the run by default:

- **Shots / clips: ≤ 6** per video.
- **Characters: ≤ 3** per video.
- **One aspect ratio** per run.

If the brief seems to need more (a long story, many scenes, many characters), DO NOT silently fan out — state the larger count + the rough number of billable generations in the approval-gate proposal and let the user opt in first. Treat anything above these caps as requiring explicit confirmation.

## Rules

- **Cost/time discipline:** every generated clip is a hosted, billable, multi-second call. State the exact shot/character count in the approval-gate proposal; never start generating before the user has approved the count.
- **Native Gate C:** after Gate B calls `production.approve_plan`, call `production.status` and show one `gate_c_decision` form for the exact generate-segment count and configured external provider. State that provider billing and balance cannot be verified locally. In its later approval turn call `production.approve_generation` before dispatching. A provider call without the current plan/segment signature is rejected; a completed transaction is reused. A `pending` transaction after interruption is uncertain: `production.status` cannot query the provider, and the current Gate C approval cannot dispatch it again. Report the uncertainty; if the user still wants another paid attempt, open a fresh Gate C and require a new output path. A failed attempt likewise requires a new explicit Gate C. Never invent a transaction-recovery provider call.
- **Exact settings:** each video segment's EDL spec fixes `media_kind`, prompt, `operation:"generate"|"edit"`, every reference path/URL, top-level plan aspect, `generation_duration_sec`, resolution, quality, and `generate_audio`. Never substitute `text_to_video`, `duration_sec`, or `audio`; those aliases are rejected. Each image/portrait/keyframe is also a distinct `media_kind:"image"` segment whose size and references are signed and has no operation. Do not add, remove, reorder, or change those values between Gate C and the provider call.
- Opening a fresh Gate C is a gate-only turn: make no host or generation call after presenting it. Only the later explicit approval turn calls `production.approve_generation`, then retries with a new output path.
- **Audio (talking-head):** a generated talking-head clip's built-in audio is **lip-synced** to its mouth. Treat it as the final voice: keep it through assembly and finalize. NEVER add or mux a separately-synthesized narration over a clip that already speaks — it desyncs from the lips. Synthesize narration ONLY for a silent clip, or for b-roll / off-screen voiceover where no mouth is visible.
- **Brief drives params:** pass the requested aspect ratio and per-shot duration to each generation call.

## Boundary / non-goals

Generation line only. Designed HTML / kinetic-typography graphics → composition skill; cutting/joining real user footage → editing skill; deep narrative & character consistency → a later capability.
