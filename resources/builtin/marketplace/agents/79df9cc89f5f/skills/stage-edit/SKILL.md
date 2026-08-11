---
ownerAgent: 79df9cc89f5f
name: stage-edit
min_app_version: "1.5.1"
description_zh: 真实素材的智能编辑知识——先用转写/OCR/镜头/静音/质量/视觉证据理解视频，再选择确定性时间线编辑或受约束的语义 AI 编辑；clip-factory、蒙太奇、二创和局部内容修改的核心。
description_en: Intelligent editing knowledge for real footage: understand it through transcript/OCR/scene/silence/quality/vision evidence, then choose deterministic timeline editing or constrained semantic AI editing; core of repurpose, montage, cleanup, and local content changes.
category: creation
---

# stage-edit

For the VideoStudio EDIT line, the edit decision list lives in `project/plan.json` and `gate-control` owns its Gate B authorization transition. Start/resume execution with `production.status`; do not run trims, assembly, or localization against a changed or unsigned EDL. Runtime `status`/`produced_path` updates do not invalidate the signed creative plan, but changing cuts, copy, source allocation, or delivery settings does.

How to intelligently edit **real user-supplied footage** while keeping the source and every decision auditable. Deterministic operations still handle cuts, joins, captions, overlays, reframes, and audio. When the request changes pixels semantically—remove an object, alter a background, relight a shot, or make another content-aware local change—keep the EDIT route and execute only that bounded segment through signed video `operation:"edit"` after paid-generation approval.

**Where the footage comes from.** A user-uploaded clip arrives as a chat attachment marked `model_readable="false"` with a `path` (see the attachment list). That flag means "not vision input", NOT "unusable" — the file is exactly what these media scripts operate on. Copy it into the project's `raw/` (or pass its attachment path directly as `--input`) before probing; never treat a `model_readable="false"` clip as something to skip.

## Intelligent edit contract

Write `project/plan.json::edit_strategy` whenever VideoStudio decides what to change rather than merely executing user-supplied timecodes:

- `mode`: `deterministic` for transcript/OCR/scene/silence/quality/vision-driven timeline decisions, `semantic` for AI pixel changes, or `mixed` when both are necessary.
All four fields below are non-empty arrays of strings — one entry per item,
never a single sentence. `objectives` is the one most often written as prose;
the validator rejects a bare string with `E_EDIT_STRATEGY_BOUNDARY`.

- `objectives`: the exact editorial or pixel-level changes requested, one per entry.
- `decision_signals`: only evidence actually used (`timecode`, `transcript`, `ocr`, `scene`, `silence`, `quality`, `vision`, `semantic_model`).
- `preserve` and `may_change`: non-overlapping boundaries. `may_change` must name every class of change the user authorized — omitting one silently narrows the plan's declared authority below what they asked for.

Declare every source/reference image or video in top-level `references` with `media_type`, reproduce/edit/guide intent, `intent_basis`, roles, required state, preserve/may-change, and target segment ids. This applies to deterministic trims/highlights as well as semantic edits: `spec.input_id` and `edit_strategy` do not replace the top-level source contract. User-declared requirements override defaults; only an unspecified reference defaults to guide/inferred. Video reproduce/edit/motion/timing contracts need one `{source_start_sec,source_end_sec,target_segment_id}` temporal anchor for every targeted segment. A semantic video edit is represented as `source:"generate"`, `media_kind:"video"`, `operation:"edit"`, with the original in `reference_video_paths`/`reference_video_urls`; it still belongs to the EDIT workflow and its count enters Gate C.

## How to call the media scripts

Use these `run-skill` entry points whenever this document says `stage-edit edit_video --op ...` or `stage-edit analyze_media --op ...`. Exception: transcription runs through the required built-in `video_studio` tool with `op: "speech.transcribe"`. Compatibility is handled by the marketplace `min_app_version` field before install.

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op probe --input raw/clip.mp4
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op trim --input raw/clip.mp4 --start 12 --duration 8 --output project/cuts/seg-1.mp4
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit analyze_media -- --op ocr --input raw/screen-recording.mp4
```

The scripts return JSON. A non-zero exit means the operation failed; fix the input/plan before proceeding.

**Subtitle safety hard rule.** Burn captions only through `stage-edit edit_video --op burnsubs`; do not hand-write `ffmpeg` subtitle, `drawtext`, or PNG-overlay fallback commands. In particular, never use `ffmpeg -loop 1` image inputs for subtitle overlays from bash. If `burnsubs` fails with `E_EDIT_BURNSUBS_UNSUPPORTED` or an ffmpeg filter-support error, stop and report the blocker instead of improvising a custom ffmpeg graph.

**If the task is to FIND / SELECT / REDUCE / CLEAN rather than run a known timecode edit** — remove dead air, drop fillers, pick highlights, cut a long recording down — read `stage-decide` first: it covers understanding the footage and producing an evidence-bearing rough cut (the deterministic auto-cuts `trim_silence` / `remove_fillers` and scene-candidate detection). This skill is for executing cuts you have already chosen.

**Two assembly paths — pick by whether the result needs to stay re-editable:**

- **Plan-backed (anything the user may later adjust: narration, multi-shot, segmented edits).** Author `project/plan.json` (the segments EDL — see `stage-plan`) carrying ONLY the operations the user asked for (the deltas) — everything else is the source, passed through untouched. Keep each editable concern SEPARATE in the plan: each narration line in `tracks.narration.segments` with its own `produced_path`, each caption in `tracks.captions.lines` as data, each segment carrying `status`/`produced_path`. A track is active only when it has executable content (narration: voice + non-empty lines; music: path; captions: non-empty lines or `from`); omit or set disabled tracks to `null`, and skip legacy empty objects completely. Assemble with `stage-edit edit_video` (trim → concat → mix → burnsubs). Because plan.json holds every piece separately, a later "fix one caption / re-voice one line" is a one-entry edit + one re-render — do NOT pre-bake (e.g. one big narration file), which destroys that separability.
- **One-shot deterministic (a plain trim or concat the user just wants done).** Use `stage-edit edit_video` directly; write no plan.json.

For every plan-backed follow-up, start with `production.status` and compare the
requested delta with the signed EDL. A caption typo/translation, one narration
line, one cut, or one output in a multi-output batch invalidates only that
entry and outputs derived from it. Reuse the source probe, transcript/OCR,
unaffected cuts, audio, and sibling outputs; do not retranscribe or re-run a
semantic/billable edit unless its signed input actually changed. A replacement
source clip is different: re-probe and regenerate evidence for that source,
invalidate its dependent cuts/tracks/drafts, and preserve unrelated inputs and
history.

File identity is content-addressed; a filesystem locator is not creative
intent. When a missing EDIT source is found at a new path with the exact
recorded byte SHA-256, keep its signed logical source identity and approved EDL
unchanged. Record the new physical path under the plan's excluded
`_runtime.asset_locators` envelope with the verified hash, and pass that
resolved path to `stage-edit edit_video`; do not rewrite the signed
`spec.input_id`, open the gate resolver, re-probe, retranscribe, or re-run OCR.
`production.status` reports the approval facts but there is no
`production.reconcile` call. Refresh the locator record, rebuild only outputs
that were paused by the missing source, run the complete-draft QA, and continue
in the same turn to the current Final video confirmation.

Each rebuilt edited draft is a new complete review candidate. Show that
current video plus its QA headline, and bind Final video confirmation to it.
An older draft reply is acknowledged but cannot approve the rebuilt draft. If
a local tool/runtime failure prevents rebuilding, expose the latest available
draft or source evidence, identify the affected edit, and give the concrete
next action instead of a generic recovery form.

## The deterministic editing loop

1. **Ingest — always probe first.** For every input clip, read its metadata (duration, resolution, fps, codecs). Never plan a cut blind; a `trim` past the real duration produces an empty or broken clip. (Orkas: `stage-edit edit_video --op probe`.)
2. **Plan — write an `edit_decisions` timeline.** From the user's intent + the probe results, decide the exact segments and order, and write them to `project/edit_plan.json` so the plan is inspectable and re-runnable. Shape:
   ```json
   {
     "segments": [
       { "input": "raw/clipA.mp4", "start": 12.0, "duration": 8.0 },
       { "input": "raw/clipB.mp4", "start": 0.0,  "duration": 5.5 }
     ],
     "subtitles": "raw/captions.srt",
     "overlay": { "media": "assets/logo.png", "x": 40, "y": 40 }
   }
   ```
   Every `start`/`duration` must be inside the probed duration of its input.
3. **Execute in order.**
   - `trim` each segment to its own file (`project/cuts/seg-1.mp4`, ...).
   - `concat` the cut files (in plan order) into one (`project/render/edited.mp4`).
   - If subtitles: `burnsubs` the `.srt`/`.ass` onto the concatenated video. Do not bypass `burnsubs` with a manual ffmpeg subtitle/overlay command if the tool fails.
   - If an overlay (logo / lower-third image / PiP): `overlay` it at the planned position.
4. **Publish** the final file.

## Transcription-driven selection & localization

When the user wants highlights / clips "about X" or a localized version, transcribe first with `video_studio` `op: "speech.transcribe"` and `timestamps: "word"`:

- **Highlight / clip selection:** read the transcript, choose the time ranges whose words match the requested topic/moment, and feed those `start`/`duration` into the `edit_decisions` segments. Now the timecodes are evidence-based, not guessed.
- **Auto-captions:** turn the transcript into an `.srt`, then `burnsubs` it onto the video.
- **Localization / dubbing:** transcribe → translate the text → synthesize the translated narration (the host's text-to-speech step) → `stage-edit edit_video --op mix` with `--on-existing-audio replace` (the dub REPLACES the original voice — do not stack it on top), and `burnsubs` translated captions.

## Grounding narration on on-screen text (silent / screen-recording footage)

**HARD RULE — adding narration to ANY existing video. Plan-first, IN ORDER. The plan.json is authored BEFORE any speech is generated and DRIVES the generation; do not synthesize a blob first and describe it after. Skipping a step is the #1 failure (a voiceover "about the right topic" that does not track the screen, crammed into half the runtime):**

1. **Analyze the video FIRST — never narrate from topic knowledge.** Probe duration, then: `stage-edit analyze_media --op ocr` for on-screen text AND `video_studio` `op: "speech.transcribe"` for spoken audio. A title-card / slideshow / screen-recording is the on-screen-text case → OCR is **mandatory, not the fallback**. Do NOT jump to reading frames-as-vision while OCR is available, and do NOT describe the product from memory.
2. **Author `project/plan.json` NOW (plan-first, not at the end) as the segments EDL** (copy `stage-plan`'s exact JSON skeleton — `source` is the method enum `edit`, NOT a file path (the clip goes in `spec.input_id`); use `target_sec`; `tracks` is an object), carrying ONLY what the user asked for — keep the picture, add narration — and nothing else:
   - one **primary `edit` segment** for the source spanning the whole timeline (`source:"edit"`, `layer:"primary"`, `target_sec` = clip length, `spec.input_id`/`in_sec`/`out_sec` covering the clip). Source-led keep — do NOT add crop/scale/reframe; you weren't asked to.
   - a **`tracks.narration`** track whose `synthesis:{route_ref,voice_ref,display_name,language,speed}` is copied from `video_studio speech.capabilities` called with the deliverable's exact BCP-47 `language`, with ONE LINE per on-screen beat: `{ text, start_sec, target_sec }`. Derive every window and line from the OCR/transcript table before any TTS. Never invent a voice id and never use one paragraph for the whole clip.
   - `delivery_promise:{ type:"source_led", source_required:true }`; set `aspect` from the SOURCE's real probed dimensions (a landscape source is `16:9`, not the portrait default).
   Each narration line stays its own entry, so a later edit can re-voice ONE line without touching the rest.
3. **Generate each beat FROM the plan, then record its `produced_path`.** `generate_speech` per narration line with `target_duration` = its `target_sec`; save the mp3 and write that line's `produced_path`. If the words don't fit at a natural pace, SHORTEN that line in the plan — never speed up past natural or let it run long/short. Coverage must span ~0→clip-end, not stop at the halfway mark.
   - Save each line under `project/assets/narration/line-XX.mp3` (or another `project/...` path) so the audio stays in the workspace and can be mixed later. Do not leave generated line audio under `cloud/chat_attachments/...`.
   - Do not use repeated TTS calls as a duration search loop. Estimate words/characters from the target window first, generate once, and if the tool reports a poor fit, shorten that line and retry once. Small residual timing differences should be handled in deterministic assembly, not by synthesizing many alternatives.
4. **Assemble with `stage-edit edit_video` — keep the picture untouched.** Pass the source video through (`-c:v copy`) and place the narration lines at their `start_sec` in ONE `stage-edit edit_video --op mix` call via `--audio-segments` (one entry per line — that is HOW per-line `start_sec` alignment happens), then run `--op normalize_loudness` to write the deliverable and return measured loudness in the same step; burn captions from `tracks.captions.lines` (.srt → `burnsubs`) if present. The source footage usually already HAS audio, so `mix` rejects by default — choose `--on-existing-audio mix` to keep the original sound under the voiceover, or `replace` to drop it. Write each line's `produced_path` + `status` and the top-level `draft` / `video` paths back to plan.json so the record matches the result. Never pre-bake one big narration file — that destroys per-line separability.
5. **Self-check before presenting:** `project/plan.json` validates (`"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-plan video_plan -- --op validate --plan project/plan.json`); every narration line has a `produced_path` and a window matching its OCR/transcript text; total coverage ≈ full clip length; `project/render/video.mp4` exists. Then tell the user the draft is ready and they can ask for follow-up tweaks (re-voice a line, fix a caption) and you'll change only that.

When the clip has NO spoken audio, or its meaning lives in ON-SCREEN TEXT (a screen-recording, a slideshow, a captioned montage), transcription returns nothing — the content is in the pixels, not the audio. An empty audio track does NOT mean an empty screen. Read what is on screen instead of guessing, in this strict order (cost-first):

1. **OCR the on-screen text — preferred, cheapest, no extra cost.** `stage-edit analyze_media --op ocr` samples frames across the clip and returns a per-timecode table of `{startSec, endSec, text}` segments. Write the script / narration so EACH segment matches the on-screen text in its own `[startSec, endSec]` window. This is what keeps the voiceover aligned to the picture instead of drifting into a generic pitch about the topic.
2. **Only if OCR is unavailable** (its runtime could not install): fall back to your OWN vision — if you can read images yourself, extract frames across the whole clip and read them directly to build the same table.
3. **If you cannot see images either:** STOP and ask the user for the on-screen beats (a short outline of what each part shows). Never write narration from prior knowledge of the topic alone, and never escalate to a separate paid vision model.

This is the difference between "a voiceover that happens to be about the right product" and "a voiceover that tracks what is actually on screen at each moment" — the latter is the bar. As a final check before the draft, confirm each narration segment matches the OCR text for its window.

## Director judgment (editing line)

Craft calls per repurpose/montage line, on top of the shared craft reference (video-craft).

**Cut craft (every editing job — this is the canonical set; the assembly line references it).** On top of `video-craft` (pacing §3, transitions §5, audio §7):

- **Cut the moment, not the clip.** A 12 s clip usually holds one ~3 s moment that earns its slot — trim to that window. End the cut on a held look, not on the action moving off; leave a few frames of handle at each end so a dissolve doesn't clip the moment, and never freeze on a static last frame (reads as a glitch).
- **A restrained transition vocabulary for cut-driven pieces:** ≤ 4 types across the whole piece — hard cut (default, most invisible), dissolve (emotional siblings / time passage), fade-to-black (act breaks), fade bookends. In a documentary/montage register, wipes / push-slide / zoom-blur / glitch read as social-media language — avoid (this is stricter than the explainer norm in `video-craft` §5, where a wipe can mark a step).
- **Bridge the hardest cuts with sound** — carry the outgoing clip's ambient under the incoming for ~0.5–1.5 s (L-cut), or start the next audio early (J-cut); audio continuity hides a visual seam. Plus the one held silence from `video-craft` §7.
- **Adjacent-diversity + a reason per cut.** Don't place the same subject at the same shot size, or the same palette, back-to-back — break the pattern at least every ~4 cuts. If you can't write a one-line reason for a cut, it's arbitrary — reconsider it.

Per repurpose/montage line:

- **Social clip / clip-factory** — per clip = hook (0–2 s) → sustain → clean outro; optimize the first 2 frames; start on motion/face/result; lock a batch style (caption / hook position / watermark) so a series feels cohesive; don't crowd frame 1 with hook + caption + watermark + lower-third at once.
- **Podcast-repurpose** — audio is the hero; pick quotable moments; speaker video if it exists, else a simple audiogram / quote card; keep the visual system simple and repeatable; preserve attribution + CTA.
- **Screen-demo** — zoom only for legibility/orientation, steady while the viewer reads; reset to wide context between phases; ≤ 2 attention cues at once; label sped-up sections; keep UI text sharp (higher bitrate), don't force an unreadable vertical crop.
- **Localization** — treat each language as its own deliverable; dubbed audio won't match source timing, so plan holds to flex; re-render or cover any baked-in text per language; subtitle line lengths differ by language; lip-sync only where a close-up mouth mismatch would distract.
- **Documentary-montage** — concrete sensory shot descriptions, not abstract themes; one grade/LUT across all clips is what unifies mixed sources; budget 2–3 hero slots longer holds; a music bed + an end-tag.
- Before publishing, normalize the mix against the targets in video-craft §7 (~−14 LUFS integrated, true-peak ≤ ~−1 dBTP). (Orkas: `stage-edit edit_video --op normalize_loudness`; use `--op loudness` only for diagnosis without writing an output.)

## Rules

- **Timecodes come from the user, from probe, from a transcript, or from on-screen text (OCR) — never guessed.** If the target moment can't be located deterministically (no timecode, no transcript/OCR match), ask the user for the timestamp.
- **Layer composition over footage when the brief needs designed elements** (animated lower-thirds, kinetic captions, hooks): produce those with the composition skill as an overlay/element and `overlay` them, rather than trying to draw them in ffmpeg.
- **One output file** at the end; intermediate cuts live under `project/cuts/` and are not the deliverable.

## Boundary / non-goals

This skill owns the EDIT workflow. It executes deterministic EDL operations directly and delegates only bounded semantic pixel changes to the signed video-edit provider path. It does not author HTML compositions. For transcript/scene/silence/quality-driven selection, use stage-decide first and persist its evidence in `edit_strategy` and per-segment reasons.
