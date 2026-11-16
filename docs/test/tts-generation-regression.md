# Text-to-speech and VoiceStudio regression

Use synthetic or explicitly authorized audio and isolated output directories.
Deterministic contracts prove routing, files and recovery; pronunciation,
reference-voice similarity and perceptual quality require a separately authorized
real-provider evaluation. Do not record credentials or private audio in evidence.

## Provider and model boundaries

- Configure a user-owned supported API key. Missing, expired, malformed and
  denied credentials fail clearly; recovery succeeds after explicit correction.
- Search/image/video/voice provider selection follows this build's public API-key
  policy. Native speech presets expose their supported model choices; historical
  saved speech configurations retain their selected model and endpoint. No hosted account, quota, private credential sentinel or automatic
  managed fallback is introduced.
- Verify request shape, voice capabilities, input limits, format and error
  classification with controlled transport. Unknown voices, malformed references
  and rejected output do not become success. Cancellation makes no retry.

### Native BYOK TTS scope (2026-11-06)

Settings > Models > Speech supports six BYOK providers: Doubao Seed TTS
2.0; MiniMax Speech 2.8 HD/Turbo; Alibaba Qwen-Audio 3.1 TTS Plus/Flash and
CosyVoice 3.5 Flash/Plus; Google Gemini 3.8 Flash/Flash-Lite TTS; ElevenLabs
Eleven v4/v4 Turbo; OpenAI GPT-4o mini TTS. Historical configurations retain
their model and endpoint. ASR, music and sound effects are outside this speech configuration change.

- Native protocols: [MiniMax HTTP/hex](https://platform.minimax.cn/docs/api-reference/speech-t2a-http),
  [Qwen HTTP](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api),
  [CosyVoice task WebSocket](https://help.aliyun.com/zh/model-studio/cosyvoice-client-events),
  [Gemini Interactions](https://aistudio.google.com/docs/speech-generation),
  [ElevenLabs speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
  and [dialogue WebSocket](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tdd),
  [OpenAI Speech](https://developers.openai.com/api/docs/guides/text-to-speech).
- Domestic providers use domestic endpoints; Alibaba requires a Beijing
  Workspace ID and matching key. CosyVoice 3.5 is clone-only: enter an enrolled
  voice ID, not a public voice from another model. ElevenLabs requires a voice
  available to the user's account. Saving is local configuration, not proof of
  funded model/voice access, and never initiates billable synthesis.
- Gemini preserves the literal transcript and adds no style instruction. Its
  unary WAV is validated; MP3/Opus conversion uses the existing local FFmpeg
  runtime. A missing converter or unsupported explicit speed is rejected
  before dispatch. Eleven v4 likewise rejects unsupported non-neutral speed.
- WebSockets honor the shared proxy resolver, support HTTP(S) CONNECT and fail
  closed on unsupported proxy routes. Frames, aggregate audio, task duration
  and local conversion are bounded. A close without the provider's completion
  event never saves partial audio or reconnects automatically.
- Only the documented Alibaba result host is downloaded, over HTTPS with no
  provider key and no redirects. Receipt/download/conversion errors preserve
  possible-charge status; no implicit provider fallback or paid retry occurs.
- [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)
  schedules legacy Speech models for shutdown on 2027-01-06. This implementation
  uses the still-available Speech API; Realtime replacement models need a
  separate verbatim-TTS migration before that deadline.
- `tts_native_providers_lifecycle.test.ts`, `tts_native_websocket_e2e.test.ts`,
  `tts_elevenlabs_lifecycle.test.ts` and `util/tts-audio.test.ts` cover native
  payloads/auth, completion/error states, byte delivery, no replay, proxy and
  local encoding. `ipc/model-config-auth.test.ts` covers encrypted persistence,
  reopen, local-user isolation, ordering and removal. `tts_providers_e2e_settings.spec.ts`
  exercises the actual Electron configuration UI, relaunch, shared dropdown
  dismissal, English/Chinese and narrow-window layout. These fixtures do not
  establish real provider permission, charge, speech quality or intelligibility.
- The public Orkas API-key route remains available, retaining its Bearer key,
  stable model and opaque usage headers. No official account session is used.
- Web application support remains **deferred** under the existing media-generation
  family: BYOK secrets and paid generation stay in the desktop host; no new SDK
  grant or bridge is added. Configurations share existing encrypted local auth
  storage, and generated audio retains its caller's existing artifact ownership;
  this adds no independent billed cloud-storage module.

### API parameter contract follow-up (2026-11-06)

`tts_api_parameters.test.ts` adds an independent request/response matrix from
the official endpoint specifications above. These are deterministic protocol
fixtures, not proof of a provider account's permission or speech quality.

| Provider / family | Protected request and delivery contract |
| --- | --- |
| Doubao HTTP | POST, API key/resource/request UUID headers, MP3/WAV/PCM/Opus/Ogg mapping, 48 kHz for `ogg_opus`, 24 kHz for PCM/WAV/MP3, cloned-voice resource/model, unsupported-format preflight refusal |
| MiniMax Speech 2.8 HD / Turbo | Domestic POST, Bearer key, unchanged transcript/model/voice, native hex output, MP3/WAV/PCM/FLAC/Opus and valid sampling settings |
| Qwen-Audio 3.1 Plus / Flash | Beijing workspace POST, Bearer key, `input.rate`, four native formats, HTTPS result download without the API key |
| CosyVoice 3.5 Flash / Plus | Real local WebSocket task lifecycle, model/voice/rate/sampling/format, complete text at the limit, no connection above limits |
| Gemini 3.8 Flash / Flash-Lite TTS | Interactions POST/API key, literal transcript, speech config, unary WAV, real local conversion to MP3/Opus and exact PCM delivery |
| Eleven v4 / v4 Turbo | Native HTTP or real local dialogue WebSocket, `xi-api-key`, codec query, voice registration, local PCM-to-WAV wrapping and rejection of unsupported speed |
| OpenAI GPT-4o mini TTS | Speech POST/Bearer key, six output formats, omitted optional speed and accepted/rejected speed/text boundaries |

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
Only a structured rejected rate-limit response may wait and retry inside the
original operation deadline; accepted or uncertain work is never replayed. At most
two speech transports run concurrently, including cancellation settlement.
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

## Multilingual narration estimates

The shared estimator covers Latin scripts including Vietnamese, Japanese,
Korean, Thai, Cyrillic and Arabic. NFC-equivalent narration has the same estimate;
numeric separators and sentence pauses stay distinct. Chinese and English retain
their established rates. `tts_fit.test.ts` carries thirteen measured duration
fixtures with an independent twenty-percent tolerance and fit acceptance, while
`storyboard_timing.test.ts` checks bundled helper parity. These fixed samples do
not establish pronunciation quality or current provider availability. Capabilities
resolve through the configured public provider; no official-account voice catalog
or hosted billing contract is introduced by the estimator update.

## Source-bound recognition and invalid timing

Hold recognition after its decoded WAV is prepared, then overwrite, atomically
replace or delete the original recording. Segment/word recognition must still
use the initially prepared audio and original hash, publishing that version's
TXT/SRT/JSON without replay. Equal-length tones distinguish which audio was
recognized. An unstable source during decoding fails before recognition; old
word timing cannot edit replacement bytes. Prior sources and outputs survive.

Bound cues by actual decoded audio, including a video whose picture lasts longer.
Overflow, reversed/overlapping/zero/negative/missing intervals fail with retained
recognized TXT only, no editable JSON/SRT and no extra ASR call. Preserve the
existing one-millisecond timing allowance and verify an explicit healthy retry.
VideoStudio's point-word repair is independently maintained: do not infer that
VoiceStudio fabricates identical word intervals.

## Local delivery, extraction and conversion

Pure extraction/conversion ignores saved trim, speed, volume, cleanup, music,
word edits and render normalization. Extraction defaults to compatible stream
copy; multiple audio streams require the explicit index returned by probe. Cover
MP3, WAV, FLAC, M4A/AAC, OGG/Vorbis and Opus; typed rate/channel/precision/bitrate
settings and incompatible-copy refusal followed by explicit conversion. Reopen
saved export settings and test one-off overrides without changing that profile.
Default render remains 48 kHz stereo, WAV16/MP3 192k with its existing loudness
setting. Independent decoded PCM detects an accidental level or channel change.

Use real temporary WAV/MP4/MKV with distinct tracks and known samples. Reject
missing audio, corruption, unsupported settings, changed source, network/playlist
protocols and cancellation without replacing previous work. Transfers retain the
30-minute total deadline, 8 GiB/four-hour input and 2 GiB output bounds. Inject
encode/decode, disk-full, stalled dependency and source-change faults; publish
only complete candidates under the project lock, remove candidates on failure,
and prove recovery works without damaging the project or earlier exports.

## Cleanup, enhancement and recorded speech

| User goal | Independent result and counterexample |
| --- | --- |
| Trim only edges / compress only long pauses | Retain quiet first/last speech, short breaths and all unrequested gaps; verify time maps and duration. Explicit no-treatment preserves the original. |
| Denoise | Measure noise reduction alongside retained speech; unchanged/renormalized, silent and unrelated outputs fail. |
| Filter rumble only | Reduce known 40 Hz relative to 440 Hz while retaining high detail, level contrast, timing and pauses. |
| Reduce sibilance only | Reduce a loud 8 kHz burst relative to voice, preserving quiet detail, low-frequency content and unrelated dynamics. |
| Level dynamics only | Reduce loud/quiet contrast without deleting pauses, muting voice or changing unrelated spectral bands. |
| Combine, revise, reuse and undo | Persist ordered settings; reuse only a verified unchanged prefix. Source/settings changes invalidate dependent caches. Undo starts from originals and preserves the earlier export. |
| Reject invalid work | Unknown fields, filter-string injection, invalid types/ranges and more than 16 processing steps fail before mutation. Missing codecs/cancel preserve sources; editing does not require Whisper. |

Use both synthetic signals and checked-in English JFK/Mandarin fixtures with
license/hash attribution in `test/fixtures/voice/README.md`; never download
recordings/models automatically. Inject controlled noise, rumble, gain changes,
pauses and sibilance. Keep a clean reference outside the execution workspace.
Cover float 44.1 kHz WAV, 16 kHz MP3, 48 kHz FLAC, 44.1 kHz AAC/M4A and 48 kHz
Ogg/Opus, distinct stereo content, and 1/21/200 ms clips. Preserve source hashes,
quiet phrases and short breaths; cancel an active candidate, remove temporary
files/locks, restore the source and recover successfully.

Use bounded waveform-derived delay for FFT denoising (at most 50 ms), a separate
voice-band comparison and symmetric phrase contrast. Wrong audio, excessive
shift, silence and unrequested treatment must still fail. Undo compares against
the actual noisy input, not a clean reference. These fixed recordings and
spectral checks do not certify human listening quality or arbitrary defects.
All-silent preservation is valid when no silence-removal operation was requested;
a silence-removal request that cannot produce usable speech must not invent audio.

## Local timeline, word edits and mono levels

Schema 3 adds supplied timed `tracks` and source-segment `word_edit`; older
schema-1/2 defaults remain compatible. Cleanup precedes overlays and defines
track placement's clock. Only main narration keys music ducking; sound effects
and other music do not. Use explicit overlap/fade settings for supplied BGM,
without another generation or beat-analysis request. Floating intermediates keep
mix peaks until final normalization/encoding; composition caps 32 tracks and
bounds aggregate media, decoded work and intermediate PCM.

Word mode uses experimental word/subword units, not forced alignment or automatic
filler detection. Keep zero-duration text with an adjacent timed unit rather
than inventing an interval. Inclusive keep/remove indices bind to both transcript
and current source hash before local cleanup/speed. Reject stale hashes, invalid,
reordered/overlapping/untimed indices and remove-all selections without losing
prior output. Timing changes require a fresh final-audio transcript for captions.

Measure real output frequency/time windows, continuous narration, loop seam jumps
and tail envelopes; wrong placement, hard loops, missing requested fades and
correct-duration holes fail. Pure conversion ignores composition and ASR state.
Schema-3 rendering and word transcription share a 30-minute overall deadline.

For mono export, every assembly/word-cut/processing/track path uses the requested
channel count. Compare original retained PCM, stereo channel frequencies, an
independently normalized mono downmix, five cleanup types/cache/undo, one-off
channel overrides, legacy/timeline music and speech-only ducking. Normalized
peaks and third-harmonic distortion check clipping; they do not certify true
intersample peak. Old derived processing caches rebuild under version 2 while
originals/finished exports remain unchanged; matching new work reuses the cache.

## Saved project replay and delivered-file identity

A correct WAV does not prove the saved project can reproduce it. Copy only scoped
referenced media/word timing into a new physical directory, omit caches/exports,
run the shipped audio script in a fresh process and compare the complete decoded
interleaved PCM against the selected delivery. Use one-off lossless WAV only;
retain edits/gains/channels/rate/loudness and allow at most one 16-bit quantization
step. Test suffixed project revisions, relocation, scoped aliases, format-only
export, one altered sample, swapped channels with equal mono sum, missing/corrupt
media, outside references and unavailable takes. Run against an isolated copy,
never repairing the original workspace to make the comparison pass.

The short-fixture verifier budgets eight candidate projects, 64 segments,
32 tracks, 128 references, 32 MiB copied media, 30 seconds of media/output,
120 seconds decode-work and a shared 15-second subprocess deadline. Unavailable
or over-budget evidence fails closed; these are verifier limits, not product
limits. This is not universal replay of arbitrary/long/lossy projects.

When publication evidence exists, verify the actual produced attachment rather
than any retained intermediate or prose claim. Correct unpublished audio cannot
hide a wrong published file. TXT/SRT without JSON is valid preserved-input/content
evidence; never invent a source digest. A supplied JSON digest must match.

## Local owning selections and boundaries

Use `npm test --` with the actual files under `test/main/features/`:
`voice_studio_core.test.ts`, `voice_studio_processing.test.ts`,
`voice_studio_enhancement.test.ts`, `voice_studio_recorded.test.ts`,
`voice_studio_e2e_project.test.ts`, `voice_studio_e2e_narration.test.ts`,
`voice_studio_e2e_delivery.test.ts`, `voice_studio_transfer_deadline.test.ts`,
`voice_studio_e2e_composition.test.ts`, `voice_studio_e2e_channels.test.ts` and
`voice_studio_guidance.test.ts`. `test/eval/voice-project-replay.test.ts` owns
independent fresh-process replay. Real recognition is explicit via
`ORKAS_REAL_WHISPER_TEST=1` after native prerequisites are verified.

Installed `voice-project` references own local delivery, ordered processing,
timeline mixing and word editing. Verify their links and execute their example
requests with real codecs; resident Agent descriptions, permissions and tools
are unchanged. Managed separation/music, official credits, private model cohort
history and monorepo retained logs are excluded. Local effects and supplied BGM
remain available. No document update marks model behavior, paid suppliers,
packaging, Windows/Linux native paths or perceptual listening accepted.

### Background music at compressor EOF (2026-11-17)

VoiceStudio legacy/timeline mixes and VideoStudio edit/render mixes align
complete 1024-sample audio frames before split sources and compressors drain.
This prevents some FFmpeg builds from dropping late background music. Final
voice/timeline/known clip trimming or the existing video-master shortest stream
removes bounded final-frame padding. Source files and earlier exports survive.

The delivery cases exercise both VoiceStudio mixers;
`test/main/features/video_ducking_e2e_frames.test.ts` verifies the packaged edit
core and native render/remux graph with actual codecs and a whole-file frequency
oracle. Retain leading music, attenuation during speech and music after release.
These are local deterministic codec checks; no provider or model call is needed.
