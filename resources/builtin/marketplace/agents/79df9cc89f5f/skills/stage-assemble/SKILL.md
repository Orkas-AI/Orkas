---
ownerAgent: 79df9cc89f5f
name: stage-assemble
min_app_version: "1.5.1"
description_zh: 把已审批的跨模态 EDL（plan.json）确定性地装配成成片的知识——按序产出每个片段（剪辑/合成/生成/已提供，分别委派给对应产线），再按 ffmpeg 层级装配：主轨拼接→合成叠层→混旁白(覆盖校验)→烧字幕→响度核对；带断点续跑，交 D 门前做 QA。AUTO 端到端产线的装配核心。
description_en: Knowledge for deterministically assembling an approved cross-modal EDL (plan.json) into a finished video — produce each segment (edit / compose / generate / provided, each delegated to its line), then assemble in ffmpeg tiers: concat the primary track → overlay composed layers → mix narration (with a coverage check) → burn captions → verify loudness; idempotent-resumable, with QA before gate D. The assembly core of the AUTO end-to-end line.
category: creation
---

# stage-assemble

How to execute a validated, currently authorized `project/plan.json` into one finished file. Start/resume with `production.status`; if `plan_approval_current` is false, pass the state to `gate-control` and stop instead of producing or opening child gates. Walk the signed EDL; do not re-plan. Host-neutral: VideoStudio-specific edit/plan work runs through skill scripts (`stage-edit edit_video`, `stage-plan video_plan` via `bin/run-skill.cjs`), while authorization state, composition, and transcription run through the required built-in `video_studio` runtime; generic built-in capabilities remain `generate_video` / `generate_image` / `generate_speech`.

## Script calls used here

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op concat --inputs project/parts/a.mp4,project/parts/b.mp4 --output project/render/primary.mp4
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op mix --input project/render/primary.mp4 --audio-segments @project/audio_segments.json --output project/render/mixed.mp4
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op normalize_loudness --input project/render/draft.mp4 --output project/render/video.mp4
```

When this document says `stage-edit edit_video --op ...`, call the matching `bin/run-skill.cjs` command above with the relevant paths. For compose/transcription work, call `video_studio` directly. Do not call deprecated direct tools.

## Step 1 — Produce each segment (delegate by source)

Iterate segments in `order`. For each, produce its `produced_path` according to `source`, then write that path + `status:"done"` back into the segment so a resume never re-produces it:

- **edit** → `stage-edit`: `stage-edit edit_video --op trim` the `input_id` to `[in_sec, out_sec]` → `project/cuts/<id>.mp4`.
- **compose** → `stage-compose`: under `project/compositions/<id>/`, write local `script.md`, `shotlist.json`, and `composition-manifest.json` derived exactly from the signed segment's `spec.composition_plan`. Keep it silent (`audio.owner:"none"`, no tracks). Ask `gate-control` to resolve parent Gate B inheritance for the owning plan/segment, then follow the returned doctor/prepare path without creating a child user gate. Continue with visual authoring, native-required inspect/snapshot, and draft to `project/parts/<id>.mp4` only while the binding stays current.
- **generate** → `stage-generate` (+ `stage-consistency` for recurring characters): proceed only while `production.status` reports the current paid-generation signature. Call `generate_video` or `generate_image` with `production_plan_path:"project/plan.json"` and `production_segment_id:<id>` → `project/assets/<id>.<ext>`. Every auxiliary portrait/keyframe is already its own signed generate segment; do not create unplanned billable calls. The host transaction reuses a completed artifact and blocks an interrupted/failed duplicate. Pass pending/failed state to `gate-control`; never automatically retry or invent a recovery API, and use a new output path for any later authorized retry.
- **provided** → use `spec.asset_id` as-is (probe it first; conform aspect/fps if needed).

Billable `generate` segments must not run before Gate C has confirmed the exact count from `cost_estimate`, disclosed that the external provider's billing and balance cannot be verified locally, and `production.approve_generation` has persisted that approval. Produce cheap/free segments first, then show one combined `gate_c_decision` form; never interleave per-shot confirmations.

## Step 2 — Assemble in ffmpeg tiers (the default path)

Assemble deterministically, bottom-up. This tiered order is the default; it is predictable and cheap, and keeps each clip's real audio intact:

Treat a track as enabled only when it has executable content: narration needs a signed `synthesis` selection and at least one non-empty line (legacy raw `voice` is recovery-only), music needs a real `path`, and captions need non-empty `lines` or a valid `from` source. Omitted/null tracks and legacy empty objects are disabled; skip them completely. Never synthesize, mix, or burn a placeholder merely because the key exists.

1. **Primary track** — `stage-edit edit_video --op concat` the primary-layer `produced_path`s in `order` → `project/render/primary.mp4`. Conform aspect/fps on the way in if sources differ.
2. **Overlays / bg** — for each overlay/bg segment, `stage-edit edit_video --op overlay` its part onto the primary over the window of the segment named in `over` (title cards, lower-thirds, logos). Composed layers are VISUAL-ONLY — they must not carry their own narration audio. **This includes a compose segment that IS the primary track (a full-video composition): render it SILENT — do not put a narration `<audio>` in its `index.html`. The assembler owns narration (tier 3), so a composition that bakes it in would mean narration is added TWICE (the "two voices" defect).**
3. **Narration — added EXACTLY ONCE, here.** If narration is active by the rule above, re-check line length against `target_sec` before synthesis; shorten over-budget lines in `project/plan.json` while preserving meaning. Then call `generate_speech` for each line with the plan's exact `synthesis.route_ref`, `synthesis.voice_ref`, and `synthesis.language`, plus `production_plan_path:"project/plan.json"` and that line's zero-based `narration_segment_index`; pass `target_duration` equal to its signed `target_sec`. The host verifies the current Gate B signature, exact text, selection, language, speed, and duration before synthesis, so execution-time overrides are forbidden. Write each line's `produced_path` back so a later edit can re-voice one line alone. Aim for one TTS call per line; allow at most one shortened retry after a real fit failure. Add the produced lines in ONE `stage-edit edit_video --op mix` call using `--audio-segments` — one entry per line, each at its `start_sec` — so each line is delayed onto its scene (per-line placement; do NOT pre-bake one continuous narration file, that destroys per-line alignment and separability). The mix DEFAULTS to `on_existing_audio:"reject"`: if the base already has an audio track it FAILS with `E_EDIT_BASE_HAS_AUDIO` — that means a compose segment baked narration into its render; go back and re-render that segment SILENT, then re-mix. RUN THE COVERAGE CHECK on the result and fix any desync before the draft. An intended music-only or silent tail is allowed only when stated at Gate D. Keep built-in lip-synced talking-head audio; never synthesize over a speaking mouth.
4. **Music** — when the music track is active, add its path ducked under narration by the planned amount.
5. **Captions** — when the captions track is active, resolve `from` or turn `tracks.captions.lines` (`{text, start_sec, target_sec}`) into a `.srt`, then `stage-edit edit_video --op burnsubs`. Captions are DATA in the plan — burned ONLY here at assemble — so a later typo fix is a one-line edit re-burned, never a re-render of the picture. If `burnsubs` fails because the runtime ffmpeg lacks subtitle filter support, stop and report that blocker; do not hand-write a fallback `ffmpeg` graph, do not use `-loop 1` PNG subtitle overlays, and do not recompose the whole video just to fix captions.
6. **Loudness** — run `stage-edit edit_video --op normalize_loudness --input project/render/draft.mp4 --output project/render/video.mp4`. It normalizes to the `video-craft` §7 targets (~−14 LUFS integrated, true-peak ≤ ~−1 dBTP) and returns the measured loudness; only fall back to `--op loudness` when you are diagnosing an existing file without writing a deliverable.

Apply the plan's `style_kit` for cohesion: composed layers (titles/captions/cards) use its `palette` + `fonts`. A single `lut` graded across all clips is what unifies tonally mixed sources — until a grade op is available, keep mixed sources close at capture/trim and lean on the shared palette + consistent captions for cohesion rather than promising a uniform grade.

Output `project/render/video.mp4` as the deliverable; `project/render/draft.mp4` is the pre-normalized intermediate.

## Director judgment (end-to-end assembly)

The craft of making mixed sources feel like one video, on top of the shared craft (`video-craft`). The seams between footage / generated / composed are where multi-source assembly falls apart — engineer continuity across them:

- **One look across every source.** Apply the `style_kit` so a cut from real footage → a generated shot → a composed card does not read as three videos: one type system + palette on every composed layer, one caption style throughout, matched aspect / fps, tonal proximity (a shared LUT is the unifier when available; `video-craft` §4).
- **Audio is the through-line that hides the visual seam.** One narration voice; a continuous music bed UNDER the cuts (do not restart it per segment); duck consistently (`video-craft` §7). The ear's continuity carries the eye across a source change — a reveal may drop music, but the bed bridges the cut.
- **Rhythm over a mixed cut.** Alternate motion vs. static and source types for momentum — do not stack three composed cards or three talking-head shots in a row (that is the repetition / slideshow smell, `video-craft` §3, §12). Vary holds.
- **Cut on a content change, not just plan order.** A hard cut on a beat / word change is invisible and professional; a crossfade signals a gentle topic shift (`video-craft` §5).
- **Don't bury the hero.** On a `source_led` piece, composed lower-thirds and captions FRAME the footage — they never cover its subject / face (`video-craft` §6).
- **Apply the editing cut craft ACROSS the seams.** The cut mechanics live in `stage-edit` → "Cut craft" (best sub-window, ≤ 4 transitions, L/J-cut sound bridges, handles / no freeze-frame, adjacent-diversity, a reason per cut) — apply them at every junction between sources, since the footage → generated → composed seams are exactly where a mixed cut betrays itself.

## Step 3 — Idempotent resume

The plan plus project-scoped production control is the checkpoint. On a re-run, call `production.status`, skip any segment already `status:"done"` with a present `produced_path`, and let the host return `reused` for a completed generation transaction. Skip assembly tiers whose output already exists and is newer than its inputs. Never infer that a missing chat bubble means a billable segment should run again.

## Step 4 — QA report, then gate D

Before showing the draft, run the QA pass and write `project/render_report.json` with these sections:

- **technical_probe** — `stage-edit edit_video --op probe` the draft (real duration / resolution / fps / audio present); confirm it matches the plan's aspect + total.
- **promise_preservation** — run `"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-plan video_plan -- --op promise_check --plan project/plan.json --probe-produced`. At gate D this probes each primary segment's `produced_path` and computes the REAL primary-track footage/generated-video ratio vs. `motion_min_ratio` plus the `source_required` invariant. A `compose_led` plan uses a zero real-motion floor because native composition QA owns its HTML animation contract. Missing/unreadable produced media or a fail means **"slideshow / promise broken" — do not deliver**. Send it back (below). Do not eyeball this; let the numbers decide.
- **visual_spotcheck** — extract ~4 frames across the draft (`stage-edit edit_video --op extract_frame`) and read them for upside-down / garbled-caption / empty / wrong-product frames. Read them yourself if you are multimodal; if you cannot see images, record the spot-check as `unverified` and proceed — do not invent what the frames show.
- **audio_spotcheck** — the `op="normalize_loudness"` measured loudness numbers + the narration coverage result from step 2 (uncovered tail / silent lead-in).
- **transcript_comparison** (when there is narration) — optionally transcribe the draft with `video_studio` `op: "speech.transcribe"`, then confirm the spoken words match the planned narration lines.

Each section carries `pass` / `warn` / `fail` + a one-line reason. Then present the draft `[video]` + the report's headline findings at **gate D**.

On approve → finalize `project/render/video.mp4` (loudness / captions only; never re-synthesize a talking-head voice). On revise → redo only the affected segment(s) and re-assemble.

## Send-back (self-correction on a QA fail)

A QA `fail` does not go to the user as "here's a broken video". Diagnose which segment(s) caused it and redo ONLY those, then re-assemble and re-run QA:

- promise_preservation fail (slideshow) → the static composed segments are too long / the motion segments too short. Rebalance segment durations or convert a static beat to footage, re-assemble.
- visual_spotcheck fail (bad frame) → re-produce that one segment (re-trim / re-compose / re-generate), not the whole video.
- audio fail (uncovered tail) → re-time or extend the narration / trim the tail.

Bound the loop: at most **2** send-back rounds for the same failing check. If it still fails, surface it honestly at gate D with the report and ask the user how to proceed — do not loop forever and do not quietly ship a known-failing draft.

## Rules

- Walk the approved plan; if assembly reveals the plan is wrong, surface it and re-gate — do not silently re-plan.
- Write `produced_path` + `status` back per segment as you go (resumability + the QA pass depend on it).
- One output file is the deliverable; `cuts/` and `parts/` are intermediates.
- **Narration is added exactly ONCE — in the mix tier, never baked into a compose render.** Compose segments (including a full-video composition used as the primary track) render SILENT (no narration `<audio>`); the assembler mixes narration via `stage-edit edit_video --op mix` with `audio_segments` placed per line. The mix's default `on_existing_audio:"reject"` enforces this — an `E_EDIT_BASE_HAS_AUDIO` error is the signal a segment wrongly baked audio in.
- **No ad-hoc ffmpeg fallbacks for captions.** Caption burn-in is a low-freedom operation owned by `stage-edit edit_video --op burnsubs`; a failed burnsubs call is a tool/runtime blocker, not permission to invent a custom subtitles/drawtext/PNG-overlay command.

## Boundary / non-goals

This skill assembles an already-approved plan. It does not ingest or decide the plan (`stage-plan`), and it delegates the actual production of each segment to the compose / generate / edit / consistency skills rather than re-deriving their craft here.
