# Short clips from a long recording

Read when the user wants short clips cut from a podcast, interview, livestream,
talk or lesson (切片, 高光片段, 拆条). Reading the transcript, cutting in pauses and
checking the cut follow the `stage-decide` method; this adds what makes a clip
stand on its own.

## Find the moments

- Transcribe once and work from the `phrases` view its result opens with. A
  long view is cut short there: make the whole one with `analyze_media --op
  phrases --output` and read it in parts.
- Work through it in stretches. In each, first list every story, argument or
  answer and where its payoff lands, then make one candidate per payoff: the
  phrase lines it spans, its first and last line quoted, the payoff, and why a
  stranger would watch it.
- Take every time from the phrase view. Never write a time you did not read
  there.
- When every stretch is done, rank all the candidates against each other and
  keep the best; candidates judged one at a time are not comparable. Fewer
  clips than asked for is a fine answer, and so is none when nothing stands
  alone; say so.
- Hook test: read only the clip's first sentence, as a stranger. If it does
  not make you want the next one, start later or drop the clip.
- A clip never makes someone seem to say what they did not mean in context,
  and never joins moments from far apart.

## Where a clip starts and ends

- Do not open on a pronoun with nothing to point to, on 所以/但是/so/but, on a
  bare 对/yeah, a one-word answer or "as I said". If the line answers a
  question, start on the question.
- End where something lands: not on a teaser, not on "the reason is", not after
  the first item of a list; a list the speaker announces is kept whole. When a
  story runs long, keep the tightest version that has both setup and payoff,
  never just its first stretch.
- After a punchline keep the laugh; do not end on a host's one-word reaction.
- Last, reread each clip's first and last sentence as a stranger and move the
  bounds or drop the clip.

## Vertical framing

Trim the clip first, then frame it. Look at a frame from each shot (`scenes`
finds the changes) and frame each shot by what it shows:

- **One person:** crop on them with `--focus-x`.
- **Two people on a still camera:** mark a box around each mouth on a frame,
  as fractions of the frame, and check the boxes by drawing them on that frame
  (the bundled ffmpeg's `drawbox`). Run `analyze_media --op activity
  --regions` on the clip; it returns who moves in each stretch and a `plan` for
  `edit_video --op reframe --plan`. Look at a frame at every turn before
  cutting on it, and move a switch to the pause before the new speaker's line.
  Motion is a stand-in for speech: it fails when people nod, laugh or move
  while the other talks.
- **Three or more people, people talking over each other, slides or a
  screen:** keep the whole frame with `--mode blur`.
- A clip that mixes these: split it at the shot change, frame each part, and
  `concat` them.

## Captions and titles

- Captions come from the clip's own transcript; on vertical video `burnsubs`
  keeps them above the platform buttons.
- A title or hook line on screen says only what the clip says. Name the stakes
  rather than the topic, and do not repeat the first spoken words.

## Delivering a batch

- One file per clip, named in order (`clips/01-<short-name>.mp4`), and a
  `clips.json` listing each clip's source, in, out, title, first line, why it
  stands alone and its rank.
- Deliver each clip with `video.ship`, passing `expect_duration_sec`,
  `expect_aspect` and `expect_audio`.
- Describe each clip from the transcript of the cut file, not from your plan:
  a line cut off at either end shows there, and so does a payoff that did not
  make it in.
- In the reply, list the clips with length, title and why each stands alone,
  and say which calls are judgment the user may want to change.
