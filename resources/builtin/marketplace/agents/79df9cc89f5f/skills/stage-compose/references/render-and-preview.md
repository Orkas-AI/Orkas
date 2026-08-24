<!-- stage-compose reference. Read this before composition.snapshot,
composition.draft, or composition.export; ordinary planning and HTML
authoring do not need the operation shapes and delivery details here. -->

# Preview and render operations

## How to call the render path

```json
{"op":"composition.draft","composition_dir":"project/composition","output_path":"project/render/draft.mp4","quality":"draft","report_path":"project/render/draft-report.json","findings_path":"project/composition/qa/inspect.json"}
```

Draft runs lint and inspect before rendering, then reports contract/source
alignment, media probe, loudness, audio timing, video-frame QA, render
throughput, and optional visual-regression status, writing a contact sheet and
per-sample evidence frames. Lint blocks render-contract errors — unregistered
timelines, missing clip timing, invalid root timing, imperative media control.
Semantic defects on readable content (small text, overflow, occlusion,
overlap, low contrast, safe-area violations, primary elements outside canvas)
are blockers; decorative out-of-canvas accents and palette/variety findings are
advisory. Video QA samples frame 0 and each scene start/mid, so an empty hook
or blank scene boundary blocks Gate D; a frozen sampled run blocks earlier, at
the visual preview, because a motionless stretch is invisible in a contact
sheet. With `findings_path` the full payload goes to disk — read it only when
the summary points at a specific issue. Stop and repair when
`draft_disposition.blocking_error_count > 0` or any of those QA phases fails.

Raw `composition.render` is not exposed: it would bypass video QA. Give the
frozen draft signature and the user's submission to `gate-control`; only an
export transition it returns may call the QA-gated high export:

```json
{"op":"composition.export","composition_dir":"project/composition","output_path":"project/render/final.mp4","report_path":"project/render/final-report.json"}
```

Export is allowed only while the inputs still match the successful draft and
the native approval is current. It reruns render, media and frame QA at the
delivery quality (high by default), writes the frame-0 cover beside the video
as `<video-name>-cover.png`, and returns `next_action:"deliver_final"`; the
final response must include the video and mention the cover, or a clear
blocker. When the user explicitly accepts a faster lower-quality delivery,
pass `quality:"standard"` or `quality:"draft"` on the export call — a
draft-quality export reuses the approved draft's cached render and finishes in
seconds, while high re-captures every frame at 30fps and can take tens of
minutes on a long video. Never downgrade quality on your own; the result's
`render_settings.quality` records what was delivered. Call it once and let the host
pick the highest safe fps; a `render_profile.degraded_fps` fallback is internal execution with `confirmation_required:false`, and continues straight to delivery. Never modify `composition-manifest.json`, call `composition.reconcile`/`composition.draft`/`composition.snapshot`, or reopen Preview/Gate D because the host lowered fps or another non-content encoder setting. Set
`strict_render_settings:true` only when the user required exact technical
settings; if that leaves no safe fallback, report the constraint as a blocker
rather than inventing another approval gate.

## HTML Preview Gate

A cost-control gate, not a creative milestone, and only for COMPOSE: it exists
so visual rework happens before an expensive mp4 rerender. **Preview first (hard gate)** when duration >= 20s or scene count >= 3 — the host enforces it, and `composition.draft` rejects a missing, stale, failed, or not-yet-approved preview. Runbook step 6 owns the judgement calls below that threshold.

```json
{"op":"composition.inspect","composition_dir":"project/composition","findings_path":"project/composition/qa/inspect-preview.json"}
{"op":"composition.snapshot","composition_dir":"project/composition","output_path":"project/composition/preview/first-frame.png"}
```

`output_path` stays the first-frame PNG for compatibility; the result also
carries the contact sheet and semantic evidence for every scene. Run the
economical frame pass from the stage-compose runbook, repair all blockers
together, and rerun inspect + snapshot — a changed snapshot requires
re-checking its full new frame set. When the frames read well, hand
`gate-control` the published contact sheet, the `index.html` path, and a
compact readiness note: why preview applied (duration / scene count /
complexity / prior failure), the inspect headline, and what approval means
(render the mp4 draft next). Then obey the transition it returns. Keep preview
revisions lightweight; do not synthesize new narration or render mp4 while the
preview artifact is still under review.

Use `update_visual_baseline:true` only when the user or an explicit project
workflow promotes an approved preview to a golden baseline; later snapshots
compare matching frames and report changes as advisories, never as an automatic
rerender loop.

The preview does not replace the mp4 draft — it cannot validate audio muxing,
final encoded quality, sampled-frame video QA, or exact narration pacing. After
approval, always run `composition.draft` and open Gate D with the video.
