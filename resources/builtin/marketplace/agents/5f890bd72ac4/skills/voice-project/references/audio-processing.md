# Audio cleanup and vocal enhancement

Interpret the user's desired result, exclusions and follow-up changes in context. Persist the selected operations as typed project data; natural-language examples are illustrative, not routing rules.

Probe the supplied audio first. Keep original segments as source references; change `schema_version` to `2` and add an ordered `processing` array to `voice-project.json`. `render` executes it locally after segment edits/concatenation and before supplied music and loudness normalization. An empty or omitted array performs no cleanup. A request to preserve pauses must not acquire a silence step implicitly.

| Step | Parameters | Result |
| --- | --- | --- |
| `{"type":"denoise","strength":"light"}` | `strength`: `light` (default), `standard`, `strong` | Reduces steady noise with FFmpeg; stronger settings may affect timbre. Does not remove music or isolate speakers. |
| `{"type":"highpass","frequency_hz":80}` | Cutoff `frequency_hz`: default `80`, range `20`–`300` | Two-pole low-frequency rolloff for rumble; a higher cutoff can thin a voice. This is not general noise reduction. |
| `{"type":"deesser","strength":"light"}` | `strength`: `light` (default), `standard`, `strong` | Reduces prominent sibilance with adaptive high-frequency attenuation, capped at 6/12/18 dB respectively. Stronger processing can dull articulation. |
| `{"type":"compressor","threshold_db":-18,"ratio":3,"attack_ms":10,"release_ms":100}` | Defaults shown; `threshold_db`: `-60`–`0`, `ratio`: `1`–`20`, `attack_ms`: `0.01`–`2000`, `release_ms`: `0.01`–`9000` | Reduces levels above threshold to narrow the difference between loud and quiet passages. Final export loudness normalization still applies. No added makeup gain in the processing stage. |
| `{"type":"silence","mode":"edges"}` | Removes only leading/trailing intervals below threshold | Internal pauses remain unchanged. |
| `{"type":"silence","mode":"compress"}` | Shortens only internal detected pauses | Keeps edges and pauses shorter than the detection duration. |
| `{"type":"silence","mode":"remove"}` | Removes detected silence, including edges | Keeps configured boundary padding; can sound abrupt. |

Silence parameters are explicit numbers: `threshold_db` default `-45` (range `-80` to `-15`); `min_silence_sec` default `0.8` (range `0.05` to `60`); `padding_sec` default `0.05` (range `0` to `1`, used at edges); `keep_sec` default `0.3` for compression and `0` for removal (range `0` to `10`, less than `min_silence_sec` for internal edits). Internal retained silence is split equally around the cut. Use a lower threshold for quiet speech; signal level alone does not identify speech. The script rejects an all-silent result rather than publishing an empty export.

Choose only requested operations and preserve their requested order. When unspecified, a conservative noise reduction can precede silence detection if both are requested. Do not promise recognition-aware removal of filler words or specific speakers. For a content-based cut, transcribe and locate the requested interval first.

For requested basic vocal enhancement, select the relevant steps individually; do not enable all three implicitly for a specific single-purpose request. A combined treatment can use highpass, then deesser, then compressor. These local FFmpeg steps preserve duration and pauses, require no extra model or cloud upload, and add no service credit charge. They do not repair clipping, reconstruct missing speech or provide speaker isolation. Avoid claiming perceptual improvement without listening evidence.

Each step stores input/output SHA-256, normalized settings, engine identity, duration and a time map in the export receipt. A map relates that step's input to its output; multiple maps form an ordered chain. Content/configuration changes invalidate affected derived caches. To revise or undo cleanup, change/remove the processing step and render from the saved original segments; never use the already-shortened export as the new source. Rendering creates a fresh export and preserves earlier ones. Verified unchanged step outputs are reused.

When processing changes timing, the script omits estimated generated-speech subtitles. If the user requested subtitles, transcribe the final export to produce timings for the delivered audio. A receipt proves decode/timing checks; perceptual quality still requires listening evidence.
