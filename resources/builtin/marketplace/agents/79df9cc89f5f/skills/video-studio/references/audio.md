# Sound

## Music

Short ads need a bed unless the user said otherwise: use a licensed track the user supplies. When no music can be had this turn, do not deliver a silent ad unless the user asked for none. Otherwise give it a short voice-over made with `generate_speech` instead (see Narration), using a configured speech service within the user's spending authority, and say in the reply that it has no music. Never synthesize music in code: it sounds like test tones. A recorded track must allow commercial use (CC0 or CC BY); name its source and license in your reply, and add it to `assets.json`.

Put it on `tracks` with `"volume"` about 0.3, `"fade_out": 1`, and `"duck": true` when there is speech. It plays from 0s and stops at the end of the video. Keep the original recording.

## Narration

Before synthesis or a script-only handoff, follow
[script-timing.md](script-timing.md). Estimates do not replace the measured
duration returned after synthesis.

`speech.capabilities` lists configured voices by language. If no configured voice supports the requested language, use on-screen text and captions only when the request allows it, and say so.

Generate one line per scene with `generate_speech`, so a scene takes its voice with it when moved:

```json
{ "text": "孩子写作业总说眼睛累？", "output_path": "lamp-ad/voice/hook.mp3", "route_ref": "...", "voice_ref": "...", "language": "zh-CN", "target_duration": 3 }
```

For multiple timed scenes, when `generate_speech` offers `preflight`, first voice
one planned line and keep that take for the scene. Then call `preflight` with the
same voice settings and the remaining `lines`, each with `text` and
`target_duration`. It uses the measured pace when available and lists all
overruns without synthesizing audio. Shorten those lines or redistribute scene
time within the brief, then check the revision before generating it.

When two finalized lines for different scenes are independent, submit two consecutive
`generate_speech` calls in the same tool batch, with separate output paths.
If a line depends on another take's timing, wait for its measured duration before
rewriting or revoicing it.

The result gives the line's `asset_id`, already in `assets.json` with its voice, and its measured length. Set the scene's `narration` to that asset. The scene must be at least that long: lengthen the scene or shorten the line. When the user did not ask for the video's length, make each scene its line plus about half a second, so no scene ends in silence. Do not speed the voice up past 1.15 to make it fit.

To change a line later, generate it again with the voice in its row, under a new file name, and point the scene's `narration` at the new asset. Changing `narration.text` alone changes the captions, not what is heard.
For a change to specific words, such as a price, start from the saved script and replace only those words. Use the original take's measured length as the `target_duration` if known. If the new audio fits its original slot, keep it and leave the remaining time for the existing bed or pause, even if synthesis suggests adding words.
When the edited words are in a whole narration track, revoice that take with its saved voice and point the track at the new asset. If the last delivery was mixed outside the timeline, check its audio and the available source tracks before re-rendering so the sound the user wants to keep goes into the new delivery.

## Captions

`"captions": { "enabled": true }` shows each scene's `narration.text` sentence by sentence, with time shared by length. It needs no audio, so it also works as plain on-screen text. Ads assume the sound is off, so keep them on when there is narration.

For a long cut, burn real timing from `speech.transcribe` with `edit_video --op burnsubs`. See `stage-edit`.

## Footage sound

`"audio": "keep"` on a clip uses its own sound from its `in` point. Use it for people talking or real ambience.

## Levels

The render normalizes the final mix. A file you mixed yourself with ffmpeg should go through `edit_video --op normalize_loudness` before `video.ship`.

For the same unchanged output file, use `video.render`'s `probe`, `media_qa`
and `loudness`, then `video.ship`'s `version.integrated_lufs` and `warnings`
before requesting another measurement. Missing, null or failed measurements
remain unknown. After changing the media, mix or timeline, use fresh results
for the resulting file. This does not replace the normal delivery checks.

Use the existing `stage-edit` `probe` or `loudness` operation for a missing
measurement or a specific concern; other focused measurements may still be
needed for a suspected abrupt ending. Loudness and silence numbers do not
establish that a fade sounds natural.
