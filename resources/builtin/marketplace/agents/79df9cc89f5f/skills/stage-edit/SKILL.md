---
ownerAgent: 79df9cc89f5f
name: stage-edit
description_zh: 用 ffmpeg 处理真实素材：剪、拼、转比例、混音、烧字幕、加角标、抽帧。
description_en: Work on real footage with ffmpeg: trim, join, reframe, mix, burn subtitles, overlay, extract frames.
---

# stage-edit

The user's footage stays untouched: every operation writes a new file. An uploaded clip arrives as an attachment marked `model_readable="false"`. That means it is not vision input, not that it is unusable. `video.import` copies it into the production's `media/` folder; use that copy from then on. Never ask the user to upload it again.

## Calling

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op probe --input media/clip.mp4
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op trim --input media/clip.mp4 --start 12 --duration 8 --output cuts/seg-1.mp4
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op concat --inputs cuts/seg-1.mp4,cuts/seg-2.mp4 --output render/edited.mp4
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op extract_frame --input media/clip.mp4 --start 3 --output frames/at-3s.png
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-edit edit_video -- --op reframe --input media/clip.mp4 --aspect 9:16 --output render/clip-9x16.mp4
```

Other ops: `burnsubs` (`--subtitles x.srt`), `overlay`, `mix`, `loudness`, `normalize_loudness`, `trim_silence`, `remove_fillers`. Scripts return JSON; a non-zero exit means it failed. `speech.transcribe` is a `video_studio` op.

`reframe` writes the standard canvas for the aspect. `--mode pad` keeps the whole frame on bars, `blur` fills them with a blurred copy, `crop` cuts the edges (`--focus-x`/`--focus-y` choose what stays). Keep `pad` or `blur` when the frame carries text or a UI. To follow whoever is speaking, `--plan` crops on a different point per stretch (`[{"start": 0, "centre_x": 0.3}, …]`, fractions of the source); `analyze_media --op activity --regions` measures motion in a box around each mouth and returns turns and a ready plan. `analyze_media --op beats` lists a track's beats with their frames; on a cut video it also says how far each cut lands from its beat.

`concat` joins clips of different sizes and rates by moving them all onto the largest canvas and highest rate, adding silence to silent clips. So reframe first: a 9:16 clip joined to a 16:9 clip becomes a letterboxed box.

`mix` lays narration or music over a clip (`--audio`, or `--audio-segments '[{"path": "voice/1.mp3", "start": 0}, …]'` to place each line at its own start, in seconds). If the clip already has sound, pass `--on-existing-audio mix` to keep it or `replace` to drop it. With `mix`, add `--duck` to lower the original sound only while the added sound plays, such as narration over a scene's ambience. Narration never plays over someone talking in the clip: delivery reports it. For a narration-only recap revision, mix from the saved pre-narration cut with its original dialogue (for example, `render/pre-narration.mp4`). Reuse unchanged voice files at their existing offsets and replace only the changed lines. For fixed-picture dubbing, `--audio-segments` entries may declare an `end` as well as `start`; all entries then need ordered picture windows. The script measures existing speech before mixing and refuses a line that exceeds its window without generating audio or shortening the picture. Before processing localization audio, read [localization guidance](references/transcript-and-screen-grounded-editing.md); it owns picture timing, reuse and bounded re-voicing.

Put the intended caption characters directly in a UTF-8 subtitle file with `write_file`, then pass its path to `burnsubs` with `--subtitles`. Keep escape notation when it was requested as literal text.

`burnsubs` uses one placement for plain SRT dialogue captions and raises it on vertical video to clear platform buttons. For separate positions or custom contrast, write a styled `.ass` file in the production folder and pass it to `burnsubs`. Inspect source frames before positioning text. Honor requested placement. Otherwise choose stable positions clear of other text and important faces, products, labels and controls. Check moving content across its relevant motion. Use a caption fill that contrasts with the actual background, or use an outline or small backing to keep it readable as the background changes. Check the wording, placement and legibility in the delivered frames. Adjust text position, wrapping and readable size while preserving source framing. When the picture already has captions burned in, as when making another language's version, `--cover <top>,<bottom>` (the old captions' band, as fractions of the height read off a frame) lays an opaque bar over them and puts the new captions on it.

When no op covers it (rotate, speed change, GIF), run the bundled `ffmpeg` from bash; `$ORKAS_BUNDLED_FFMPEG` holds its path. Write to a new file, pass `-nostdin`, bound every input, then `probe` and `extract_frame` to look at the result. Keep caption text out of inline `drawtext` arguments, where filter escaping and font selection can change what the viewer sees.

## Which tool

- One step (trim 0:10–0:35, make it 9:16, compress): do it, then `video.ship` with `expect_*`.
- Finding what to keep (remove dead air, fillers or retakes, pick the best take, pick highlights, cut 40 minutes to 2): read `stage-decide` first, however short the clip.
- Designed text, price cards or motion: use the page render. For a long cut that needs only a designed title, render just the title with `video.render` and `concat` it on.
- Changing what is in the picture (remove a watermark, change a background): `generate_video` with `operation: "edit"`, which is billed by the configured service, then use the result as an asset.

For anything you may adjust later, save your cut list as a small file in the production (`cuts.json`: source, in, out, why), so the next change redoes only what changed.

Add outputs you reuse in a timeline to `assets.json` with `origin: "edited"`.

## Rules

- **Probe before planning.** A trim past the real length makes a broken clip.
- **Timecodes come from the user, a probe, a transcript or a frame you looked at.** Never guess them. A frame proves only that moment.
- **Cut on sentence and word gaps.** For someone talking, keep picture and sound together.
- **If you cannot see it, do not describe it.** Say so instead.
- **Do not re-transcribe a source you already have a transcript for.** Read only the sentences you need from the saved file.
- **For subjective choices (which moment is best), make a first version and let the user react.** Name the choice in your reply.

## Craft

- Cut the moment, not the clip: a 12s clip usually holds one 3s moment. End on a held look, not on action moving off.
- At most 4 transition types in one piece; a hard cut is the default.
- Do not put the same subject at the same size back to back. If you cannot give a one-line reason for a cut, reconsider it.
- Bridge the hardest cuts with sound.
- Social clip: hook in the first 2 seconds, clean ending, one style across a batch.
- Podcast or interview: pick quotable moments; keep the picture simple and consistent.
- Screen demo: zoom only for legibility, label sped-up sections, keep UI text sharp. A tutorial from a recording follows [explainer guidance](@skill/video-craft/references/explainer.md).
- Localization: each language is its own deliverable. Replace baked-in text.
- Normalize the mix before delivering (`--op normalize_loudness`).

Screen-grounded narration, localization and topic-based selection: [references/transcript-and-screen-grounded-editing.md](references/transcript-and-screen-grounded-editing.md).
