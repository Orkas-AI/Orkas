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
  or the product facts (one test heard 户眼 for 护眼 and 无极 for 无级). With neither, correct what the
  sentence around a word makes plain (坑 heard as 康) and keep the rest as heard; do not stop to ask the
  user for a script. Break captions at punctuation or a pause. Then use `burnsubs`.
- **Localization / dubbing:** keep the picture and its timing unless the user
  asks for a recut. For a timing repair, use the picture before dubbing and map
  each original utterance to one separate row of the existing dubbed speech.
  Supply the source utterance's start and end as that row's picture window.
  Run the captioned mix with `--fit-dub` on the existing sound first. It measures
  the lines, can place them in adjoining source pauses, and aligns the last
  line to the source's speech end within its window. On success use the
  resulting file. If `dub_fit_issues` names a line, check that row's audio and
  window. Re-voice only a missing or incorrect line or one confirmed too long,
  at most once within existing spending authority. Keep all the fitting rows
  and use the same source picture if a correction is needed. For multiple new
  lines, follow [fixed-picture synthesis](#fixed-picture-synthesis).

  For dubbed speech and captions together, use one
  `stage-edit edit_video --op mix` with `--on-existing-audio replace` and
  `--audio-segments`. Each row has `path`, `start` and `end` (the picture
  window in seconds), and `caption` (the spoken translation). To reuse lines
  from one recording, use its timed word gaps and add `source_start`
  and `source_end` (the bounds of that line **in the dub audio**). When a
  line is already its own file, pass that file without slice bounds.
  This mix cuts and places each line and burns its caption at the measured
  placement. If a line does not fit, use the returned segment number to fix
  just that line. For burned-in original captions, open a single full-size
  source frame where the old letters are visible (`extract_frame --start` at
  a spoken line). Measure the top and bottom of the old letters from that
  frame's top edge. Divide both by the full frame height and pass them as
  `--cover <top>,<bottom>`. Check the same timestamp in the candidate. If
  the cover needs adjustment, run the captioned mix on the original picture
  with the corrected band. The mix already burns the new captions. Use the
  measured source picture length as `expect_duration_sec` on each
  fixed-picture delivery.
  Prices, sizes and other figures keep the source's numbers and currency:
  "199 元" becomes "199 yuan", never "$199", unless the user gives the new figure.

## Ground narration on on-screen text

Adding narration to an existing video goes in this order. Do not synthesize one narration blob and describe it afterward.

1. **Analyze the video first.** Probe duration and audio presence. For spoken
   audio, run `video_studio` `op: "speech.transcribe"`. For title cards,
   slideshows, screen recordings, or other on-screen content, use
   `stage-edit edit_video --op extract_frame` and inspect the returned files
   with the current model. Follow the frame-evidence rules below.
2. **Write one line per on-screen beat**, each with its start and target length,
   derived from what you observed. Save them in a small file in the production.
   Use ordered, non-overlapping windows within the measured picture duration.
   Keep each line separate so a follow-up can re-voice one line.
3. **Generate them.** Follow [fixed-picture synthesis](#fixed-picture-synthesis).
   Coverage should span the clip.
4. **Assemble without changing the picture.** Place every line at its start in one
   `stage-edit edit_video --op mix` call via `--audio-segments`, with the picture
   window's `start` and `end` in every row. Then run
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

## Fixed-picture synthesis

Reuse any existing takes that fit. When `generate_speech` offers batch timing
checks, use them for multiple lines that need new speech in the same voice.
Use any pace measured in this turn. Otherwise, generate and keep the first
planned take if it fits. Call `preflight` with the same voice settings and
check only the remaining lines that still need synthesis, in batches of at
most 50. See [audio guidance](@skill/video-studio/references/audio.md) for the
tool and voice catalog recovery.

Keep the picture and each window's start and end. Shorten flagged text only when
editing is allowed, then rerun the check on the revised lines. If verbatim
wording has an unresolved timing conflict, say whether it is estimated or
measured and ask the user how to proceed. Generate each remaining line with
`target_duration`. Verify the actual audio in the mix. Re-voice a line that
runs over its window at most once within existing spending authority.
