---
ownerAgent: 79df9cc89f5f
name: stage-consistency
description_zh: 多镜头叙事/角色一致性方法——角色档案(锁定正面肖像锚点)、按机位选参考图、近邻帧 carry-forward、Cameo(上传照片当主角)、长剧本/小说全局规划；让同一角色跨镜头跨场景外观一致。
description_en: Multi-shot narrative & character consistency — a character bible with a locked front-portrait anchor, view-matched reference selection, recent-frame carry-forward, Cameo (a user photo as the lead), and global planning for long scripts/novels; keeps a character looking the same across shots and scenes.
category: creation
---

# stage-consistency

How to keep characters, settings, and style **consistent across many generated shots** (and across scenes in a long story). This is the depth layer on top of the generation line: the generation line makes clips; this skill makes the SAME character look the same in every clip. Host-neutral — describe the outcome; use generic built-in capabilities for generation/retrieval (Orkas: `generate_image`, `generate_video`, `kb_*`) and VideoStudio skill scripts for media extraction (`stage-edit edit_video --op extract_frame` via `bin/run-skill.cjs`).

## 1. Character bible (extract once, lock the look)

From the script/idea, extract every recurring character into `project/characters/bible.json`. For each character separate:

- **static features** — the *immutable* visual identity: face, hair, body shape, ethnicity, age range. These NEVER change shot-to-shot.
- **dynamic features** — changeable: clothing, accessories, expression.
- a single **canonical name** (merge every alias/pronoun for the same person to one id).

```json
{
  "alice": {
    "static": "early-20s East-Asian woman, oval face, long black hair, slim build",
    "dynamic": "green linen dress, small gold earrings",
    "portrait": { "front": "characters/alice_front.png", "side": "characters/alice_side.png", "back": "characters/alice_back.png" }
  }
}
```

## 2. Portrait anchor (generate once, then LOCK)

For each character, generate ONE **front portrait** (full-body, front view, plain background) from its static+dynamic features with `generate_image`. **This is the anchor — never regenerate it.** Derive side/back views by reference-image editing the front portrait (so all three views are the same person). Save paths into the bible.

- **Cameo** (the user uploads a photo to BE a character): use that photo AS the front portrait — skip generation for that character. Everything downstream references it.

## 3. Storyboard with character binding

Decompose the script into shots. Each shot records:

- which characters are visible (and at what camera angle — front / side / back),
- a first-frame description and the motion,
- **describe motion by VISUAL FEATURES, not names** — write "the figure in the green dress turns to the figure in the blue shirt", NOT "Alice turns to Bob". (Generators ground on appearance, not names.)

## 4. Per-shot reference selection (the core consistency mechanism)

For each shot, before generating it, assemble the reference images and bind them explicitly:

1. **Candidates** = for every visible character, the portrait view that MATCHES the shot's camera angle (front shot → front portrait, profile → side portrait) **plus** the most recent already-generated frame that shares this scene/camera.
2. **Priority**: a recent prior frame of the same camera > an older frame > portrait-only; same-camera > different-camera. Keep relative positions (if a character was on the left, keep them on the left). Don't pick two references that show the same face.
3. **Explicit binding**: write a generation prompt that maps each reference to what it's for — "ref 1 (front portrait) → facial features & hair; ref 2 (previous frame) → lighting & background".
4. Generate the shot with `generate_video` **image-to-video** using those reference images.

## 4b. Verify the keyframe BEFORE you pay to animate

For a character-critical shot, generate the **first-frame image** first (cheap), check it, and only then drive the video from that locked frame — catching drift at the still is far cheaper than discovering it after paying to animate.

- **Check the keyframe against the bible** on the identity axes, in priority order: 1) character — gender, age, ethnicity, facial features, body shape, hairstyle; 2) spatial — relative positions/perspective match the reference (left stays left); 3) accuracy — matches the shot's description. Read it yourself if multimodal; if you cannot see images, mark it unverified and lean harder on a strong locked reference.
- **Re-roll the cheap image**, not the expensive video, until it matches; generate a few candidates and keep the most consistent one. Never hard-fail — pick the best and note its shortcoming.

## 5. Carry-forward (continuity between shots)

After a shot is generated, pull its representative frame with `stage-edit edit_video --op extract_frame` (e.g. its last frame) into `project/frames/`. That frame becomes a high-priority reference for the NEXT shot in the same scene — this is what carries lighting, composition, and the exact current look forward, so drift doesn't accumulate.

**Cache the decision, not just the pixels.** Record each shot's chosen references + the binding prompt (e.g. in the plan/segment) alongside the produced frame. A resumed run then reuses the SAME references and prompt and reproduces the same frame, instead of re-rolling the selection and silently drifting from the earlier run.

## 6. Long script / novel → movie (global planning first)

For long-form, plan globally BEFORE generating:

1. Chunk the source; for a very long novel, index it (`kb_*`) and retrieve the relevant chunks per event instead of holding it all at once.
2. Extract **events → scenes**; extract characters per scene.
3. **Merge characters** so the bible is global: same person across scenes → one entry (track the name variant each scene uses); same name but conflicting static features (e.g. a child vs. the adult years later) → split into two characters. New character → append.
4. Carry the ONE global bible (locked portraits) through every scene, so a character looks identical across the whole story.

## Default scope caps (cost control)

A story multiplies billable calls (portraits per character + clips per shot + carry-forward frames). Default bounds unless the user explicitly asks for more: **≤ 3 characters**, **≤ 3 scenes**, **≤ 6 shots total**. Above these, state the full count + the rough number of billable image/video generations in the approval-gate proposal and get the user's explicit OK before generating anything.

## Rules & boundary

- **The anchor is sacred**: a character's front portrait is generated once and reused; never silently regenerate it (that's how looks drift).
- **Cost discipline**: portraits + per-shot generation are billable; state the exact character/shot counts in the approval-gate proposal and never start generating before the user approves.
- This skill is the consistency METHOD; it does not itself author HTML (composition skill) or cut user footage (editing skill). It sits on top of the generation line.
