# Short films and stories

Read for a narrative short film, a drama episode, a story-led brand film, or any
video whose people or places recur across generated shots. When the story sells
a product, its product facts still follow [ecommerce.md](ecommerce.md).

## The story

- Build it on one dramatic question the length can answer: who wants what, what
  stands in the way, and what changes. A piece under a minute usually holds one
  turn; two to three minutes can carry setup, complication and payoff. Land the
  turn in the picture, not only in narration.
- Keep as few characters and locations as the story allows. Every recurring
  person or place is something each shot must keep the same.
- Tell through action and reaction. Keep dialogue short and in each character's
  own voice; a line that only explains the plot is usually better shown.
- Decide the opening image, the turning-point image and the final image first.
  They carry the story and the cover; spend retries on them before the rest.
- A vertical drama episode opens inside the conflict and ends on a reversal or
  an open question. A later episode reuses the earlier production's cast sheet
  and key images.
- Choose length and shape from the story and platform: 9:16 for vertical drama
  and social, 16:9 for a film. Name them in the final reply.

## Script and storyboard

Write scenes with a heading (place, time of day), action, dialogue and sound.
For each shot, record its purpose, what happens in order, shot size and camera,
the first and last frame as still pictures, who is in it, the spoken line and
its time. Estimate spoken lines with
[script timing](@skill/video-studio/references/script-timing.md).
A script-only request ends with this document.

## Cast and places

Write `cast.md` in the production before you check service availability with
`video.request_budget`:

- For each recurring character, one look line: age, face, hair, build and the
  clothes they keep, in words a camera can see. Then what may change, and the
  voice for any lines voiced separately.
- For each recurring place, its layout, light and time of day.

A later turn or episode copies the exact words from this file.

- Make one key image per character, and per recurring place where it matters,
  with `generate_image` from its look line, and reuse it for every shot. Do not
  remake a key image to fix one shot. A photo the user gives for a character is
  its key image.
- Paste each visible character's look line word for word into every prompt
  that shows them, and into every shot of a prompt with several shots. A model
  reads each prompt, and often each shot, afresh: a name, a pronoun, "the same
  man" or "the person in the reference image" does not carry the look, and
  where the words and the key image disagree the words tend to win. For
  example, with two look lines from `cast.md`:
  `Shot 2 (4-10 s), hard cut: 30 岁左右的外卖小哥，瘦高，黄色雨衣，黑色头盔，递过一袋药；80 岁左右的老奶奶，个子矮小，银白短发，深蓝色棉袄，把门开了一道缝。`
- For each shot, pass the key images of who is visible, plus the last frame of
  the previous shot when the action continues (take it with `stage-edit`
  `extract_frame`), and say which reference governs what ("face and hair from
  image 1, room and light from image 2").
- Some models take reference images or a first frame, not both. When the
  opening must be exact, make the shot's opening still with `generate_image`
  from the key images, check it, then animate it with `first_frame` (add
  `last_frame` when the ending must be exact too). A wrong still costs far less
  to redo than a wrong clip.
- Check each returned clip against the key images: face, hair, build, clothes,
  and which side of the frame each person is on. Name the drift in the retry,
  within the limits in [generation](@skill/video-studio/references/generation.md).

## Continuity

- Keep screen direction: in a conversation, whoever is on the left stays on the
  left; someone leaving frame right enters the next shot from the left. Hold
  wardrobe, props, light and time of day within a scene.
- One generation can hold a few shots of one scene. Number them and give each
  its time and cut ("Shot 2 (3-6 s), hard cut: ..."), with the look lines in
  every shot. People stay closer to themselves and it costs fewer requests;
  redoing one of those shots means generating the whole clip again.
- Shot sizes and camera positions follow video-craft's shot and camera language.

## Dialogue and sound

- When a character speaks on screen, describe the scene first, then who speaks,
  the language and the line in quotes: `the old woman says in Mandarin Chinese:
  "药放门口就行。"`. One short line per shot; frame the speaker at medium or
  closer and keep the camera still while they speak.
- Keep the clip's own sound (`generate_audio` on, `"audio": "keep"` on the clip),
  and set the scene's `narration.text` to the line with no `asset`, so captions
  show it. The clip's own speech follows the mouth; a voice from
  `generate_speech` laid over it does not. Write "No on-screen text or
  subtitles" in that prompt: a service may print the line onto the picture.
- A character's voice can change between separately generated clips. Keep a
  short exchange in one clip where you can; otherwise listen for a mismatch
  before delivering.
- If the clip comes back silent or says the wrong words, generate it again, or
  restage the line away from the speaker's mouth (over the shoulder, back to
  camera, a reaction cutaway) and voice it with `generate_speech` in the voice
  from `cast.md`.
- In shots without dialogue, keep the clip's own sound when its ambience carries
  the scene. Narration, music and levels follow
  [audio](@skill/video-studio/references/audio.md). Leave room for silence at
  the turn.

## Spending

Plan the fewest generated shots that tell the story, and reuse key images and
finished clips. List key images, opening stills and clips together in the one
`video.request_budget` call.

## Review

In `video.sheet` frames and the delivered frames, check that a new viewer can
tell who is who, where they are, what they want and what changed, that each
person looks the same in every shot, and that no generated subtitle or music
doubles the timeline's own. Name the shot and the fix.
