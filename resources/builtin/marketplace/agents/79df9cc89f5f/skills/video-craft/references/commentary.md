# Commentary and recap videos

Read when the user supplies a film or drama episodes and wants a narrated
recap or commentary cut from them (影视解说, 电影解说, 短剧解说, 一口气看完).
The picture is the user's footage; the new part is the voice-over. Cutting
follows [stage-decide](@skill/stage-decide) and [stage-edit](@skill/stage-edit);
the voice follows [audio guidance](@skill/video-studio/references/audio.md).

Three things every recap gets right, whether or not you write the files below:

- Leave out title cards, credits, recaps of earlier episodes (前情提要) and
  previews of the next one (下集预告). The last line before an episode's
  credits is usually its preview.
- A preview shows an episode the user did not supply: never tell it as
  something that has happened. End where the last supplied episode ends, or
  name what is coming as a question ("下一集，他会说出真相吗？").
- Keep at least one key line in the characters' own voices. Mix the narration
  with `--on-existing-audio mix --duck`; `replace` drops every line of
  dialogue.

Work in this order. Each step leaves a file the next one reads; do not write
narration before `scenes.md` exists.

## 1. Rights

Unless the user already said so, ask whether they hold the rights or a licence
to cut and publish this footage, in the same message as any other question. A
recap of someone else's work can be taken down or claimed by the platform; say
so once and go on if they want to. Keep the rights holder's logo and credits
where they appear on screen. The voice is generated: say the video may need an
AI label where it is published, and offer to add a small visible one.

## 2. Scene list (`scenes.md`)

- Per episode: transcribe with word times and work from the `phrases` view the
  result opens with (for a long episode, `analyze_media --op phrases` with
  `--output`), and run `scenes` for shot boundaries.
- Extract a frame from every scene and look at it. Speech recognition mishears
  names and words; when the source has subtitles burned in, they are the
  script and win over the transcript. A name found only in the transcript is
  suspect until a frame or a second line confirms it. If you cannot see
  images, ground on the dialogue and mark every claim about the picture
  unverified.
- One row per scene: source, in, out, who is there, what happens, the key line
  as written on screen or heard, and whether to use it. Mark ads, sponsor
  reads and the parts listed at the top as not used.
- The transcript has no speaker names. Work out who is who from how people
  address each other (a line opening "林总，" is said to 林总, not by her) and
  from frames; mark each speaker as seen, addressed or guessed.
- Facts come only from the episodes supplied. Do not add later plot, behind-
  the-scenes stories or outside details; a lookup may confirm a name and
  nothing more.

## 3. Cut list (`cuts.json`)

- Choose spans from the used scenes, in story order, adding up to about the
  target length. Each span records source, in, out, its sound and why.
- Each span's sound is one of: `original` (the characters say the key line
  themselves: a confession, a slap, a reveal), `narrated` (the source silent),
  or `ducked` (narration over the source's ambience turned down). Narration and
  dialogue take turns and never overlap: two voices at once cannot be
  followed, and turning dialogue down does not fix that. So a `narrated` or
  `ducked` span has no one speaking in it, or is cut silent.
- Alternate: a long run of narration, or of original clips, loses the viewer.
  Narrate over reactions, wide shots and action, not over a close-up of someone
  talking.

## 4. Narration

- One line per `narrated` or `ducked` span, written from `scenes.md`. A guessed
  speaker's action is narrated without naming them. Open on the central
  conflict or question, tell the story as cause and effect, put a bridge line
  at each jump between episodes, places or times, and end where the episodes
  end: the turn, the reveal or the cliffhanger.
- Write for the ear: short sentences, names rather than "he" or "she" when
  several people are on screen. Fit each line to its span with
  [script timing](@skill/video-studio/references/script-timing.md); if it is
  longer, extend the span within its scene or shorten the line, never let the
  picture run on into the next scene.
- A recap over about 2 minutes shows the narration for review before it is
  voiced; a shorter one goes straight on.

## 5. Assemble and check

1. Cut each span with `trim`; cut a `narrated` span silent with the bundled
   ffmpeg and `-an` (`concat` adds silence to clips that have none). `concat`
   them in order.
2. Voice each line with `generate_speech`, `target_duration` set to its span,
   one file per line. Place every line at its span's start in one `mix` call
   with `--audio-segments --on-existing-audio mix --duck`: `original` spans
   play at full level, and no line runs into one.
3. Captions: if the source already has subtitles burned in, do not stack a
   second line on them; crop them off when the framing allows, or place yours
   above them in an `.ass` file. Make captions from the finished cut's
   transcript.
4. `normalize_loudness`, check the cut as `stage-decide` describes (every join,
   the transcript of the cut against `cuts.json`), and deliver.
