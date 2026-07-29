---
ownerAgent: 79df9cc89f5f
name: stage-generate
description_zh: AI 生成视频线的知识——口播/数字人、电影感/AI b-roll：用形象图 + 图生视频保镜头内一致、按分镜逐镜生成再组装成片；「生成为主」产线的核心。
description_en: Knowledge for the AI-generated-footage line — talking-head / avatar and cinematic / AI b-roll: a character still + image-to-video for in-shot consistency, generate per shot, then assemble; core of the generation-primary line.
category: creation
---

# stage-generate

How to produce AI-generated footage and how to execute a **bounded semantic video edit** already planned by the EDIT/AUTO workflow. Designed HTML remains composition work; deterministic cutting remains stage-edit work. In Orkas use `generate_image`, `generate_video`, and `generate_speech`, then assemble through `stage-edit`. Every billable call belongs to a signed `project/plan.json` generate segment and carries `production_plan_path` plus `production_segment_id`.

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
- **Dispatch boundary:** distinguish a provider attempt from a local failure before dispatch. Literal native evidence `request_disposition:"not_sent"` plus `charge_status:"not_charged"` means no provider attempt exists. If the signed segment intent, authorization, and output path are unchanged, repair the concrete local input/serialization defect and call the original `generate_video`/`generate_image` segment once under the persisted authorization; do not open a fresh Gate C. Only `sent`, `unknown`, `charged`, or an unreconciled provider transaction enters the fresh-paid-attempt path above. Preserve every completed sibling transaction in either case.
- **Do not predict provider success:** a control/planning response that has not received the retried provider result stops at that exact provider call and opens no Final confirmation. In an actual tool-enabled turn, a successful returned shot may continue immediately through complete montage assembly and parent QA; only the resulting current review artifact's real path, signature, and passing QA may open Final video confirmation. A failed/unknown result preserves siblings and transaction evidence instead. Never list a Final gate from a hypothetical future montage or omit parent QA between assembly and that gate.
- **Partial batches and shot revisions:** treat each signed generate segment as an independent durable transaction. If two shots completed and one is pending, failed, or revised, preserve and show the two completed shots; never redispatch them or roll their cost into a new approval. A user change to one shot invalidates only that shot's plan/quote/paid authorization plus downstream assembly evidence. After the bounded plan amendment, request a fresh quote and paid-generation confirmation for the changed segment only, use a new output path, then rebuild the complete current montage. The new review artifact must contain the preserved shots and the new shot; an approval of an older montage cannot authorize it.
- **Exact settings:** each video segment's EDL spec fixes `media_kind`, prompt, `operation:"generate"|"edit"`, every reference path/URL, top-level plan aspect, `generation_duration_sec`, resolution, quality, and `generate_audio`. Never substitute `text_to_video`, `duration_sec`, or `audio`; those aliases are rejected. Each image/portrait/keyframe is also a distinct `media_kind:"image"` segment whose size and references are signed and has no operation. Do not add, remove, reorder, or change those values between Gate C and the provider call.
- **Semantic edit boundary:** `operation:"edit"` requires a top-level video reference with `intent:"edit"`, target-segment and temporal anchors, plus `edit_strategy.mode:"semantic"|"mixed"`. The prompt may change only `may_change`; identity, content, motion, timing, and audio in `preserve` remain explicit. Never turn an edit into an unconstrained regenerate call.
- When `gate-control` returns a fresh paid-attempt review, stop after presenting it. A later authorized retry must use a new output path.
- **Audio (talking-head):** a generated talking-head clip's built-in audio is **lip-synced** to its mouth. Treat it as the final voice: keep it through assembly and finalize. NEVER add or mux a separately-synthesized narration over a clip that already speaks — it desyncs from the lips. Synthesize narration ONLY for a silent clip, or for b-roll / off-screen voiceover where no mouth is visible.
- **Brief drives params:** pass the requested aspect ratio and per-shot duration to each generation call.

## Boundary / non-goals

Generation-primary work uses this skill directly. EDIT/AUTO may invoke it only as the executor for an already approved semantic edit segment; route ownership, source analysis, preservation boundaries, and final assembly remain with the edit plan. Designed HTML goes to composition; deterministic cuts/joins go to stage-edit.
