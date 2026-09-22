# Local transcription, editing and delivery

For transcription, copy the recording into the project and call `transcribe` with `input_path` and an explicit language when known. It runs the bundled Whisper model and returns TXT, SRT and JSON with segment timestamps. Retain the raw recognized wording; requested corrections should be a separate edited transcript. No automatic speaker identification or exact forced alignment is promised. An empty transcript is an observed result, not proof that the source contains no speech.

For cuts and mixes, model the requested sequence as project segments. Probe before choosing trim windows. Reorder/reuse sources by reference, use gaps for silence, fades at joins, and lower music gain under speech. Basic `denoise` is optional; do not apply it to every recording or claim professional restoration. For words such as 'remove the sentence about pricing', locate the time range from a transcript before editing.

Run `render` for MP3 or WAV. It normalizes clip format, applies edits, concatenates sequentially, mixes supplied music, applies loudness normalization, probes duration and performs a full decode check. A failed render removes only its temporary candidate. Previous exports, source files and speech attempts survive.

Caption cues for generated speech use the actual segment start and duration after editing; they are sentence-level estimates, not word alignment. If speech itself was trimmed, do not deliver the original full-text cue as accurate subtitles: transcribe the final audio when subtitles are required. Mixed recordings without authored text also require a final transcription for full subtitles.

Deliver the current audio and requested transcript/subtitles, with the project file for future changes. Keep intermediate clips and receipts available in the project but avoid publishing every scratch file. State when pronunciation, transcript accuracy or mix quality has not been perceptually checked. When the requested result includes video picture changes or final video assembly, return the finished audio assets and timing information for the video-production owner.
