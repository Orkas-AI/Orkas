# Transcript and screen-grounded editing

Use this reference only for topic-based highlight selection, automatic
captions, localization/dubbing, or narration added to existing footage.

## Transcription-driven selection and localization

When the user wants highlights or clips "about X", automatic captions, or a
localized version, transcribe first with `video_studio`
`op: "speech.transcribe"` and `timestamps: "word"`:

- **Highlight / clip selection:** read the transcript, choose the time ranges
  whose words match the requested topic or moment, and feed those
  `start`/`duration` values into the `edit_decisions` segments. The timecodes
  must be evidence-based, not guessed.
- **Auto-captions:** turn the transcript into an `.srt`, then use `burnsubs`.
- **Localization / dubbing:** transcribe, translate, synthesize the translated
  narration, then use `stage-edit edit_video --op mix` with
  `--on-existing-audio replace`. The dub replaces the original voice; do not
  stack it on top. Burn translated captions separately.

## Ground narration on on-screen text

Adding narration to any existing video is plan-first and ordered. Author
`project/plan.json` before generating speech and let it drive generation. Do
not synthesize one narration blob and describe it afterward.

1. **Analyze the video first.** Probe duration, run
   `stage-edit analyze_media --op ocr` for on-screen text, and run
   `video_studio` `op: "speech.transcribe"` for spoken audio. For title cards,
   slideshows, and screen recordings, OCR is mandatory rather than a fallback.
   Do not describe the product from memory.
2. **Author `project/plan.json` as the segments EDL.** Use the exact
   `stage-plan` skeleton. `source` is the method enum `edit`, not a file path;
   the clip belongs in `spec.input_id`, duration uses `target_sec`, and
   `tracks` is an object. Carry only the requested delta—keep the picture and
   add narration:
   - Add one primary `edit` segment spanning the source timeline with
     `source:"edit"`, `layer:"primary"`, the clip length as `target_sec`, and
     `spec.input_id`/`in_sec`/`out_sec` covering the clip. Do not add crop,
     scale, or reframe unless requested.
   - Add `tracks.narration`. Copy
     `synthesis:{route_ref,voice_ref,display_name,language,speed}` from
     `video_studio speech.capabilities` for the deliverable's exact BCP-47
     language. Create one `{ text, start_sec, target_sec }` line per on-screen
     beat, derived from the OCR/transcript table before TTS. Never invent a
     voice id or use one paragraph for the whole clip.
   - Use `delivery_promise:{ type:"source_led", source_required:true }` and set
     `aspect` from the source's probed dimensions.
   Keep each narration line separate so a follow-up can re-voice one line.
3. **Generate from the plan.** Run `generate_speech` once per narration line
   with `target_duration` equal to its `target_sec`, save it under
   `project/assets/narration/line-XX.mp3` or another `project/...` path, and
   record `produced_path`. Estimate copy length before generation. If one line
   does not fit naturally, shorten it and retry once; use deterministic
   assembly for small residual timing differences. Coverage should span the
   clip rather than stop midway.
4. **Assemble without changing the picture.** Pass the source video through
   with `-c:v copy`. Place every narration line at its `start_sec` in one
   `stage-edit edit_video --op mix` call via `--audio-segments`, then run
   `--op normalize_loudness`. Use `--on-existing-audio mix` to retain source
   sound or `replace` to drop it. Burn `tracks.captions.lines` separately when
   present. Record line status/paths and the top-level draft/video paths in the
   plan. Never pre-bake one large narration file.
5. **Self-check before presenting.** Validate the plan with
   `"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" stage-plan video_plan -- --op validate --plan project/plan.json`.
   Every narration line must have a produced path and an OCR/transcript-aligned
   window, coverage must approximate the whole clip, and
   `project/render/video.mp4` must exist.

If the clip has no spoken audio, or meaning lives in on-screen text, an empty
transcript does not mean an empty screen. Resolve evidence in this order:

1. Run OCR across the clip and use its `{startSec, endSec, text}` segments to
   align each narration line to its own window.
2. Only if the OCR runtime is unavailable, extract frames across the whole
   clip and read them with the current model's own vision capability.
3. If neither OCR nor image reading is available, stop and ask the user for a
   short outline of the on-screen beats. Do not write narration from topic
   knowledge or escalate to a separate paid vision model.

Before the draft, confirm every narration segment matches the OCR or transcript
evidence in its time window.
