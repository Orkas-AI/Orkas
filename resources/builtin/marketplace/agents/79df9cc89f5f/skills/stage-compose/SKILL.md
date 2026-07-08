---
ownerAgent: 79df9cc89f5f
name: stage-compose
min_app_version: "1.5.1"
description_zh: Orkas HTML 视频合成的编写知识——如何写一个 composition（index.html）、用时间线驱动动画、声明画幅与时长，再渲染成 mp4；解说/动画/动态图形/字幕叠加的核心技能。
description_en: Authoring knowledge for Orkas HTML video compositions — how to write an index.html composition, drive animation from a timeline, declare canvas + duration, then render to mp4; core skill for explainer/animation/motion-graphics/caption work.
category: creation
---

# stage-compose

How to author an Orkas HTML composition and turn it into a video. Host-neutral: this skill describes the artifact you produce and the outcome you want (a rendered mp4). In Orkas, composition lint/inspect/draft/render runs through the built-in `video_studio` tool. Compatibility is enforced before install by the marketplace `min_app_version` field on the agent/skill.

For visual direction, apply `frontend-design` before writing the design contract. If the user provides a DESIGN.md, brand guide, reference site, screenshot, Figma notes, or explicit named style, apply `design-system-importer` to convert that source into compact VideoStudio tokens. `composition-design-review` is a bounded post-draft sanity check for design-sensitive work; it must not replace `--op draft` QA or create an open-ended redesign loop.

## Fast COMPOSE runbook

After Gate B approves the script/storyboard, keep the production turn narrow:

1. Read only the approved `project/script.md`, `project/shotlist.json`, and this skill if not already loaded for the current turn. Also read `frontend-design`; read `design-system-importer` only when a concrete style source or explicit named reference exists. Do not read `composition-design-review` until the draft returns `ok: true` and its trigger applies.
2. If standalone narration is needed, call `generate_speech` once to `project/composition/assets/narration.mp3`.
3. Write `project/composition/design-contract.json`, then model-author `project/composition/index.html` directly. For narrated work, also write `project/composition/scene-map.json` from the approved script/shotlist so timing QA can verify voiceover-to-visual alignment. If narration line timing is known, write `project/composition/narration-map.json`.
4. Decide whether to open the optional HTML Preview Gate before rendering mp4. Use the preview gate when expected render rework is expensive: target duration >= 45s, scene count >= 7, render cost is likely slow, or the composition has dense text, complex SVG/GSAP, many branded/supplied assets, or a prior draft failure. Skip it for short/simple work: target duration < 20s, scene count <= 4, no narration/timing complexity, and no obvious visual-risk signal. The subject category alone never forces the preview gate.
5. If the HTML Preview Gate is needed, run `video_studio` `op: "composition.inspect"` and `op: "composition.snapshot"` to `project/composition/preview/first-frame.png`, then show the first-frame image, inspect headline, `index.html` path, and why preview was inserted. Options: approve HTML preview, revise HTML/design, or render draft anyway. Stop. On approval, continue to the draft command. On revise, modify only `design-contract.json`, `scene-map.json`, or `index.html`, then rerun inspect/snapshot and reopen the same preview gate.
6. Run the draft command with `video_studio` `op: "composition.draft"`. Before rendering, the production path prepares declared local vendor assets, checks design-contract/scene-map/HTML consistency, blocks remote runtime resources, verifies local assets, checks shotlist/source alignment, and checks narration mapping. Then it runs lint, inspect, render, audio/media QA, sampled-frame QA, and writes one QA report.
7. If the draft command fails, repair the design contract, scene-map, or HTML, then run it again. The draft script enforces one initial failed draft plus at most two repair passes through `project/composition/qa/draft-repair-state.json`. The second repair pass is allowed and returns the real failing check if it still fails, with `repair_budget.budget_exhausted: true`; any later draft attempt returns `E_REPAIR_BUDGET_EXCEEDED`. Stop and report the blocker instead of continuing to patch.
8. If the draft command returns `ok: true`, run `composition-design-review` only when the approved brief is brand/product/promo/version-update/portfolio work, a `style_source` exists, or sampled frames show a visible design risk. Only concrete blockers can prevent Gate D; include `fix`/`polish` notes in Gate D instead of silently looping.
9. Open Gate D after the draft command returns `ok: true` and any triggered design review has no concrete blockers.

The default path is **model-authored HTML -> draft**. Do not write or compile `spec.json`; fixed template compilation is not part of the COMPOSE path because visual quality and extensibility come first.

## How to call the render path

Use the Orkas-native tool call:

```json
{"op":"composition.draft","composition_dir":"project/composition","output_path":"project/render/draft.mp4","quality":"draft","report_path":"project/render/draft-report.json","findings_path":"project/composition/qa/inspect.json"}
```

The tool returns JSON. A tool error means a structural/render-safety issue or Orkas runtime issue must be fixed before continuing.
For draft output, the report includes contract/source alignment, lint, inspect, media probe, loudness, audio timing, and video-frame QA when that path supports them. Video QA samples the first frame and scene starts/mids so an empty hook frame, blank scene boundary, or long frozen sampled run blocks Gate D. It also writes a contact sheet and per-sample evidence frames for design review when available.
Use the draft command's lint and inspect gates before rendering. Lint blocks render-contract errors such as unregistered timelines, missing clip timing, invalid root timing, and imperative media control. In draft mode, visual inspect findings such as small text, text overflow, occlusion, overlap, contrast, and safe-area issues are reported as QA advisories in `steps.inspect.draft_disposition`; they should be fixed when practical, but they do not stop the first mp4 draft from being produced. Palette size remains advisory design feedback, not a hard gate.
When using `findings_path`, the full QA payload is saved to disk; read the file only when the summary points to a specific issue that needs detail.
Do not stop a draft solely because inspect reports visual/readability findings. Stop only when `draft_disposition.blocking_error_count > 0`, lint/contract/audio/source/video QA fails, or the renderer cannot produce media.

## HTML Preview Gate

Use the HTML Preview Gate to avoid expensive mp4 rerenders when visual rework is likely. It is a cost-control gate, not a new creative milestone, and it is only for the COMPOSE line. Decide from expected rework cost:

- **Preview first** when duration >= 45s or scene count >= 7.
- **Preview first** when a 20-45s piece has dense text, multiple chapters, many supplied/brand assets, complex SVG/GSAP motion, tight narration timing, or a prior draft/repair failure.
- **Skip preview** when duration < 20s, scene count <= 4, and the HTML is simple enough that rendering the draft is cheaper than asking for another confirmation.
- Do not use product/promo/version-update labels alone as the trigger. Those labels only contribute to risk when the piece is long, visually dense, or expensive to rerender.

When preview is triggered:

1. Run inspect and write findings:

```json
{"op":"composition.inspect","composition_dir":"project/composition","findings_path":"project/composition/qa/inspect-preview.json"}
```

2. Run a first-frame snapshot:

```json
{"op":"composition.snapshot","composition_dir":"project/composition","output_path":"project/composition/preview/first-frame.png"}
```

3. Open the gate with the snapshot image, the `index.html` path, and a compact status line:
   - reason for preview: duration / scene count / complexity / prior failure
   - inspect headline: blocking count or main advisory
   - what approval means: render mp4 draft next

4. If the user revises, edit the design contract, scene-map, or HTML, then rerun inspect + snapshot. Keep this loop lightweight; do not synthesize new narration or render mp4 during HTML preview.

The HTML Preview Gate does not replace the mp4 draft. It cannot validate audio muxing, final encoded video quality, sampled-frame video QA, or exact narration pacing. After approval, always run `composition.draft` and open Gate D with the video.

## Scene map for QA

For narrated or tightly timed work, write `project/composition/scene-map.json` beside `index.html`. It is not a template; it is the audit map that lets the draft command verify timing and source alignment while the model keeps full control of HTML/CSS/SVG/GSAP.

```json
{
  "canvas": { "width": 1920, "height": 1080, "duration": 60, "language": "en" },
  "audio": { "narration": "assets/narration.mp3" },
  "source_alignment": { "merge_reason": "optional when combining approved shotlist beats" },
  "scenes": [
    {
      "id": "hook",
      "start": 0,
      "duration": 5,
      "headline": "Orkas 1.5.0",
      "narration": "A concise line or narration_ref for this exact window.",
      "source_shots": ["s01"]
    }
  ]
}
```

If the approved shotlist beat is intentionally merged into a longer visual scene, add `source_alignment.merge_reason` or per-scene `source_shots`. When audio exists, every scene must include either concise `narration` text or a `narration_ref`/`source_shots` mapping to the approved script/shotlist.

When TTS or a transcription step gives line timing, add `project/composition/narration-map.json`:

```json
{
  "lines": [
    { "id": "n01", "start": 0.0, "duration": 3.2, "text": "Meet Orkas 1.5.0." }
  ]
}
```

Then use `"narration_ref": "n01"` or a comma-separated list on the matching scene. Draft QA uses this map before falling back to coarse text-length timing, so voiceover/visual drift is caught earlier.

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
    <script src="./assets/vendor/gsap.min.js"></script>
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
- **SVG-first visual layer**: prefer inline SVG for non-text motion graphics such as diagrams, connectors, nodes, progress paths, charts, orbit lines, icon-like marks, and background geometry. Keep readable prose in normal HTML text boxes unless the SVG text is large, simple, and verified.
- **Use GSAP only when time-based motion is needed**: static SVG, CSS layout, and simple held states do not need GSAP. When animation is needed, keep GSAP as the timeline/orchestration layer that animates SVG groups or a small set of HTML containers. Do not build dozens of absolutely positioned HTML nodes/cards/lines when one SVG graph can carry the visual.
- **No remote runtime resources**: `index.html` must not load CDN scripts, remote fonts, remote images, or remote CSS during render. Fetch or copy required runtime files into `project/composition/assets/` during authoring, then reference them with relative paths such as `./assets/vendor/gsap.min.js`. Draft QA blocks `http://` and `https://` references.
- **Local GSAP vendor**: if `index.html` references `./assets/vendor/gsap.min.js`, the render script prepares the built-in offline GSAP vendor in the workspace composition directory. It auto-replaces the old managed VideoStudio shim when found, keeps compatible existing GSAP files, and blocks incompatible user-provided vendor files before rendering. Do not manually patch `assets/vendor/gsap.min.js` inside a composition; fix HTML/scene-map/design-contract issues, or report the vendor blocker.

## Design contract before HTML

Before writing `project/composition/index.html`, write `project/composition/design-contract.json`. This is an internal artifact, not a user gate. Treat it as the composition budget, not a style note.

The contract must declare these budgets compactly:
- `canvas`: aspect ratio, width, height, duration, fps, language.
- `aesthetic`: from `frontend-design`: subject world, audience, one job, tone, signature device, aesthetic risk, and anti-template check.
- `style_source`: from `design-system-importer` when a DESIGN.md, brand guide, screenshot, reference site, Figma notes, existing app UI, or explicit named style was used. Omit when there is no external style source.
- `scenes`: start/duration, approved on-screen copy, narration timing, visual focus, and layout type.
- `layout_boxes`: safe text box, visual box, caption box, and maximum label count per scene.
- `typography_tokens`: title/body/caption/label floors plus type roles. Default floors for 1920x1080: title >=72px, body/supporting text >=42px, safe margin >=96px, no more than two text blocks and about 12-16 English words per scene. Preserve the same readability intent for 9:16 and 1:1.
- `color_tokens`: named baseline values with rationale: background, surface, text, muted, primary accent, and any purposeful supporting accents the approved visual idea needs.
- `motion_budget`: max animated groups per scene, allowed transitions, easing, which SVG/HTML groups move, and what each motion communicates.
- `scene_variation`: how the sequence avoids three near-identical layouts, transitions, or card/title scenes in a row.
- `audio`: narration ownership, audio path, target duration, and whether the composition must render silent for assemble.

The palette is a design contract, not a mechanical hue cap. The HTML/CSS/SVG should derive its main system from `color_tokens` through CSS variables or equivalent structured constants, but do not flatten or recolor a scene just to reduce a static color count. Add purposeful local colors when they improve hierarchy, brand fidelity, data meaning, or scene variation, and keep them named or easy to audit.

The draft command enforces the contract before rendering. It blocks when:
- `design-contract.json` is missing or invalid.
- Root `data-width`, `data-height`, or `data-duration` differ from the contract or scene-map.
- Scene timing falls outside the composition duration or overlaps unintentionally.
- Declared scene headline/title/on-screen copy is missing from `index.html`.
- HTML references a missing local asset, an absolute path, an asset outside the composition directory, or a remote runtime URL.
- HTML calls `gsap.*` without loading `./assets/vendor/gsap.min.js`.

Typography and layout budgets are binding for every readable element, including badges, pills, labels, captions, cards, nodes, and microcopy. Do not put long labels in circles or small decorative nodes; use larger cards, capsules, or nearby labels. If approved copy cannot fit safely, shorten on-screen text without changing meaning. Ask the user only when the message would change.

Run a pre-code anti-template check from `frontend-design`: name the first generic design move you rejected and the brief-specific replacement. If you cannot name that replacement, the contract is not ready. When `style_source` exists, also name what was adapted, simplified, and not copied from the reference.

## Inspect and repair policy

Run the draft command before any user-facing render. If lint, contract/source/audio timing, video-frame QA, or inspect `draft_disposition.blocking_error_count` is not OK, repair once and run the draft command again. Visual inspect advisories are not blockers for the first mp4 draft; include them in Gate D notes and repair only the highest-impact issues before looping. A second repair pass is allowed only when the remaining blockers are fewer and clearly localized. If the script returns `E_REPAIR_BUDGET_EXCEEDED`, do not delete the repair state or run another draft command; show a concise blocker with the report path and the last error.

Repairs should address the cause, not just the symptom:
- `FONT_TOO_SMALL`: reduce text density, shorten copy, enlarge/reflow containers, or move labels out of small shapes. Do not simply increase every font size if that creates overflow.
- `missing_timeline_registry`, `gsap_timeline_not_registered`: register a paused GSAP timeline on `window.__timelines[compositionId]`, using the exact root `data-composition-id`.
  - `timed_element_missing_clip_class`, `root_composition_missing_data_start`, `media_missing_data_start`, `imperative_media_control`: let the renderer own timing and media playback through `data-start`, `data-duration`, `.clip`, and media data attributes. Do not drive render-critical timing with custom `play()`, `pause()`, `currentTime`, timers, or a custom `seekTo` API.
- `text_occluded`, `text_box_overflow`, `content_overlap`: restructure the scene layout or regenerate the affected scene from the contract's boxes. Do not rely on small numeric nudges.
- `STATIC_FRAME_RUN`: fix the timeline registration, scene clip timing, or scene variation; do not deliver a draft whose sampled frames are identical across multiple scenes.

If repair makes blocking errors worse, or if structural/render-safety blockers remain after the allowed repair passes, stop with a concise blocker report and the findings path. Regenerating `index.html` counts as one of the two repair passes; do it only when the failure is structural, not as an open-ended loop. If only visual advisories remain and `--op draft` returned `ok: true`, present the mp4 draft with QA notes instead of silently looping. Repair the design contract, scene-map, or hand-authored HTML directly; do not introduce `spec.json` as a workaround.

After the draft command returns `ok: true`, run `composition-design-review` only when its trigger applies. Use `video_qa.contact_sheet` and `video_qa.frame_paths` from the draft report as the primary visual evidence. A review blocker must be visible in a specific scene/frame and must break readability, the approved promise, required brand/style tokens, motion timing, or asset safety. Allow at most one localized repair and re-draft for those blockers. Treat `fix` findings as Gate D notes unless they are trivial to repair in the same pass. Treat `polish` as optional notes only.

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
- Before the first TTS call, estimate the script length from `video-craft` cadence (~150-160 wpm for explainers) and trim the text to the approved target duration. Do NOT synthesize multiple full versions just to discover timing. One full TTS pass plus at most one shortened retry is the limit; after that, shorten text or retime the plan explicitly.
- If `generate_speech` fails, never silently continue: tell the user, then either fix and retry the narration or explicitly proceed silent with that stated at the gate. Draft QA flags a contract that declares narration while the composition has no audio (`NARRATION_DECLARED_BUT_SILENT`) — do not present such a draft as if it were complete.
- Use a project path such as `project/composition/assets/narration.mp3` for `generate_speech`. It resolves under the current workspace, keeping the composition self-contained instead of writing throwaway audio under chat attachments.
- For background music plus voiceover, use two `<audio>` tracks with different `data-track-index` and lower the music `data-volume` (e.g. 0.2).
- Keep narration audio inside the composition dir so the render is self-contained.
- **Talking-head caveat:** when this composition is being overlaid onto AI-generated talking-head footage that already has **lip-synced built-in speech** (generation line), do NOT add a narration `<audio>` track. The renderer's muxed audio replaces the clip's own voice, so a synthesized narration would desync from the mouth. Use this composition for captions / lower-thirds only and let the clip's built-in audio stand (background music at low volume is fine; spoken narration is not).

## Render (the outcome)

Produce the finished video by rendering the composition **directory** to an mp4. Iterate at draft quality, then do one high-quality pass once the layout and timing pass review. For the user-facing final, use `video_studio` `op: "composition.draft"` with `quality: "high"` and `output_path: "project/render/final.mp4"` so the same contract, source, inspect, audio, and video QA gates still run on the final export. Use render-only ops only as a narrow diagnostic render when QA has already identified the blocker.

## Director judgment (compose line)

Craft calls specific to designed/animated explainers, on top of the shared craft reference (video-craft):

- **One concept per visual chapter** — don't stack two ideas in one scene; give each its own build.
- **Concrete before abstract** — real data, diagrams, steps before a metaphor; the metaphor only lands once the concrete version is understood.
- **Aesthetic thesis before styling** — use `frontend-design` to choose one signature visual device that comes from the subject matter; spend distinctiveness there and keep the rest disciplined.
- **Reference styles become tokens** — use `design-system-importer` for DESIGN.md/brand/reference input, then adapt the tokens to video safe zones and motion. Do not clone protected layouts or assets.
- **Design review is a last-mile guardrail** — use `composition-design-review` only when its trigger applies. Block only on concrete visible failures; template feel, hierarchy, and polish issues that do not break the promise go to the Gate D note.
- **Render exact text as real text** — stats, names, CTAs are typed into the composition, never baked into AI imagery (which hallucinates numbers and can't be corrected).
- **Build to the narration words**, not arbitrary beats; hold a fully-built scene/chart ≥ 2–3 s before moving on.
- **Vary scene types** — no three near-identical layouts in a row; alternate full-frame / split / diagram / quote.
- **Spoken/readable captions live in the plan's `tracks.captions.lines` (data), NOT burned into this composition** — the assembler burns them via `burnsubs` at the end, so a later typo fix is a one-line edit, not a re-render of the whole composition. Only a PURELY DECORATIVE caption treatment that IS the visual design (kinetic highlight sweeps, word-by-word reveals) may live inside the composition — and when it does, tell the user that styled caption is part of the picture and not separately editable later. Keep ordinary subtitles as caption-track data, synced to the voice.
- The host may surface craft-threshold warnings on the composition. In draft mode, small readable text is a QA advisory rather than a render blocker; oversized palette is advisory and should be judged against the design thesis, brand, and scene clarity rather than mechanically recoloring the whole piece. (Orkas: use `video_studio` `op: "composition.draft"`.)

## Constraints

- Deterministic only: no real-time timers, no network-dependent runtime behavior, no randomness without a fixed seed — the renderer seeks discrete frames.
- Keep all referenced assets inside the composition directory so the render is self-contained.
- This skill authors and renders compositions; it does not pick the production line (see the routing skill) or generate AI footage.
