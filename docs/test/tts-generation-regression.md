# Text-to-speech and VoiceStudio regression

Use synthetic or explicitly authorized audio and isolated output directories.
Deterministic contracts prove routing, files and recovery; pronunciation,
reference-voice similarity and perceptual quality require a separately authorized
real-provider evaluation. Do not record credentials or private audio in evidence.

## Provider and model boundaries

- Configure a user-owned supported API key. Missing, expired, malformed and
  denied credentials fail clearly; recovery succeeds after explicit correction.
- Search/image/video/voice provider selection follows this build's public API-key
  policy. Model selection remains provider-owned where the settings expose only
  provider/key. No hosted account, quota, private credential sentinel or automatic
  managed fallback is introduced.
- Verify request shape, voice capabilities, input limits, format and error
  classification with controlled transport. Unknown voices, malformed references
  and rejected output do not become success. Cancellation makes no retry.

## Owning automated coverage

Run the focused deterministic selection from the repository root:

```bash
node scripts/run-tests.mjs run test/main/features/tts_provider_lifecycle.test.ts test/main/features/tts_response_lifecycle.test.ts test/main/features/tts_elevenlabs_lifecycle.test.ts test/main/features/tts_capabilities.test.ts test/main/features/tts_capabilities_transport.test.ts test/main/features/tts_doubao.test.ts test/main/features/tts_doubao_lifecycle.test.ts test/main/features/tts_fit.test.ts test/main/model/core-agent/generate-speech-tool.test.ts test/renderer/settings-tts-errors.test.ts
node scripts/run-tests.mjs run test/main/features/voice_studio_core.test.ts test/main/features/voice_studio_e2e_project.test.ts
```

Provider lifecycle cases protect OpenAI-compatible request parameters, real file
writes, HTTP-200 JSON error envelopes, unwritable storage and unknown charge
status. A write failure must return `E_TTS_WRITE` with `requires_user_action`;
correct storage before any explicit retry. Capability selection rejects an
unsupported route/voice/language before synthesis. Capability lookup uses the
saved API-key profile and configured voice without a managed-session catalogue
request; profile storage failures remain redacted. Synthesis keeps its 120-second
deadline and parent cancellation active after response headers until body receipt
finishes. Receipt is bounded before buffering at 50 MiB for binary audio and
100 MiB for Doubao NDJSON, including chunked responses without Content-Length.
Fragmented bytes stay ordered; disconnect, overflow, cancellation and deadline
leave prior output intact without replaying a possibly charged request. The same
checks cover custom, ElevenLabs, Doubao and public Orkas API-key speech; the latter
retains its Bearer key and opaque usage headers. Real temporary HTTP cases check
body cancellation without a live service. Doubao coverage also
checks resource families, streamed NDJSON audio assembly and PCM-to-WAV output.
The duration estimator covers Chinese, English and mixed-language narration.

The speech tool suite protects output paths, VideoStudio plan binding, text
length preflight and same-turn replay rejection: changing text or voice cannot
bypass the duplicate output-path guard. Settings tests require localized save
failures without IPC details, paths or secrets. With controlled model responses,
`test/e2e/tts_generation_e2e_lifecycle.spec.ts` exercises real Electron chat,
tool dispatch, a local provider, the saved audio and its tool receipt, with
exactly one provider request. `test/e2e/professional_agents_e2e_smoke.spec.ts`
checks selection, prompt/installed Skill execution and a timed WAV export.
These controlled responses do not measure model quality or live service health.

Direct Doubao V3 synthesis require a parsed `code: 20000000`
completion event plus audio and no error event. Clean HTTP EOF without that
event is an incomplete synthesis, including on previously tolerated gateways.
`tts_doubao.test.ts` covers missing, truncated and look-alike completion frames,
numeric/string codes, SSE/CRLF and final-line delimiters, and errors before or
after completion. `tts_doubao_lifecycle.test.ts` and the real local HTTP case in
`tts_response_lifecycle.test.ts` verify that incomplete responses do not create
or overwrite audio, do not trigger duration probing or a second synthesis,
and retain sent/unknown-charge/unknown-retry metadata. Existing cancellation,
deadline and fragmented-completion cases remain required.

## Text, voice and file journeys

| User scenario | Independent outcome |
| --- | --- |
| Plain, long and multilingual narration | The requested text is covered once, in order; chunks do not lose or duplicate words. The returned audio is nonempty, decodable and has plausible duration. |
| Required subtitle/transcript sidecars | Text matches the requested source, cues are ordered and within audio duration, encoding survives reload, and unrelated branding or internal control text is absent. |
| Reference voice | Only explicitly supplied reference bytes are sent; invalid format, empty data, unavailable voice or provider rejection leaves an actionable failure. |
| Existing audio inspection | Duration, format and channel information come from the actual file. Silence, missing files and malformed bytes do not produce invented measurements. |
| Edit, extract, mix and transcribe | The requested operation runs through the owning audio capability; text-only requests do not accidentally create speech, and transcription does not silently invoke synthesis. |
| Multiple audio/text outputs | Each producer-declared file resolves to the delivered artifact; derived text and timing sidecars remain associated with their own audio. Repeated display does not duplicate publication. |
| Project and ordinary conversations | Equivalent source inputs produce equivalent valid artifacts in their authorized scope. Project data never leaks into the global scope or a different local user. |
| Interrupted or partial generation | A clear failure preserves accepted prior outputs and the user request. A later explicit retry remains usable; no duplicate charge/request or false final artifact appears. |
| Explicit single-operation request | Run only the requested operation. Preserve parameters and input ownership rather than adding an unsolicited multi-step workflow. |
| Paths and output visibility | Relative and absolute authorized source paths, non-ASCII names, spaces and project paths work; traversal, missing files and managed/private paths fail safely. |

## Validation layers

Run the owning audio, voice API, output-publication and VoiceStudio unit suites
through `npm run test:js`. Use real temporary artifacts and decode/inspect their
bytes, not only mocked success flags. Compare transcript coverage, cue boundaries,
file identity and retained output after failure.

A real provider canary additionally needs authorized test credentials and a
bounded input. Evaluate content/voice quality independently from API completion.
For each supported desktop platform, check native format/tool availability,
artifact preview, cancellation and restart. A pass on macOS does not establish
Windows or Linux behavior. Missing hardware/service evidence stays explicit.

Inspect all warnings, errors, retries and fallback. Logs retain only stable codes
and masked identifiers; keys, full local paths, source text and audio bytes must
remain absent. Ordinary audio/text artifact integrity remains covered.

## VoiceStudio project, revision and recovery

VoiceStudio reuses the configured user-owned TTS routes and bundled FFmpeg,
FFprobe and Whisper/model. Its installed project Skill owns segment production
and recovery; picture-based work remains with VideoStudio. Credentials must
never enter project files. The packaged-script process test checks durable
state across independent processes, a recovered WAV and a timed export.

| Journey | Required result and negative control |
| --- | --- |
| Discover voices before generating | Capability paging and route/language filtering return stable references without synthesis, writes or native provider identifiers; legacy generation rejects missing fields. |
| First two-paragraph narration | Resolve capabilities, make exactly two expected controlled synthesis requests, persist ready recording hashes and deliver the ordered WAV with matching complete-script subtitles. Missing state, extra/repeated requests or a completion message alone fail. |
| Revise only the second paragraph | Make exactly one new request; preserve the first recording and prior export byte-for-byte; update audio and subtitle wording. A mix-only change makes no synthesis request. |
| Cached speed revision | Slow only the second saved recording; retain original recordings and the prior export. Any new synthesis fails the scenario. Independently verify new audio duration and segment order. |
| Interrupted generation | Preserve uncertain attempts, recover the saved valid recording and verify both ready hashes before export. Empty/corrupt/missing recordings stay uncertain; duplicate attempts and changed bytes fail. |
| Missing meeting source | Inspect the missing source and request it clearly; preserve existing inputs and produce no invented transcript or export. |
| Trim, pause, speed, denoise, supplied music | Decode real WAV/MP3 output; compare independently calculated timing and frequency windows for order/music gain. Correct duration with silence or wrong content fails. Invalid trims preserve originals and leave no partial export. |
| Voice, role, language or speed changes | Invalidate the relevant old receipt; repeated text in the same role may reuse a recording, while distinct roles keep distinct requests. |
| Caption completeness | Complete untrimmed authored scripts produce sentence subtitles with correct speed-adjusted timing. Trimmed/imported media requires transcription; suppress misleading script captions. |
| Stop and restart | Busy project, missing runtime, active cancellation and true/symlink escapes preserve sources and completed state. Cancel removes only the unfinished candidate; a later render succeeds without a runtime download. |
| Project count limits | Inspect a saved 200-segment chapter; reject 201 before mutation; render a 32-segment sequence within its bound. This does not establish four-hour workload performance. |
| Request validation | Missing or invalid project fields fail as `E_INPUT` before filesystem work. Preserve state and accept a later corrected request without automatically rewriting or replaying commands. |
| Equivalent paths | A directory alias inside the project resolves to canonical media, persists a reusable relative receipt, and survives reload/duplicate-attempt checks. A true escape or alias to the project directory itself fails without corrupting the uncertain attempt. |
| Installed Skill invocation | Read the bound Skill's platform-specific runner command and exact reference, including same-ID collisions and quoting on macOS/Linux/Windows. No-script references omit it. Write JSON requests first, invoke one operation with a quoted absolute request path, and separate preparation from invocation. |

## Transcription and artifact integrity

Use a separate reference transcript; never provide it to recognition. Check
TXT/SRT/JSON wording, Unicode normalization and source digest independently,
with monotonic finite timestamps inside the actual media duration. Empty,
fabricated or mismatched text and invalid offsets fail even when the file is
readable. Test silence and deterministic millisecond fixtures separately from
actual speech recognition. Recorded speech, a 44.1 kHz stereo mild-noise variant
and the VideoStudio path need distinct observations. An actual model run must
be explicitly enabled and recorded; ordinary tests do not download samples or
models. On macOS x64, verify the bundled CPU recognition path; a plausible
filename or extension cannot prove accurate content.

Retain the output-integrity portfolio across publication and reload: arbitrary
filenames, non-ASCII text, BOM/CRLF, legitimately spoken brand names, repeated
display, renamed/copied/edited files, atomic replacement, symbolic links,
retargeted links, reused paths, separate local users and neighboring ordinary
documents. Audio text must match its supplied/generated source exactly; no
unrelated header or control text is acceptable. Protect source/target bytes and
out-of-root files. If a producer declares supporting metadata, inspect its
schema, digest and bounded size, reject malformed/stale data, and ensure it does
not become a default user deliverable. File type must not be guessed from an
Agent name, filename, directory or incidental words. These public artifact and
filesystem outcomes are independent of hosted publication policy.

## Doubao V3 and quality canaries

Direct Doubao capability discovery exposes the configured voice, rather than
the vendor's entire catalogue. V3 synthesis sends
`req_params.audio_params.speech_rate = round((speed - 1) * 100)` for speed
0.5–2.0; omission preserves the provider default. Controlled cases cover selected
speaker, PCM-to-WAV, normal/edge speeds, invalid speed before dispatch, partial
stream rejection, redaction and no repeated request. Local Whisper supplies
transcription and FFmpeg supplies editing/mixing/export; this scope requires no
additional cloud ASR, voice cloning, music-generation API or runtime download.

A separately authorized provider/voice comparison uses the same provider,
voice, format, machine and inputs for baseline/candidate, with at least three
repetitions. Cover Chinese, English, mixed language, numbers and proper names.
Check minimum valid audio size, decode, content coverage/CER/WER, natural speech
duration, clipping, head/tail silence and exactly one request per scenario.
Retain per-case variation rather than hiding it in a combined average. Compare
regressions against declared limits (including a 0.02 CER/WER increase or 0.75 s
mean duration shift) without changing the oracle after observing results.

Include longer distinct paragraphs, real recorded speech and controlled noise;
transcription must preserve beginning/end content and all sidecar timing.
Measure native resource use for long workloads separately. If using NFKC,
case folding or Traditional/Simplified conversion for diagnostic CER, retain
original text/score and label each transform; do not rewrite numeral spelling.
Empty and unrelated transcript controls must fail. TTS-to-ASR disagreement does
not identify the responsible model and cannot establish human listening quality.
An observed timestamp beyond source duration remains a defect rather than a
success or permission to drop content. Report native Windows and Linux results
separately from macOS, alongside live service, listening and long-audio gaps.
