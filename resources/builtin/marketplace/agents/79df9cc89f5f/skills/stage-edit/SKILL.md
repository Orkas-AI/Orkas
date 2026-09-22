---
ownerAgent: 79df9cc89f5f
name: stage-edit
description_zh: 真实素材的智能编辑知识——先用转写/镜头/静音/质量/视觉证据理解视频，再选择确定性时间线编辑或受约束的语义 AI 编辑；clip-factory、蒙太奇、二创和局部内容修改的核心。
description_en: Intelligent editing knowledge for real footage: understand it through transcript/scene/silence/quality/vision evidence, then choose deterministic timeline editing or constrained semantic AI editing; core of repurpose, montage, cleanup, and local content changes.
---

# stage-edit

For the VideoStudio EDIT line, the edit decision list lives in `project/plan.json` and `gate-control` owns its Gate B authorization transition. Start/resume execution with `production.status`; do not run trims, assembly, or localization against a changed or unsigned EDL. Runtime `status`/`produced_path` updates do not invalidate the signed creative plan, but changing cuts, copy, source allocation, or delivery settings does.

How to intelligently edit **real user-supplied footage** while keeping the source and every decision auditable. Deterministic operations still handle cuts, joins, captions, overlays, reframes, and audio. When the request changes pixels semantically—remove an object, alter a background, relight a shot, or make another content-aware local change—keep the EDIT route and execute only that bounded segment through signed video `operation:"edit"` after paid-generation approval.

**Where the footage comes from.** A user-uploaded clip arrives as a chat attachment marked `model_readable="false"` with a `path` (see the attachment list). That flag means "not vision input", NOT "unusable" — the file is exactly what these media scripts operate on. Copy it into the project's `raw/` (or pass its attachment path directly as `--input`) before probing; never treat a `model_readable="false"` clip as something to skip.

For semantic model edits, apply [production-method.md](../video-router/references/production-method.md) before source analysis and delivery checks. EDIT does not imply local assembly: one directly delivered semantic edit has `is_generation:true`; follow its lightweight input and output checks. The deterministic loop and local audio mastering below apply only when actually performing local edits.

## Captions on an existing generated video

A follow-up on a video with a production plan stays with that plan, even when the
change is small. For caption-only changes to one completed generated clip, keep
its original generate segment and update `tracks.captions.lines` with exact text,
`start_sec` and `target_sec`. Author only the requested delta. Use the existing
Gate B amendment with the current user instruction as authorization, then call
`video_studio` with `op:"production.edit"` and `plan_path`. The host reuses the
recorded original footage, runs the existing subtitle engine, registers a new
output and writes the final locator. Repeat caption revisions use that original
footage, never the previous burned-in caption version. Read the returned output
path and check it with `production.status` before presenting it. Do not use the
standalone edit script or regenerate footage for this case. Other EDL operations
and standalone trims/concats keep the paths below.

## Intelligent edit contract

Write `project/plan.json::edit_strategy` whenever VideoStudio decides what to change rather than merely executing user-supplied timecodes:

- `mode`: `deterministic` for transcript/scene/silence/quality/vision-driven timeline decisions, `semantic` for AI pixel changes, or `mixed` when both are necessary.
All four fields below are non-empty arrays of strings — one entry per item,
never a single sentence. `objectives` is the one most often written as prose;
the validator rejects a bare string with `E_EDIT_STRATEGY_BOUNDARY`.

- `objectives`: the exact editorial or pixel-level changes requested, one per entry.
- `decision_signals`: the provenance list of evidence actually used (`timecode`, `transcript`, `scene`, `silence`, `quality`, `vision`, `semantic_model`). Include each supplied or analyzed signal that supports the decision, not only the signal used to execute it.
- `preserve` and `may_change`: non-overlapping boundaries. `may_change` must name every class of change the user authorized — omitting one silently narrows the plan's declared authority below what they asked for.

Declare every source/reference image or video in top-level `references` with `media_type`, reproduce/edit/guide intent, `intent_basis`, roles, required state, preserve/may-change, and target segment ids. This applies to deterministic trims/highlights as well as semantic edits: `spec.input_id` and `edit_strategy` do not replace the top-level source contract. User-declared requirements override defaults; only an unspecified reference defaults to guide/inferred. Video reproduce/edit/motion/timing contracts need one `{source_start_sec,source_end_sec,target_segment_id}` temporal anchor for every targeted segment. A semantic video edit is represented as `source:"generate"`, `media_kind:"video"`, `operation:"edit"`, with the original in `reference_video_paths`/`reference_video_urls`; it still belongs to the EDIT workflow and its count enters Gate C.

## How to call the media scripts

Use these `run-skill` entry points whenever this document says `stage-edit edit_video --op ...` or `stage-edit analyze_media --op ...`. Exception: transcription runs through the required built-in `video_studio` tool with `op: "speech.transcribe"`. Compatibility is handled by the marketplace `min_app_version` field before install.

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op probe --input raw/clip.mp4
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op trim --input raw/clip.mp4 --start 12 --duration 8 --output project/cuts/seg-1.mp4
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op extract_frame --input raw/screen-recording.mp4 --start 3 --output project/frames/screen-3s.png
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
entry and outputs derived from it. Reuse the source probe, transcript and observed frames,
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
`spec.input_id`, open the gate resolver, re-probe, retranscribe, or re-inspect unchanged frames.
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
2. **Plan — use the canonical EDL.** For plan-backed work, record the chosen cuts, order, captions, and overlays in `project/plan.json` using `stage-plan`'s schema, then follow the Gate B transition owned by `gate-control`. Keep each `spec.in_sec`/`spec.out_sec` within its probed source duration. For a one-shot deterministic trim or concat, use the requested timecodes directly and write no plan.json.
3. **Execute in order.**
   - `trim` each segment to its own file (`project/cuts/seg-1.mp4`, ...).
   - `concat` the cut files (in plan order) into one (`project/render/edited.mp4`).
   - If subtitles: `burnsubs` the `.srt`/`.ass` onto the concatenated video. Do not bypass `burnsubs` with a manual ffmpeg subtitle/overlay command if the tool fails.
   - If an overlay (logo / lower-third image / PiP): `overlay` it at the planned position.
4. **Publish** the final file.

## Conditional transcript, localization, and screen-grounded narration

For topic-based highlight selection, automatic captions, localization/dubbing,
or narration added to existing footage, read
[transcript-and-screen-grounded-editing.md](references/transcript-and-screen-grounded-editing.md)
before authoring the EDL or generating speech. Ordinary known-timecode trim,
concat, overlay, and audio-only operations do not load this branch.

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

- **Timecodes come from the user, probe, a transcript, or inspected frames with recorded extraction times — never guessed.** A sampled frame proves only that moment; inspect nearby frames to locate a transition. If the target moment remains unclear, ask the user for the timestamp.
- **Layer composition over footage when the brief needs designed elements** (animated lower-thirds, kinetic captions, hooks): produce those with the composition skill as an overlay/element and `overlay` them, rather than trying to draw them in ffmpeg.
- **One output file** at the end; intermediate cuts live under `project/cuts/` and are not the deliverable.

## Boundary / non-goals

This skill owns the EDIT workflow. It executes deterministic EDL operations directly and delegates only bounded semantic pixel changes to the signed video-edit provider path. It does not author HTML compositions. For transcript/scene/silence/quality-driven selection, use stage-decide first and persist its evidence in `edit_strategy` and per-segment reasons.
