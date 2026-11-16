# Sound

## Music

Short ads need a bed unless the user said otherwise: use a licensed track the user supplies. When no music can be had this turn, do not deliver a silent ad unless the user asked for none. Otherwise give it a short voice-over made with `generate_speech` instead (see Narration), using a configured speech service within the user's spending authority, and say in the reply that it has no music. Never synthesize music in code: it sounds like test tones. A recorded track must allow commercial use (CC0 or CC BY); name its source and license in your reply, and add it to `assets.json`.

Put it on `tracks` with `"volume"` about 0.3, `"fade_out": 1`, and `"duck": true` when there is speech. It plays from 0s and stops at the end of the video. Keep the original recording.

## Narration

Before synthesis or a script-only handoff, follow
[script-timing.md](script-timing.md). Estimates do not replace the measured
duration returned after synthesis.

`speech.capabilities` lists the voices for a language. If none is available, use on-screen text and captions only, and say so; do not stop for it.

Generate one line per scene with `generate_speech`, so a scene takes its voice with it when moved:

```json
{ "text": "孩子写作业总说眼睛累？", "output_path": "lamp-ad/voice/hook.mp3", "route_ref": "...", "voice_ref": "...", "language": "zh-CN", "target_duration": 3 }
```

The result gives the line's `asset_id`, already in `assets.json` with its voice, and its measured length. Set the scene's `narration` to that asset. The scene must be at least that long: lengthen the scene or shorten the line. Do not speed the voice up past 1.15 to make it fit.

To change a line later, generate it again with the voice in its row, under a new file name, and point the scene's `narration` at the new asset. Changing `narration.text` alone changes the captions, not what is heard.

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
