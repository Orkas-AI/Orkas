# Audio project format

Use `voice-project.json` as the initial project name in a topic-named workspace directory. Schema 1 remains valid for existing edits; use schema 2 when adding ordered `processing` steps. Schema 3 also supports optional timed `tracks` and recorded-segment `word_edit`; read [timeline-mixing.md](timeline-mixing.md) or [word-editing.md](word-editing.md) for those routes. Keep the original project before upgrading. JSON is the editable source of truth; the script owns `.voice-state.json`, `.voice-lock`, `speech-*.wav`, transcript/export folders and derived processing caches. Do not edit its state to make a failed/uncertain attempt appear successful.

```json
{
  "schema_version": 1,
  "roles": {
    "narrator": { "route_ref": "<listed route>", "voice_ref": "<listed voice>", "language": "zh-CN", "speed": 1 }
  },
  "segments": [
    { "id": "intro", "role": "narrator", "text": "The approved text to speak.", "gap_after_sec": 0.4 },
    { "id": "recording", "path": "sources/recording.wav", "start_sec": 2, "end_sec": 6, "volume": 1 }
  ],
  "music": { "path": "sources/music.mp3", "volume": 0.15 }
}
```

Replace placeholders with capability results; omit `music` when no track was supplied. Transcription-only projects use `roles:{}` and `segments:[]`.

- At most 200 ordered segments per chapter. Each has a stable unique id and either `text` + `role` or `path`.
- Speech text: 1–1500 characters. Split at natural sentence/paragraph boundaries, preserve user text unless adaptation was requested, and use smaller segments when the provider imposes a lower limit.
- Role `speed` changes speech generation. Segment `speed` adjusts an existing recording without a new TTS call (0.5–2). Do not use both to accidentally double-speed speech.
- Optional segment edits: `start_sec` (default 0), `end_sec` (default source end), `volume` (0–4, default 1), `speed` (default 1), `gap_after_sec` (0–60), `fade_in_sec`, `fade_out_sec` (0–60), `denoise` (boolean, basic noise reduction only).
- Music loops to the narration length. `volume` is linear gain, default 0.15; choose a lower value when it competes with speech. No music is generated or fetched implicitly.
- Speech identity depends on text, route, voice, language, role speed and explicit `take` (default 0). Ordering, gaps, trimming and mix changes reuse the recording. A deliberately requested retake increments that segment's integer `take`; never increment it automatically to bypass an uncertain request.

Schema 2 may add a project-level `processing` array, applied after assembling segments and before music/loudness normalization. See [audio-processing.md](audio-processing.md) for its typed parameters.

Call `status` after edits to see which speech recordings are pending/ready/stale/uncertain. A missing or changed recording remains stale until recovered or explicitly regenerated. The script validates file containment and parameters; do not work around rejected paths with an external command.

Every request JSON contains `project`. Prefer project-relative `input_path` values such as `sources/recording.wav`; existing absolute paths inside the project remain supported. Additional fields by operation:

| Operation | Fields | Result |
| --- | --- | --- |
| `status` | none | Current segment state and synthesis identities |
| `begin` | `segment_id` | Durable uncertain attempt, key and exact TTS request |
| `prepare-record` | `segment_id`, optional `output_path` from a renamed tool receipt | Existing uncertain attempt's immutable `request_file` for `record`; no synthesis, audio verification or state change |
| `record` | `segment_id`, `key` copied unchanged from that segment's current `status`/`begin` result, optional `output_path` from tool receipt | Verified audio file, digest and measured duration |
| `probe` | `input_path` | Audio duration and `audio_streams` with zero-based audio indexes, codecs, rates, channels and known language tags |
| `transcribe` | `input_path`, optional `language`, optional `granularity: segment\|word` (default `segment`) | New TXT/SRT/JSON transcript folder; word mode estimates units for index edits |
| `render` | optional `format`, optional `export` overrides; project `export` supplies saved defaults | New export folder, measured duration, output files and absolute editable `project_path` used for the render |
| `extract` | `input_path`, optional `audio_stream`, `format` (default `copy`), optional `export` | Separate audio track without picture; no project edits or loudness treatment |
| `convert` | `input_path`, target `format` or `export.format`, optional `audio_stream`, optional `export` | Converted audio with preserved levels and timing |

The optional project `export` and `music.duck` fields are defined in [media-delivery.md](media-delivery.md). They do not change speech identity. Extraction/conversion use request settings only and ignore the project's render treatment.

Use absolute output paths returned by `begin` with `generate_speech`; use the actual written path from its receipt with `record` if the host renamed it. Before delivery, check that the render's `project_path` matches the saved revision and that `plan-snapshot.json` records the intended edits. Link that `project_path` with the rendered audio, retaining its sources and ready recordings. Save a separate revision when prior edits must be preserved. The snapshot is for audit only.
