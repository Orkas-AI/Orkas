# Extraction, conversion and mix delivery

These operations use bundled FFmpeg locally, without another model, API key or service credits. Copy supplied media into the project's `sources/`; a temporary extraction/conversion request project may have empty `roles` and `segments`. A reusable project delivered to the user must instead retain source segments as described below. Every request still names the absolute project JSON path.

## Extract or convert supplied media

Use `audio extract` with `input_path` for a separate audio file from video or another container. Its default `format:"copy"` remuxes the original codec without re-encoding. The host selects a compatible extension (for example AAC becomes M4A); if it cannot package that codec, choose an explicit conversion format with the user instead of silently replacing the request for original encoding.

Use `audio convert` with `input_path` and a target `format` for an audio format change. Both operations take optional request `export` settings from the table below. They do not render project segments, apply processing/music or normalize loudness. Without explicit rate/channel/precision settings, conversion retains compatible source properties; lossy encoding or a format's limitations can affect precision and timing slightly. Increasing bit depth or converting a lossy source to WAV/FLAC cannot restore lost detail.

Call `probe` when needed to inspect tracks. For multiple audio tracks, set `audio_stream` to the requested zero-based audio index; otherwise ask which track is wanted. Do not guess a language from track order. A file with no audio reports a clear boundary. Transfers accept regular media up to 8 GiB and four hours, limit output to 2 GiB, reject playlists/network protocols and share a 30-minute total deadline. They publish a new folder only after decode/integrity checks, preserving source and previous results. Cancellation cleans only the unfinished candidate; rerun local work after resolving its cause.

## Export settings

Save effective rendering settings in the project's optional `export` object. For format-only conversion delivered with a reusable project, retain the original audio as a source `segments[].path` and explicitly save the delivered `format`, `sample_rate`, `channels`, applicable `bit_depth` and `normalize_loudness:false`; conversion's source-preserving defaults differ from render's defaults. Preserve unrelated existing edit settings in their original project and save a separate conversion-project revision when necessary. `audio render` also accepts request `export` overrides and its legacy `format` override. Pure extraction/conversion use only their request settings, so an existing project's treatments cannot leak into a format-only task.

For example, a single-track 48 kHz mono PCM16 source converted to WAV can be retained in a separate conversion project as:

```json
{
  "schema_version": 1,
  "roles": {},
  "segments": [{ "id": "recording", "path": "sources/recording.wav" }],
  "export": { "format": "wav", "sample_rate": 48000, "channels": 1, "bit_depth": 16, "normalize_loudness": false }
}
```

Use the actual source and delivered specifications, not this example's values. Before linking a reusable conversion project, reopen and render that saved revision without request overrides; compare its format, rate, channels, precision and duration with the delivered audio. Verify retained samples for lossless PCM conversion; lossy encoding is not byte-identical. Link the verified revision. A conversion request containing `input_path` is not itself a reusable editing project.

| Field | Values and defaults |
| --- | --- |
| `format` | `mp3`, `wav`, `flac`, `m4a`, `aac`, `ogg`, `opus`. Render defaults to MP3; convert requires a target. `copy` is extraction only. |
| `sample_rate` | 8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200 or 96000 Hz. MP3 stops at 48000; Opus accepts 8000/12000/16000/24000/48000. Render defaults to 48000; pure conversion retains a compatible source rate. |
| `channels` | 1 or 2. A render of one file-backed segment with a single mono or stereo stream and no music or timed tracks defaults to the source channels. Other renders default to 2. Pure conversion retains compatible source channels. |
| `bit_depth` | WAV: 16/24/32; FLAC: 16/24. Omit for lossy formats. Render WAV defaults to 16; pure WAV conversion retains compatible source integer precision. |
| `bitrate_kbps` | Lossy target bitrate: MP3 supports MPEG rates from 32–320 (at most 160 below 32 kHz); M4A/AAC/OGG 32–512; Opus 6–512. Defaults: Opus 128, other lossy formats 192. |
| `normalize_loudness` | Boolean. Render defaults to true for text-backed synthesized speech alone and false when it includes any file-backed segment, music or timed track. Conversion/extraction requires false or omission. |
| `target_lufs`, `true_peak_db` | Rendering with normalization only; defaults -16 LUFS / -1.5 dB, ranges -70 to -5 / -9 to 0. Setting either target enables normalization if the toggle is omitted. |

A copy extraction cannot change encoding settings. Preserve explicit user exclusions: format-only work uses `convert`/`extract`; a render that must retain original level uses `export.normalize_loudness:false`. Revisions to export settings do not require another speech request. Link the resulting audio; keep the machine receipt available without making a separate report a delivery prerequisite.

For an exact re-export of an older delivery, use its `receipt.json` `export` settings as the render request override if the project omitted them. The receipt records the effective loudness setting used for that delivery. If its `export` omits `channels`, use the measured top-level `channels` to reproduce its layout.

## Background music ducking

For requested automatic music reduction under speech, set `music.duck:true`; false or omission preserves fixed music gain. The assembled speech track controls only the supplied background music, with smooth attack/release and restoration during pauses. This needs separate speech and music inputs.

Optional `music.duck` object fields: `threshold_db` (default -34, range -60–0), `ratio` (10, 1–20), `attack_ms` (20, 0.01–2000), `release_ms` (400, 0.01–9000). `music.volume` still controls the base gain. Store the selected settings in the project for later adjustment or undo. A sound-level detector is not proof of speech identity or a guarantee of the mix's perceptual quality.

For timed file overlays, loop crossfades or transitions between supplied music files, read [timeline-mixing.md](timeline-mixing.md).
