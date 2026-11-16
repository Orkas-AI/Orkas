# Transcript and screen-grounded editing

Use this reference only for topic-based highlight selection, automatic
captions, localization/dubbing, or narration added to existing footage.

## Transcription-driven selection and localization

When the user wants highlights or clips "about X", automatic captions, or a
localized version, transcribe first with `video_studio`
`op: "speech.transcribe"` and `timestamps: "word"`:

- **Highlight / clip selection:** read the transcript, choose the time ranges
  whose words match the requested topic or moment, and use those `start` and
  `duration` values in your cut list. The timecodes must be evidence-based, not
  guessed.
- **Auto-captions:** make the `.srt` from a transcript of the finished cut, not of the source: every cut
  moves the times after it. First correct misheard names, numbers and product words against the script
  or the product facts (one test heard 户眼 for 护眼 and 无极 for 无级). Break captions at punctuation or a
  pause. Then use `burnsubs`.
- **Localization / dubbing:** keep the picture and its timing unless the user
  asks for a recut. Reuse a suitable existing dub first: map complete lines to
  the source phrase windows, splitting existing audio only at measured word gaps.
  Translate and voice only a missing or incorrect line, or one whose measured
  speech exceeds its window. Adjust and re-voice that line at most once within
  the existing spending authority; report a remaining mismatch, not a full retry.
  A short line or silence warning alone is not a reason to regenerate, add filler
  words, trim or speed the picture. Check whether a gap is intentional or missing
  speech. These fixed-picture constraints govern generic advice to change scene
  length. Place existing line files with `stage-edit edit_video --op mix`, using
  `--audio-segments` entries with `path`, `start` and `end` in source seconds and
  `--on-existing-audio replace`. A window failure leaves the original files intact. The dub replaces the original voice; do not
  stack it on top. Burn translated captions separately. Look at a frame first:
  when the original captions are burned into the picture, burn the new ones
  with `burnsubs --cover <top>,<bottom>` over that band, so the old line never
  shows beside the new one. Prices, sizes and other figures keep the source's
  numbers and currency: "199 元" becomes "199 yuan", never "$199", unless the
  user gives the new figure.

## Ground narration on on-screen text

Adding narration to an existing video goes in this order. Do not synthesize one narration blob and describe it afterward.

1. **Analyze the video first.** Probe duration and audio presence. For spoken
   audio, run `video_studio` `op: "speech.transcribe"`. For title cards,
   slideshows, screen recordings, or other on-screen content, use
   `stage-edit edit_video --op extract_frame` and inspect the returned files
   with the current model. Follow the frame-evidence rules below.
2. **Write one line per on-screen beat**, each with its start and target length,
   derived from what you observed. Save them in a small file in the production.
   Keep each line separate so a follow-up can re-voice one line.
3. **Generate them.** Run `generate_speech` once per line with `target_duration`.
   If one line does not fit naturally, shorten it and retry once. Coverage should
   span the clip rather than stop midway.
4. **Assemble without changing the picture.** Place every line at its start in one
   `stage-edit edit_video --op mix` call via `--audio-segments`, then run
   `--op normalize_loudness`. Use `--on-existing-audio mix` to retain source
   sound or `replace` to drop it. Burn captions separately when wanted.
5. **Deliver** with `video.ship`, passing `expect_audio: true`.

If the clip has no spoken audio, or meaning lives in on-screen text, an empty
transcript does not mean an empty screen. Resolve evidence in this order:

1. Extract a small set of frames spanning the whole clip, then inspect them
   with `read_files` using the current model's vision. Record each frame path,
   extraction time, readable text and uncertainty. Add nearby frames only where
   needed to locate a change or resolve unclear content; a sample is not an
   exact transition boundary. Align each narration line to observed evidence.
2. If the current model cannot read images, ask for readable text with timing
   or a vision-capable model. Do not invent on-screen content, install a local
   recognition engine, or escalate to a separate paid vision model.

Before the draft, confirm every narration segment matches the observed-frame or transcript
evidence in its time window.
