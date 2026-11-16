# Explainers and tutorials

Read when the video teaches: how something works, why something happens, a
data story, a how-to, or a walkthrough of software from the user's screen
recording (讲解, 科普, 教程, 操作演示). When the subject is the user's own
product, start with [product-source.md](product-source.md); this adds the
teaching. Story, pacing and caption basics are in video-craft §2, §3 and §6.

## Facts (`facts.md`)

- The user's material comes first. For anything beyond it, look it up: load
  the `web` tools and use `web_search` and `web_fetch`. Prefer primary
  sources: official documentation, standards, papers, the maker's own page.
- Record each claim in `facts.md` with its source link and whether the source
  is primary or secondary, as you find it: a later turn or change reads that
  file instead of searching again. On a fast-moving topic, note the source's date and
  say so when it is old.
- State only what a source says. Do not turn "40 minutes down to 2" into "20×
  faster", and do not round a range into one number. An example number you
  made up is marked as an example on screen.
- Work out every number in a worked example with code, not from memory, and
  check each step's logic before it is animated.
- A claim you cannot source stays off screen and is named in the reply.

## Plan (`plan.md`)

- For each scene write what the viewer must understand by its end, in one
  line. The script, the picture and the review all serve that line.
- Carry one worked example through the whole video: one real input taken
  through every step to the result. Start in a situation the viewer knows,
  bring the idea in as the answer, and come back to that situation at the end.
- Choose the shape of each beat before its picture: a misconception turned
  over, before and after, steps, a number that lands, a screenshot with the
  detail circled. Beats of the same shape get different pictures.
- Take misconceptions from real questions people ask (the user's FAQ, forums
  found with `web_search`), not invented ones.

## Show it

- Write the narration as one short phrase per thing on screen and voice each
  with `generate_speech`. Each part appears when the voice names it; a scene
  that shows everything at once and then sits reads as a slide.
- Grow one diagram from the simplest true picture and change it rather than
  cutting to a new one: a bar becomes an axis, a box splits into its parts.
- A label sits on the part it names and arrives with it. The narration does
  not read the on-screen words aloud.
- Charts: keep the numbers in one data file and compute bar heights, positions
  and labels from it, with the same rounding everywhere. Bars start at zero;
  units are shown; a cut axis is said on screen; no 3D or second axis.
  Highlight the series that matters and grey the rest, and let the title state
  the point. Put the source on screen. For the look, see the data-led example
  in [worked compositions](@skill/frontend-design/references/worked-compositions.md).

## Tutorials from a screen recording

One thing every screen tutorial gets right:

- Cut by steps, not by length: never keep just the first part of the
  recording to reach the target. Cut the waits and spinners, and end on the
  screen that shows it worked, even when that comes near the end of the
  recording.

- Look at frames of the raw recording first: the right window, no pop-ups or
  notifications, nothing private. Blur tokens, keys, emails, phone numbers and
  customer data for every moment they show, before anything else; with the
  bundled ffmpeg, cut the region out, `boxblur` it and overlay it back.
- Make an action map (`steps.md`) from the transcript and frames: time, the
  action, its target, and how to treat it (real time, sped up, cut or zoomed).
  Each section is one real step with a short imperative title ("打开设置").
- Narrate what the step is for and what it changes, not where the cursor goes.
- Cut on the click and come back on the loaded page. Speed up long repetitive
  input, label it as sped up and mute it; show the result at real speed.
- Zoom only so something can be read or found. Start the zoom just before the
  action, keep enough around the target to see where it is, return to the
  whole screen between steps, and show a dialog whole. Between nearby targets,
  pan at the same scale instead of zooming out and in. Place the recording in
  the page render and move it with the page's animation, so every move shares
  one easing.
- Find a zoom target on an extracted frame with a coordinate grid over it
  (the bundled ffmpeg's `drawgrid`); a position guessed from the picture alone
  is often far off.
- Use at most two cues at once, a highlight or a zoom, shown just before the
  action. Check a frame at the size the video will be watched: phone size for
  an upright video, full screen for a wide one.

## Review before delivery

- Before rendering, write three to five questions from the plan's
  understanding lines. After rendering, answer them from the delivered video
  alone (its transcript and frames). A question you cannot answer marks the
  scene to fix.
- Look at `video.sheet` as a stranger would: anything you would have to
  explain is a fix. Then cover the words: the pictures should still carry the
  idea. Check the sheet at phone size.
- Read the final narration against `facts.md`, line by line.
