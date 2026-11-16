# Timed file overlays and music transitions

Use schema 3 for optional `tracks` alongside the sequential `segments`. Keep the original schema-1/2 project before upgrading. These are local edits of supplied files. Effects remain supplied files. Transitions do not imply beat matching.

Segment edits and project cleanup finish before overlays. Every track's `at_sec` uses that processed narration clock, not the original recording clock. Only the assembled narration drives music ducking; effects and other music never become its control signal. Retain original narration gain with `export.normalize_loudness:false` when requested; export/duck parameters belong to [media-delivery.md](media-delivery.md).

| Track field | Meaning |
| --- | --- |
| `id`, `kind`, `path` | Stable unique id, `music` or `effect`, and project-relative source file |
| `at_sec` | Start on the final narration clock, default 0 |
| `start_sec`, `end_sec` | Source trim, default 0 to source end |
| `duration_sec` | Audible track length after looping/truncation, default trimmed source length |
| `loop`, `loop_crossfade_sec` | Loop only when requested; default false/0. A positive crossfade requires looping and must be shorter than half the source window. |
| `volume` | Linear gain, default 0.15 for music or 1 for effects |
| `fade_in_sec`, `fade_out_sec` | Track-local envelope, default 0. Overlap separately placed music tracks with these envelopes for a supplied-music transition. |
| `duck` | Music-only boolean/object; the same controls as legacy `music.duck` |

Use at most 32 file tracks, including legacy `music`. Existing `music` still loops to narration length; avoid listing it again as an explicit track unless layering is requested. Explicit tracks end at their requested duration; the output lasts through the longest narration/track endpoint. Extract a selected audio stream before using a multistream file. Code owns path, source-identity, resource and parameter validation.

This example uses a four-second recording, two two-second music files and a short effect: music changes at two seconds and the effect starts at one second, while narration stays continuous. The positions illustrate this request, not a fixed recipe for other tasks.

```json
{
  "schema_version": 3,
  "roles": {},
  "segments": [{ "id": "recording", "path": "sources/recording.wav" }],
  "tracks": [
    { "id": "first-music", "kind": "music", "path": "sources/music.wav", "at_sec": 0, "duration_sec": 2 },
    { "id": "second-music", "kind": "music", "path": "sources/other.wav", "at_sec": 2, "duration_sec": 2 },
    { "id": "effect", "kind": "effect", "path": "sources/effect.wav", "at_sec": 1 }
  ],
  "export": { "format": "wav", "channels": 1, "normalize_loudness": false }
}
```

For a music-only loop, use the supplied music as a muted base segment (`volume:0`) and as the audible `music` track with explicit duration/loop/envelope settings; no narration is needed. Invoke the existing `audio render` operation with the saved project. Keep sources and prior exports. Word cuts or silence changes invalidate old subtitle timing; transcribe the final audio when subtitles are requested.
