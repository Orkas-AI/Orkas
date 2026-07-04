---
ownerAgent: 79df9cc89f5f
name: video-craft
description_zh: 做出「优秀视频」的创作 know-how——钩子/叙事节奏/视觉层级/字体安全区/动效缓动/字幕/音频配比/平台规范/镜头语言/生成 prompt 写作 + 出片前自检。每条产线动手前都先过这套标准,把「能渲染」拉到「真的好」。
description_en: The craft know-how that makes a video GOOD (not just rendered) — hooks, story pacing, visual hierarchy, type & safe zones, motion/easing, captions, audio mix, platform conventions, shot language, generation-prompt writing, and a pre-publish checklist. Apply it before producing on every line.
category: creation
---

# video-craft

The difference between a video that merely renders and one that's actually good. Apply these standards while scripting, storyboarding, composing, generating, and editing — and run the self-check before publishing. These are general production-craft norms; the exact numbers are starting points, adjust to the brief.

## 1. The opening (hook)

- The first **1–3 seconds** decide whether anyone keeps watching. Frame 1 must already carry motion or a text hook — no blank intro, no logo sting, no slow build.
- Strong hook shapes: a sharp question, a counter-intuitive claim, the promised outcome ("by the end you'll…"), the stakes, or showing the finished result first ("here's what we'll build").
- On muted autoplay the **on-screen text** is the hook — assume no sound for the first beat.
- *Weak → strong:* ✗ "In this video we'll look at caching." (slow build, no stakes) → ✓ frame 1, bold on-screen text "Your API is slow. One line fixes it." (stakes + promised outcome, readable muted).

## 2. Story structure

- Arc: **hook → tension/gap → core idea(s) → proof/example → payoff/close (+ optional CTA)**. Land the first real payoff early; viewers drop off fast before they get value.
- **One new idea per ~30–45 s** of explainer. A 3-min video carries 4–6 ideas, no more. Cut "interesting but irrelevant" — it actively lowers comprehension.
- Connect beats with **"but" / "therefore"**, not "and then" — force logical (not just sequential) progression.
- For teaching: show the naive idea, let it half-work, then break it and introduce the one key insight — people remember what they feel they discovered. Surfacing a common misconception first, then correcting it, beats stating the right answer cold.
- Narration cadence: explainer **~150–160 wpm**, social/short **~180–200 wpm**, cinematic **~140–150 wpm**. Leave a **1–3 s** silence after a big reveal; avoid dead air > ~1.5 s between sentences.

## 3. Pacing & timing

- Shot/scene holds by format: explainer **~4–8 s**, short-form social **~1–3 s**, cinematic/contemplative **~10–20 s**. Don't hold the same length three times running — vary it.
- Cutting energy: rapid (15–30 cuts/min) = urgency; moderate (8–15) = standard teaching; slow (3–6) = documentary calm.
- A visual or audio **pattern interrupt** every ~20–30 s (short-form) / ~45–90 s (long-form) to re-grab attention.
- Completion drops with length (15 s clips finish far more often than 60 s) — keep it as short as the message allows; don't pad.
- Build animation timing **to the narration words**, not arbitrary beats. Hold a fully-built scene/chart **≥ 2–3 s** before moving on.

## 4. Visual design

- Composition: rule-of-thirds for key elements; center for stable establishing frames. One clear focal point per frame.
- Palette: **≤ 3–5 colors on screen** at once. Background is the least-saturated; foreground (largest, most saturated, central) reads first.
- Typography: **1–2 font families** total. At 1080p, titles ~60–90 px, body ~40–60 px, **never below ~40 px**; title at least ~50% larger than body. Max ~2 lines, ~32–42 chars/line.
- **Safe zones**: keep text inside ~80% of the frame (~192 px margin at 1080p). For vertical, keep essential content out of the bottom ~300 px (platform UI sits there) and away from the very top.
- Contrast ≥ **4.5:1** for any text (white-on-dark is safest). Use brightness/saturation, not red-green, to distinguish elements.
- Consistency is a feeling of quality: one color grade/LUT, one type system, 2–3 transition types — for the whole video.

## 5. Motion & animation

- **Never linear easing** — it reads robotic. Default ease-in-out for moves, ease-out for entrances (settle in), ease-in for exits (accelerate away). Vary easing; don't repeat one three times.
- Restraint: **one main element moves at a time**; stagger multi-element reveals by ~100–200 ms. A "static" shot means truly zero motion/zoom — if it moves, name the move.
- *Weak → strong:* ✗ four cards fly in together, linear, all 0.3 s → ✓ stagger them ~120 ms, ease-out, each settling before the next starts (one focal point at a time).
- Entrances ~0.3–0.5 s then hold for readable dwell; exits ~0.5–1 s. Optional small overshoot (~10–15%, settle in a few frames) adds life for playful pieces.
- Kinetic type: reveal text to a readable dwell (~3 s per ~60 chars); word-by-word reveal synced to narration boosts attention.
- Transitions carry meaning: **hard cut** = same topic/new angle (most invisible, most professional); **crossfade** = gentle topic change; **wipe/slide** = sequential steps; **zoom in/out** = into detail / out to context. Pick a small set and keep them consistent.

## 6. Captions / on-screen text

- Most social viewing is **muted** — captions are mandatory and are part of the pacing, not an afterthought.
- Bold sans-serif, **≥ ~42 px**, ≤ ~2 lines, ≤ ~32–42 chars/line, with a dark stroke or semi-opaque backing for legibility on any footage.
- Don't scroll text off before it can be read (~3 s per ~60 chars). Word-by-word highlighting in sync with the voice reads best.
- Lower-thirds: speaker name bold + role lighter; enter ~1–2 s, hold a few seconds, exit fast; never cover eyes/mouth.
- Don't make the viewer read on-screen text AND listen to different words at once.

## 7. Audio

- Pick music by energy: calm ~60–80 BPM, standard explainer ~90–110, upbeat ~110–130, high-energy ~120–140+. Use **instrumental** under narration (lyrics fight the voice); avoid big crescendos that bury speech.
- Levels: narration peaks loudest; **duck music ~18–20 dB below speech**; SFX between. Master around **−14 LUFS**, true-peak ≤ ~−1 dB; never clip 0 dB.
- SFX land **~10–20 ms before** the visual change they accent (ears lead eyes). Keep stacked SFX in different frequency bands.
- Silence is a tool — drop music for a few seconds at a major reveal; let the moment land.

## 8. Platform & format

- Aspect: **9:16** (TikTok/Reels/Shorts), **16:9** (YouTube/web), **1:1** when speaker+context both matter, cinematic letterbox only when the look serves it. Don't center-crop a wide shot and call it vertical — reframe properly or downgrade to 1:1 honestly.
- Get past the **3-second** threshold: hook in frame 1, change something every 1–3 s in short-form, captions always.
- The **first frame is the thumbnail/promise** — make it match what you're delivering, and pay it off quickly.
- Match length to platform norms; the algorithm rewards watch-time/completion, not raw length.

## 9. Per-line craft — see the matching stage skill

The cross-cutting craft above (§1–§8, §10–§11) applies to every line. The **line-specific director judgment** lives with each line's mechanics in its stage skill — read the one for the line you locked:

- **Explainer / animation** → **stage-compose** (compose line).
- **Talking-head, cinematic** → **stage-generate** (generation line).
- **Social clip, podcast-repurpose, screen-demo, localization, documentary-montage** → **stage-edit** (editing line).
- **A finished video woven from the user's material + framing / voice / motion (more than one line)** → **stage-plan** + **stage-assemble** (AUTO end-to-end line) — the cross-source editorial judgment: deciding the spine source-agnostic, assigning each beat the right source, and engineering continuity across the seams.

If a piece layers lines (e.g. compose captions over generated footage), read both and apply the primary (locked) line's judgment first.

## 10. Shot & camera language (generation / cinematic)

- Move through shot sizes for flow: **wide (establish) → medium (develop) → close (emotion)**; avoid jumping wide-to-close without an intermediate.
- Design each shot as a **first frame → last frame**; the motion bridges them. Each frame is a **static snapshot, never an action in progress** ("sitting, leaning forward", not "about to stand up"); the last frame is the logical result of the first frame + the motion. Big composition changes need an explicit camera move; small changes (expression, slight pose) stay in one framing.
- **Reuse camera positions**; only introduce a new one when size/angle/focus genuinely changes. Keep relative positions stable across cuts (if a subject was left, keep them left); for two people talking, an over-the-shoulder pair plus a wider two-shot keeps geography clear.
- Keep narrative/teaching shots steady and deliberate; reserve handheld / fast cuts / rapid zoom for action.

## 11. Generation-prompt writing

- Describe by **concrete visual features**, never by abstractions: "forest-green canvas jacket, short curly black hair" — not "professional, friendly". Adjectives like "warm" or "premium" don't constrain pixels; show them through appearance, light, and posture. Name the visual **cause** of a feeling, not the feeling ("wide aerial pull-back, lone figure against the rising sun", not "epic"); if you can't picture a specific photograph from the words, neither can the model.
- *Weak → strong:* ✗ "a professional, friendly host in a modern office" → ✓ "woman, mid-30s, short black bob, charcoal blazer over white tee; sunlit open-plan office; soft window key from camera-left." Every adjective replaced by something the renderer can actually draw.
- Specify **lighting + color temperature + style** (soft daylight / harsh noon / warm key; realistic vs cinematic) to anchor tone across shots.
- For a shot, include shot size, (optional) lens feel (24/50/85 mm), camera move, and **which reference image governs which element** ("face from ref A, environment from ref B"). See the consistency skill for the character-bible + reference-selection method.

## 12. Pre-publish review pass

This is a **review**, not a checkbox sweep — read the draft as a skeptic hunting for what's wrong. Every issue you raise must name **where** and **the concrete fix** (change what, to what); if you can't name a fix, it isn't a finding yet — mark it "verify" and go look, don't leave a vague worry. Tag each finding:

- **blocker** — ship-stopping (unreadable text, wrong aspect, missing hook, identity break, clipping audio). Fix before the final render.
- **fix** — clearly hurts quality but not ship-stopping; fix unless out of scope.
- **polish** — nice-to-have; note and move on.

### Slideshow-risk gate (run before the high-quality render)

The most common failure of generated/composed video is that it quietly degrades into a slideshow — stills with captions, no real motion or intent. Score the draft **0** (clean) / **1** (some) / **2** (bad) on each; treat any **2**, or an overall "this reads as a slideshow", as a **blocker**:

- **Dead motion** — shots sit still: no camera move, build, or designed motion where the format wants it.
- **Repetition** — same shot size / scene type / transition ≥ 3 in a row.
- **Decoration** — motion or effects that carry no meaning (movement for its own sake).
- **Promise drift** — a motion/cinematic brief silently delivered as static cards (see the routing lock).
- **Text crutch** — walls of on-screen text doing the job the visuals should be doing.

### Then confirm (each line = where a finding hides)

- **Readable** — text ≥ the legibility floor (~40 px at 1080p, scaled to the canvas) and ≥ 4.5:1 contrast; captions synced; nothing covers the face/critical content; readable at phone size.
- **Timed** — hook lands in the first seconds; first payoff early; pattern interrupt on cadence; each scene held long enough to read; narration wpm fits the format.
- **On message** — the core point is actually stated; visuals reinforce (not fight) the narration; no padding/dead time; exact text correct (no hallucinated stats).
- **Consistent** — one grade, one type system, a small transition set; subject identity preserved across cuts.
- **Audio** — speech clear and loudest; music ducked; SFX slightly lead the cut; ~−14 LUFS integrated, true-peak ≤ ~−1 dBTP, no clipping/pops; silences intentional.
- **Platform** — text in safe zones; correct aspect; length in range; first frame matches the promise.
