---
ownerAgent: 79df9cc89f5f
name: stage-compose
description_zh: HyperFrames HTML 视频合成的编写知识——如何写一个 composition（index.html）、用时间线驱动动画、声明画幅与时长，再渲染成 mp4；解说/动画/动态图形/字幕叠加的核心技能。
description_en: Authoring knowledge for HyperFrames HTML video compositions — how to write an index.html composition, drive animation from a timeline, declare canvas + duration, then render to mp4; core skill for explainer/animation/motion-graphics/caption work.
category: creation
---

# stage-compose

How to author a **HyperFrames** HTML composition and turn it into a video. Host-neutral: this skill describes the artifact you produce and the outcome you want (a rendered mp4). In Orkas, render and QA run through the `stage-compose render_composition` skill script, not a direct tool call.

## How to call the render script

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-compose render_composition -- --op inspect --composition-dir project/composition
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-compose render_composition -- --op lint --composition-dir project/composition
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-compose render_composition -- --op render --composition-dir project/composition --output project/render/draft.mp4 --quality draft
```

The script returns JSON. A non-zero exit means the composition must be fixed before continuing.

## Composition contract (the minimum that renders)

A composition is a directory with an `index.html`. The renderer reads these `data-*` attributes; get them right or the render is wrong.

- The **root** element declares the timeline: `data-composition-id="main"`, `data-start`, `data-duration` (seconds), `data-width`, `data-height` (px).
- Each **clip** is a child with `class="clip"` and its own `data-start`, `data-duration`, `data-track-index` (higher index = drawn on top).
- A paused **GSAP timeline** registered on `window.__timelines["main"]` drives all animation; the renderer seeks it frame by frame. Never use real-time animation (`setInterval`, CSS `animation`) — only timeline-driven motion renders deterministically.

Canonical minimal `index.html` (16:9, 10s):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1920, height=1080" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1920px; height: 1080px; overflow: hidden; background: #000; }
      body { font-family: "Inter", sans-serif; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="10" data-width="1920" data-height="1080">
      <div id="title" class="clip" data-start="0" data-duration="5" data-track-index="1"
           style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#fff; font-size:96px">
        Hello World
      </div>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      tl.from("#title", { opacity: 0, y: -50, duration: 1 }, 0)
        .to("#title", { opacity: 0, duration: 0.5 }, 4.5);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
```

## Authoring patterns

- **Canvas per aspect ratio**: 16:9 → 1920×1080, 9:16 → 1080×1920, 1:1 → 1080×1080. Set the same values in the viewport meta, the body CSS, and the root `data-width`/`data-height`.
- **Scenes**: one clip (or a group) per storyboard shot; set each clip's `data-start`/`data-duration` from the shot list so the timeline sums to the brief's duration.
- **On-screen text**: keep it inside the frame with padding; large, high-contrast type; one idea per scene.
- **Assets**: reference images/footage produced upstream by relative path inside the composition dir (e.g. `./assets/shot1.png`).
- **Timing**: position every tween on the GSAP timeline with an explicit time so it is reproducible; the total of `data-duration` on the root is the final length.

## Narration / audio track

**WHO OWNS NARRATION — decide this first:**
- **Standalone COMPOSE deliverable** (the composition IS the finished video, no assemble step): embed the narration as an `<audio>` track here; the renderer muxes it. Single add — correct.
- **Composition is a SEGMENT in an AUTO/assemble pipeline** (the assembler will mix narration in its mix tier — `stage-assemble` step 3): render this composition **SILENT — do NOT add a narration `<audio>` track**. If you bake narration in here AND the assembler mixes it, narration is added twice and you get two overlapping, drifting voices (the "two voices" defect). The mix step now refuses a non-silent base (`E_EDIT_BASE_HAS_AUDIO`) precisely to catch this. Background music inside the composition is also best left to the assembler so it can duck consistently under the one narration.

To give a STANDALONE explainer a voiceover: synthesize the narration to an audio file (the host provides a text-to-speech step — in Orkas the `generate_speech` tool, which writes mp3/wav into `project/assets/`), then add it as an **audio track** in the composition. The renderer muxes audio tracks into the output.

```html
<audio id="narration" src="./assets/narration.mp3"
       data-start="0" data-duration="60" data-track-index="0" data-volume="1"></audio>
```

- Place the `<audio>` inside the root composition div. `data-duration` should cover the spoken length; size the scene timing to the narration, not the other way around.
- For background music plus voiceover, use two `<audio>` tracks with different `data-track-index` and lower the music `data-volume` (e.g. 0.2).
- Keep narration audio inside the composition dir so the render is self-contained.
- **Talking-head caveat:** when this composition is being overlaid onto AI-generated talking-head footage that already has **lip-synced built-in speech** (generation line), do NOT add a narration `<audio>` track. The renderer's muxed audio replaces the clip's own voice, so a synthesized narration would desync from the mouth. Use this composition for captions / lower-thirds only and let the clip's built-in audio stand (background music at low volume is fine; spoken narration is not).

## Render (the outcome)

Produce the finished video by rendering the composition **directory** to an mp4. Iterate at draft quality, then do one high-quality pass once the layout and timing pass review. (Orkas: `stage-compose render_composition --op render` with the composition dir and an output path.)

## Director judgment (compose line)

Craft calls specific to designed/animated explainers, on top of the shared craft reference (video-craft):

- **One concept per visual chapter** — don't stack two ideas in one scene; give each its own build.
- **Concrete before abstract** — real data, diagrams, steps before a metaphor; the metaphor only lands once the concrete version is understood.
- **Render exact text as real text** — stats, names, CTAs are typed into the composition, never baked into AI imagery (which hallucinates numbers and can't be corrected).
- **Build to the narration words**, not arbitrary beats; hold a fully-built scene/chart ≥ 2–3 s before moving on.
- **Vary scene types** — no three near-identical layouts in a row; alternate full-frame / split / diagram / quote.
- **Spoken/readable captions live in the plan's `tracks.captions.lines` (data), NOT burned into this composition** — the assembler burns them via `burnsubs` at the end, so a later typo fix is a one-line edit, not a re-render of the whole composition. Only a PURELY DECORATIVE caption treatment that IS the visual design (kinetic highlight sweeps, word-by-word reveals) may live inside the composition — and when it does, tell the user that styled caption is part of the picture and not separately editable later. Keep ordinary subtitles as caption-track data, synced to the voice.
- The host may surface craft-threshold warnings on the composition (small font sizes, oversized palette) when you QA it before rendering — fix those before the final render. (Orkas: `stage-compose render_composition --op lint` / `--op inspect`.)

## Constraints

- Deterministic only: no real-time timers, no network-dependent runtime behavior, no randomness without a fixed seed — the renderer seeks discrete frames.
- Keep all referenced assets inside the composition directory so the render is self-contained.
- This skill authors and renders compositions; it does not pick the production line (see the routing skill) or generate AI footage.
