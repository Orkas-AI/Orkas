# Estimated word timing and transcript-index edits

Request `audio transcribe` for the original recording with `input_path`, optional known `language` and `granularity:"word"`. This uses the bundled recognizer and returns TXT/SRT plus JSON with `granularity:"word"`, `timing:"estimated"`, `unit:"word-or-subword"`, `source_sha256` and ordered `segments`. Units can be subwords rather than complete words; punctuation or other zero-duration text stays with an adjacent timed unit. This is not forced alignment or speaker identification. For a multistream source, extract the desired audio stream first.

Read the returned units and use context to resolve the requested occurrence. A phrase can span several units, and repeated text can refer to different occurrences. Use inclusive zero-based `first`/`last` indices into the original transcript, rather than searching and deleting every text match. There is no automatic filler matching or speech replacement.

Keep the original project before upgrading to schema 3. On a recorded source segment, set `word_edit` with the project-relative `transcript_path`, `mode:"keep"` or `"remove"`, and ordered non-overlapping `ranges`. The ranges must lie within that segment's source trim window. The script binds the transcript to the source digest and applies the selection before segment speed and project cleanup. If the source changed, transcribe the current original before selecting its units; do not alter its digest or reuse stale timings.

For a transcript whose unit 1 is the requested second timing unit, this example retains all other audio and its level:

```json
{
  "schema_version": 3,
  "roles": {},
  "segments": [
    {
      "id": "recording",
      "path": "sources/recording.wav",
      "word_edit": {
        "transcript_path": "words.json",
        "mode": "remove",
        "ranges": [{ "first": 1, "last": 1 }]
      }
    }
  ],
  "export": { "format": "wav", "channels": 1, "normalize_loudness": false }
}
```

Render from the preserved source with the existing `audio render` operation. For revisions or undo, change/remove the saved `word_edit`; never replace the source with its shortened export. Keep the original transcript and earlier exports. If subtitles are requested after a cut, transcribe the final audio to obtain timings for the current delivery.
