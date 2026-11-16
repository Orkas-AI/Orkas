# Local transcription, editing and delivery

For video audio extraction, format conversion, export specifications or background music ducking, read [media-delivery.md](media-delivery.md). Pure extraction/conversion preserves levels and timing; ordinary project rendering retains its loudness-normalization default.

For timed overlays or supplied-music transitions, read [timeline-mixing.md](timeline-mixing.md). For word-time transcription or selecting transcript units to cut, read [word-editing.md](word-editing.md); those timings are estimates, not forced alignment.

For transcription, copy the recording into the project and call `transcribe` with `input_path` and an explicit language when known. It runs the bundled Whisper model and returns TXT, SRT and JSON with segment timestamps. Retain the raw recognized wording; requested corrections should be a separate edited transcript. No automatic speaker identification or exact forced alignment is promised. An empty transcript is an observed result, not proof that the source contains no speech.

For cuts and mixes, model the requested sequence as project segments. Probe before choosing trim windows. Reorder/reuse sources by reference, use gaps for silence, fades at joins, and lower music gain under speech. Use the schema 2 `processing` list for adjustable denoising, silence editing or vocal enhancement; load [audio-processing.md](audio-processing.md) for those operations. The legacy per-segment boolean `denoise` remains readable. Apply cleanup only when requested; avoid combining both denoise controls unintentionally. For words such as 'remove the sentence about pricing', locate the time range from a transcript before editing.

Run `render` for the requested export format. It normalizes clip format, applies edits, concatenates sequentially, mixes supplied music, applies the selected export settings, probes duration and performs a full decode check. A failed render removes only its temporary candidate. Previous exports, source files and speech attempts survive.

Caption cues for generated speech use the actual segment start and duration after editing; they are sentence-level estimates, not word alignment. If speech itself was trimmed or silence editing changed timing, do not deliver the original full-text cue as accurate subtitles: transcribe the final audio when subtitles are required. Mixed recordings without authored text also require a final transcription for full subtitles.

Deliver the current audio and requested transcript/subtitles, with the project file for future changes. Keep intermediate clips and receipts available in the project but avoid publishing every scratch file. State when pronunciation, transcript accuracy or mix quality has not been perceptually checked. When the requested result includes video picture changes or final video assembly, return the finished audio assets and timing information for the video-production owner.
