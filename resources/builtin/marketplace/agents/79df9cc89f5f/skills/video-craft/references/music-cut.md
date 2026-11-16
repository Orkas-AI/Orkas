# Cutting to music

Read when the picture is cut to a music track: a montage of clips or photos for
a shop, an event, a trip or a product (卡点, 混剪, 音乐快剪).

## The music

- Use the user's licensed track as
  [audio guidance](@skill/video-studio/references/audio.md) describes. A track
  the user did not supply needs the rights for where it will be posted; ask
  once if that is unclear.
- Run `analyze_media --op beats --input <music> --fps <the video's frame rate>`.
  It returns each beat's time, frame and strength, and bar starts as a guess
  (`confidence: "low"`). When `steady` is false there is no beat to cut on:
  cut on phrases and strong moments instead, or hold shots longer.
- Choose the stretch of music to use: start at a strong bar and end on a bar
  line, with a short fade under the last shot. The video lasts as long as that
  stretch.

## Where the cuts go

- Let the music's energy set how often you cut, read from the beat strengths:
  a shot per strong beat where it is loud, longer holds where it drops. Cutting
  on every beat from start to finish looks automatic; at a fast tempo cut on
  every second or fourth beat.
- Cut on the beat, change a layout or a look on the bar, and put transitions
  where a phrase changes. Save the hero shot (the product, the full room, the
  peak moment) for the strongest beat.
- A move into a hit starts before it; the hit itself is a hard cut. Words on
  screen stay up for at least a beat.
- Photos get a bar each, or a slow push on a calm stretch. Clips play muted
  and the track owns the sound (`mix --on-existing-audio replace`).
- Speed ramps and freezes on a hit work only when used sparingly.

## Frames

- Take each cut's frame from the beat list and make each shot as long as the
  gap between consecutive cut frames. Never add up a fixed beat length: the
  rounding builds up and the later cuts drift off the beat.
- Trim each shot to that many frames (`trim --duration <frames>/<fps>`) and
  join with `concat`; in the page render, set scene lengths the same way.

## Check

- Deliver with `video.ship` and `"cut_to_beat": true`. It checks every cut of
  the delivered file against the beats and names any more than a frame off;
  repair those. The video lasts as long as the music stretch: pass that
  length as `expect_duration_sec` (14.4 for six 4-beat shots at 100 BPM), not
  the round number asked for, and never speed up or slow down the finished
  cut to reach one.
- Bar starts are a guess and you cannot listen: do not claim a cut lands on
  the "one" unless the bar guess and the music's changes agree.
- Never stretch or shift the music to hide a sync problem.
