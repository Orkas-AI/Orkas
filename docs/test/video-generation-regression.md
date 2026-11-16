# Public video generation regression

Use isolated outputs and synthetic provider responses. Public API-key and native
provider paths must remain independent of official accounts and managed credits.

| Journey | Independent outcome and recovery |
| --- | --- |
| Provider configuration and references | Saved public profiles reopen and dispatch to the selected adapter; malformed references fail before task creation. Local URLs stay scoped to the active owner. |
| Accepted task, cancellation or lost tracking | Retain the task receipt and post-dispatch state; no automatic generation replay or fallback after acceptance. |
| Completed task download | Download and validate actual MP4 bytes; retry only bounded GETs. HTML/XML success bodies fail. Exhausted download or cancellation retains the task id and cannot create another paid task. |
| Output write failure | Preserve existing files, return IO_ERROR, and never create a replacement task. |
| Doubao input rejection | Read only a bounded structured error.code. Recognized input codes yield BAD_INPUT; unknown or malformed codes remain provider errors. Never return provider prose that can echo a prompt. Pre-acceptance failure may use a configured fallback. |
| Doubao terminal task rejection | Return the safe structured code, receipt and post-dispatch failure, with an explicit new-generation consequence; no false success or replay. |
| Tool delivery | Expose the scoped local artifact, never a provider signed download URL. Keep sandbox, cancellation and production plan binding. |

Owning cases: `test/main/features/video_gen.test.ts`,
`test/main/features/generation_reference_assets.test.ts`,
`test/main/model/core-agent/video-gen-tool.test.ts`. Rejection cases include valid
input/output codes, look-alikes, non-JSON bodies, auth errors and private-prose
canaries. Use the existing public Electron generation flow for a controlled
end-to-end receipt. Real provider availability, decoded picture/audio quality
and current charges require separately authorized canaries; synthetic tests do
not establish them. Private hosted billing, evaluation and production logs are
not part of this public regression procedure.

## Provider parameter compatibility (2026-11-13)

VideoStudio has three independent production paths: HTML/code rendering, local
editing of existing media, and paid model-generated shots. Mixed productions use
all three. Provider constraints apply only to generated shots; they never set the
minimum duration, canvas, audio or resolution of a code-rendered final video.

`video_parameter_compatibility.ts` converts desired output controls into native
request controls before configured-service checks and generation. It keeps the
selected model and every reference. Short/fractional durations round up to a native
minimum/step; unsupported resolution tiers use the next supported tier (or the
largest tier); unsupported shapes use a supported shape. Native audio-only models
generate audio and are muted locally. Seedance 2.5 edits use their native automatic
duration/shape; Omni receives no unsupported numeric duration/seed field. Requests
beyond a model's single-shot maximum still need a multi-shot production: the host
does not truncate their action, discard references or generate more paid tasks.

`video_output_compatibility.ts` finishes model footage locally, using bounded,
cancellable FFmpeg work: trim to the requested short duration, fit/pad to the desired
canvas without cropping product details, and remove audio when requested. When a
tail frame is specified, shortening retimes the full clip and its audio instead of
cutting off the ending. Valid native output bypasses conversion and retains its
original bytes. Conversion failure preserves the accepted-task receipt. Do not automatically
resubmit an uncertain or accepted generation; recovery must not buy a replacement. Converted files are not registered
as equivalent to their unconverted remote source. Automatically timed footage is
probed before shortening, so the ending and reported duration use actual media.

Official sources checked for the currently integrated model identities (not every
new model or every feature a vendor advertises):

| Provider | Native controls and important combinations | Primary API source |
| --- | --- | --- |
| Doubao | Seedance 2.5: 4–30s; adaptive keyframes; edit duration/ratio follow the source. Seedance 2.0 Fast/Mini use 480p/720p before dispatch. Reference and keyframe roles are distinct. | [Create task](https://docs.volcengine.com/docs/ark/create-video-generation-task-api), [2.5 guide](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=en) |
| MiniMax | H3/Highspeed/Lite: 4–15s; Max: 5–15s. H3: 768P/2K; other integrated H3 tiers: 480P/768P. V2 keyframes and general references are mutually exclusive. | [Official V2 OpenAPI](https://platform.minimax.io/docs/api-reference/video/generation/api/v2-video-generation.json) |
| Vidu | Q3 Pro/Turbo: 1–16s; 540p/720p/1080p; native audio toggle. Two keyframes use start-end2video, in opening/ending order; image generation takes the input frame's shape. | [Text](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/text-to-video), [keyframes](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/start-end-to-video) |
| Kling | 4.0: 3–30s, 720p/1080p; Flash: 3–20s, 720p, one keyframe. API release notes take precedence over web-editor capabilities such as forthcoming 4K. | [Official API releases](https://kling.ai/document-api/updates/api?date=2026-02-11), [model guide](https://kling.ai/quickstart/kling-4-model-user-guide) |
| Gemini | Integrated Omni 1.1 uses the Interactions API and prompt-controlled duration; numeric duration/seed are omitted. Native sound is removed locally for silent delivery. No automatic model migration is made. | [Pinned model](https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash?hl=en), [Interactions video guide](https://ai.google.dev/gemini-api/docs/omni?authuser=108) |
| Google Cloud | Veo 3.1 uses 4/6/8s steps and model-specific resolution tiers; high-resolution output uses 8s. First/last frames use image/lastFrame, separately from generic references. | [Model specifications](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate), [keyframe API](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/generate-videos-from-first-and-last-frames) |
| Alibaba | Wan 3.0/Prime: 2–30s or -1, 480P/720P/1080P, audio toggle; media roles distinguish reference images/videos from keyframes. Input plus output video length is separately bounded. | [Official API](https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference) |
| Runway | Gen-4.5: integer 2–10s. Text mode has landscape/portrait ratios; image mode permits more shapes. Only an opening frame is integrated here. | [API](https://docs.dev.runwayml.com/api/), [input specification](https://docs.dev.runwayml.com/assets/inputs/) |

Reference-media content, supported operations, credentials and capacity are not
interchangeable scalar settings. Unsupported combinations remain explicit failures
before payment rather than silently dropping content or substituting a model. The
document audit is not a paid supplier canary; deterministic protocol fixtures and
real local media checks are the verification boundary of this change.


## Portable scenario portfolio

- Configure each native provider, save/reopen/restart, select a model from a
  multi-model picker, and repeat in Chinese/English and a narrow window. Escape
  closes the menu. Persist the selected provider/model pair rather than treating
  a flattened option ID as a provider. A host-selected canvas service is the only
  candidate; a removed selection sends no request, and model-supplied selection
  cannot override it. The public `orkas-api` profile remains user configured.
- Compare native request parameters with the admitted production plan: operation,
  duration, shape, resolution, quality, sound and every reference survive. An edit
  without source footage fails. No missing reference is silently discarded.
- Runway text-only calls use `text_to_video` and supported text ratios; image calls
  use `image_to_video` with `promptImage`. Gen-4.5 integer 2–10 second requests
  remain intact; older profiles retain their own compatibility conversion.
- Veo 3.1 standard accepts its supported high-resolution tier; Fast/Lite use the
  highest supported native tier plus local fitting. Credentials are checked
  before dispatch and Lite's image capability is not expanded.
- Cover first-only and first/last frames in every admitted provider family:
  Seedance and MiniMax role fields; Kling opening/ending image order; Vidu
  start-end mode; Wan media roles; Cloud Veo image/lastFrame; first-only adapters.
  Reject tail-only, unsupported models, incompatible reference combinations,
  unsupported edit modes and capacity overflow before upload or creation. Where
  native generation requires frame shape, use its native adaptive mode and fit
  locally. Reference progress counts both opening and ending frames.
- Cache prepared references by local owner and actual file identity. Replacing
  bytes at the same path or changing owner invalidates the old URL. Require
  public HTTPS or strictly scoped `asset://` references. Only reference GETs may
  retry; these retries cannot replay generation POSTs.
- Use valid ISO-BMFF fixture bytes, never a few arbitrary bytes. Reject a 200
  HTML login page, XML expiry response and malformed/empty container without a
  fake output. Download through the proxy-safe binary transport, ignoring object
  metadata headers; bounded retries are GET-only. Cancellation interrupts backoff
  and preserves the completed task's delivery-error receipt.
- Fault local directory creation/write after successful provider generation.
  Return IO_ERROR, preserve existing files and do not try another profile.
  Native explicit output extensions are retained; the public API profile keeps
  its separate MP4 path contract. Abort before progress/download performs no GET.
- Redact provider errors before truncation. Test recognized structured rejection
  codes, unknown/look-alike codes, malformed/non-JSON bodies, auth errors, and
  key/email/path/signed-query canaries. Never return provider prose containing the
  prompt. Tool success returns a scoped local link, not a signed download URL.
- Pending production requests remain durable across restart; status checks or
  replacement attempts never automatically redispatch them. Completed outputs
  remain reusable. Do not promise managed-receipt recovery for user-owned APIs.
- Test actual decoded output duration, canvas, silence, retained ending, original
  bytes, cancellation and independent HTML/local-media composition. A fitting
  request must not silently crop product detail or discard the ending frame.

Owners include `video_gen.test.ts`, `video_gen-byo.test.ts`,
`video-gen-current-public.test.ts`, `video_auth.test.ts`,
`generation_reference_assets.test.ts`, `video_parameter_compatibility.test.ts`,
`video_output_compatibility_e2e.test.ts`, `video_production_budget.test.ts`,
`video_production_spend.test.ts`, `video-gen-tool.test.ts` and
`video-gen-public-journeys.test.ts`. Select their actual public paths under
`test/main/features/` or `test/main/model/core-agent/`, using `npm test --`.
The Electron canvas/settings/delivery journeys verify real host wiring. Fixture
results and this source-pinned compatibility table do not establish live vendor
availability, current prices, account permissions or picture quality.

## Native service routing and canary boundary

New MiniMax, Vidu and Kling credentials retain the source's China API/application
route; historical untagged credentials retain the prior global route. The
persisted internal site marker survives restart; IPC cannot override it. Creation
and polling stay on the same route and an uncertain submission never retries
another site. Google, Runway and Alibaba's existing regional behavior remain.

Before a separately authorized paid canary, record the exact provider/model,
configuration, bounded request budget, time and expected charge. Probe real
outputs with a decoder/player, checking duration, dimensions, audio and the first
and last supplied frames, including a frame whose shape differs from the final
canvas. Exercise interruption and delivery recovery without automatic re-buying.
No default test or documentation update grants paid-call authority. Official
account quotes, credit settlement, server reconciliation, internal benchmark
cohorts and private production logs are intentionally outside this public suite.
