# Audio project format

Author `voice-project.json` in a topic-named workspace directory. JSON is the editable source of truth; the script owns `.voice-state.json`, `.voice-lock`, `speech-*.wav`, transcript folders and export folders. Do not edit its state to make a failed/uncertain attempt appear successful.

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

Replace placeholders with capability results; omit `music` when none was supplied. Transcription-only projects use `roles:{}` and `segments:[]`.

- At most 200 ordered segments per chapter. Each has a stable unique id and either `text` + `role` or `path`.
- Speech text: 1–1500 characters. Split at natural sentence/paragraph boundaries, preserve user text unless adaptation was requested, and use smaller segments when the provider imposes a lower limit.
- Role `speed` changes speech generation. Segment `speed` adjusts an existing recording without a new TTS call (0.5–2). Do not use both to accidentally double-speed speech.
- Optional segment edits: `start_sec` (default 0), `end_sec` (default source end), `volume` (0–4, default 1), `speed` (default 1), `gap_after_sec` (0–60), `fade_in_sec`, `fade_out_sec` (0–60), `denoise` (boolean, basic noise reduction only).
- Music loops to the narration length. `volume` is linear gain, default 0.15; choose a lower value when it competes with speech. No music is generated or fetched implicitly.
- Speech identity depends on text, route, voice, language, role speed and explicit `take` (default 0). Ordering, gaps, trimming and mix changes reuse the recording. A deliberately requested retake increments that segment's integer `take`; never increment it automatically to bypass an uncertain request.

Call `status` after edits to see which speech recordings are pending/ready/stale/uncertain. A missing or changed recording remains stale until recovered or explicitly regenerated. The script validates file containment and parameters; do not work around rejected paths with an external command.

Every request JSON contains `project`. Additional fields by operation:

| Operation | Fields | Result |
| --- | --- | --- |
| `status` | none | Current segment state and synthesis identities |
| `begin` | `segment_id` | Durable uncertain attempt, key and exact TTS request |
| `record` | `segment_id`, `key`, optional `output_path` from tool receipt | Verified audio file, digest and measured duration |
| `probe` | `input_path` | Audio duration, sample rate and channels |
| `transcribe` | `input_path`, optional `language` | New TXT/SRT/JSON transcript folder |
| `render` | optional `format`: `mp3` or `wav` | New export folder, measured duration and output files |

Use absolute output paths returned by `begin` with `generate_speech`; use the actual written path from its receipt with `record` if the host renamed it. Exports include an audit-only `plan-snapshot.json`. Link the original `voice-project.json` for revisions; its sources and ready recordings remain in the original project directory.
