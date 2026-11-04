---
ownerAgent: 79df9cc89f5f
name: stage-compose
description_zh: 编写并渲染 HTML 视频合成（方案、时间线动画、预览、草稿、导出）；动态图形和讲解视频的核心。
description_en: Write and render HTML video compositions (manifest, timeline animation, preview, draft, export); the core of motion graphics and explainers.
---

# stage-compose

Author an Orkas HTML composition and turn it into video. In Orkas, lint,
inspect, snapshot, draft, and export run through built-in `video_studio`.

All COMPOSE stops and authorization transitions belong to `gate-control`. This
Skill supplies the manifest, contact sheet, draft, QA evidence, and readiness;
pass those facts to `gate-control` rather than restating approval policy.

## No-runtime advisory package

When production tools cannot run, follow `gate-control`'s complete unexecuted-
package protocol and read
[no-runtime-package.md](references/no-runtime-package.md). Read it only on that
branch; ordinary runtime work never needs it.

## QA response kernel

Every QA failure or recovery handoff carries the current reviewable artifact
package, not only a reason: returned `current_candidate`, contact sheet or
sampled frames, failed draft when present, and `findings_path`/inline findings.
Label it current but unapproved, state the bounded repair and next cheap check,
and omit fields not returned. If `review_package.presentation_required:true`,
show `primary_artifact`, summarize `conclusion`, and keep other paths as evidence.
With no media, show the returned manifest or authored HTML.

Ask only for a real creative/cost choice, with concrete options derived from the
artifact. Do not expose native error ids, Gate labels, repair budgets,
signatures, or schema jargon. Translate a result into: what needs work, what
remains safe, and the concrete repair/next check. In Chinese, say `生成旁白音频`,
`将旁白音频加入视频`, or `旁白音频生成失败`, never `旁白物化`.

Top-level continuation fields outrank prose errors:

- `next_step_owner:agent` plus `execution.continue_in_current_turn:true` means
  mutate the named file, retry, and continue in this turn.
- `next_step_owner:user` requires the artifact and concrete choices now.
- `next_step_owner:external` stops safely at the preserved artifact without
  claiming automatic recovery.

Fatal inspect blocks snapshot/draft/preview until repaired. A successful inspect
with visual review allowed goes to snapshot before editing, so repairs have frame
evidence. Before showing a passing snapshot, inspect the complete returned frame
set economically, batch visible blockers, repair affected scenes, then rerun
inspect + snapshot. A semantic failure stays visible but unapproved and must not
retry unchanged input. An exhausted visual-QA cycle shows evidence and native
options, then waits; no recovery operation exists.

A narration retime moves all scene windows. When materialization returns
`scaffold_retimed:true`, adjust each shifted scene's tweens from its new window
before inspect/snapshot; do not drop a silent designed beat.

A passing snapshot ends the turn until go-ahead for its visual identity. Show
the complete frame set and stop; do not draft in that turn. Visible changes make
a new identity and require one changed complete preview. Narration/audio-only
work inherits prior preview when scene windows and pixels are unchanged.

For detailed failure classification, repair causes, and bounded retry behavior,
read [qa-and-repair.md](references/qa-and-repair.md) only after inspect,
snapshot, or draft actually reports a failure/recovery branch.

## Post-gate revisions

On every gate submission or post-gate edit, use `gate-control` and its resolver
before production calls. Styling-only HTML/CSS/SVG/layout/motion/palette/assets
is `visual_only`. Signed delivery, approved copy, narration, timing, language,
source mappings, roles, or narration intent is `gate_b_payload`.

After a draft/final `visual_only` edit, recapture and show the changed complete
frame set, wait for go-ahead; `composition.draft` then re-encodes the complete composition as one mp4.
Approved export re-encodes the same whole composition at delivery quality. The
new draft reopens final-video confirmation; do not imply only one scene can be
encoded or skip whole-composition QA.

## Fast COMPOSE runbook

This sequence covers new production and unfinished authoring. On resume, use
`composition.status` to locate the current artifact and remaining work. An
unchanged ready draft with existing media/report is already at final review;
use its `current_draft` evidence with `gate-control`. Changed inputs or missing
files need the corresponding repair, rather than restarting the whole sequence.

1. For a new runtime production, finish
   [video-router's direction confirmation](../video-router/SKILL.md#direction-confirmation)
   before design preparation. On resume, reuse the chosen direction; do not ask again.
2. Read an existing canonical manifest. Apply
   `frontend-design` for visual authoring; apply `design-system-importer` only for a concrete style
   source; apply `composition-design-review` only after snapshot, as an advisory checklist that never replaces native QA or creates a gate.
3. The plan is only
   `project/composition/composition-manifest.json`: duration, language, audio
   ownership, scenes, approved copy, narration, and art direction. No shotlist,
   script, or second structural contract. Before authoring it, read
   [manifest-and-authoring.md](references/manifest-and-authoring.md), which owns
   schema, scaffold, language, art direction, and offline authoring rules.
4. For applicable standalone narration (the default for explainers and promos
   unless the user explicitly requests silent/music-only delivery or the video
   preserves existing spoken/lip-synced audio), call `speech.capabilities`, select a returned
   locale-compatible `route_ref` + `voice_ref`, write exact intent, then run the
   free `composition.check_narration_fit`. Open the plan stop only when
   `gate_b_ready:true`.
5. Read `composition.status` for the current production state. Reconcile
   file/state disagreement through `gate-control`. Plan identity is normalized
   approved intent, not raw manifest hash; implementation-only art direction,
   formatting, HTML/CSS/SVG/motion makes a new candidate without reopening plan.
   For new production, use `composition.doctor` to resolve required capabilities
   and `composition.prepare` to create the native scaffold.
6. For standalone speech after prepare, read
   [narration.md](references/narration.md) before
   `composition.materialize_narration`. AUTO child composition stays silent
   because its assembler owns narration. Narration failure blocks complete
   delivery, not visual authoring/inspect/snapshot.
7. Author visual DOM/CSS/SVG and deterministic tweens in the scaffold. Build the
   resolved visible frame first, then animate into it. Keep each scene's tweens
   inside its `ORKAS-SCENE-MOTION-BEGIN/END` block and target only that section;
   cross-scene/outside code may render but loses attribution and incremental
   reuse.
8. Run `composition.inspect`. Repair all independent blocking findings together,
   starting with manifest/art direction, then HTML. Advisories are judged, not
   loop-repaired. Retry only after canonical signature changes, with at most two
   materially different passes across inspect/snapshot. Native runtime owns QA:
   never install/start a browser, HTTP server, watcher, Puppeteer, Playwright, or
   headless Chrome.
9. Treat each `current_candidate.revision_id` as immutable. Edits create a new
   candidate and preserve accepted deltas. Publish only current locators, never
   private content-addressed storage paths or `first_frame` as the whole preview.
10. Preview before rendering when duration >=20s or scenes >=3, and for shorter
    work with dense text, complex SVG/GSAP, many supplied assets, narration
    complexity, or prior draft failure. Skip only genuinely short/simple work.
11. Before snapshot/draft/export, read
    [render-and-preview.md](references/render-and-preview.md). When a new visual
    preview is needed, run inspect + snapshot. Use its contact sheet as the complete index, open full scale only the
    cover, QA-named frames, or risky cells, then batch repairs. Pass readiness or
    errors and later user decisions to `gate-control`.
12. Run `composition.draft`. Structural failures repair the highest source—
    manifest, art direction/mapped content, then HTML—and never retry the same
    signature. Preserve render/audio/frame QA. A successful draft is not
    terminal: when `gate_d_ready:true`, freeze inputs and show the existing mp4
    plus QA headline through `gate-control`.

The default path is: direction -> candidate manifest -> free narration fit ->
one plan confirmation -> doctor -> native scaffold -> planned narration when applicable ->
VisualDirectionV1/resolved-frame authoring -> inspect/snapshot -> preview ->
draft -> final confirmation -> export. `VideoProductionStateV1` is durable state;
call status/reconcile rather than inventing or skipping a stage. Never write or
compile `spec.json`. A frontend-design preset is a starting system to remap and
adapt, not a fixed template.

## Scene-by-scene authoring

For a composition with four or more scenes:

1. Before HTML, write every scene's task sheet in `manifest.art_direction.scenes[]`
   in one pass: `source` (the reference shot range, product capture or supplied
   asset it shows), `layout` (regions and sizes) and `beats`, the time-coded
   actions inside the scene (for example `0.0 type the goal into the input`,
   `0.8 task rows expand`, `2.4 hold`), cutting on a beat when a tempo is known.
2. After `composition.prepare`, write one scene at a time (its section, CSS and
   timeline entries) from its own sheet. Do not generate all scenes in one script.
3. After every two or three scenes, run `video_studio`
   `op:"composition.scene_check"` with those `scene_ids`. Compare each scene's
   start, middle and end frames with its sheet and reference shot, and fix only
   the scenes that miss before writing the next ones.
4. When every scene has been checked, run inspect and snapshot once for the
   preview. After a later revision, re-check only the changed scenes; the draft
   render reuses unchanged ones.

`composition.scene_check` changes no QA, preview, approval or render state.

## Render-contract quality invariants

- **Render something at t=0 in every composition, including AUTO segments.** A
  scene or its title/hero beginning at `opacity:0` produces
  `EMPTY_HOOK_FRAME`, `EXPECTED_SCENE_NOT_VISIBLE`, or
  `HOOK_PROMISE_NOT_VISIBLE`. Author the resolved visible frame first. A user-
  requested fade from black is the exception.
- **Delivered frame 0 is a dedicated cover:** one approved headline, dominant
  `data-role="visual" data-cover-hero`, and at least two concrete visible
  `content_signals` (`data-cover-signal` when needed). A headline restatement is
  not a second signal.
- **Give QA semantic hooks:** `data-scene-id` on clips and
  `data-role="title|body|label|caption|visual"` on major groups. Keep readable
  copy as real HTML text.
- **Never position a tween at a literal second.** Leave scene visibility to the
  scaffold and position authored motion from `S("<scene-id>")`/`D("<scene-id>")`.
  Retime can shift every window; inspect reports
  `AUTHORED_ABSOLUTE_TIMELINE_SECONDS` with the replacement expression.

Native QA blocks small/unsafe text, overflow, overlap, occlusion, clipping, and
low contrast. Thin art direction, repeated grammar, one-note palette, and
decorative complexity remain advisory unless they break an approved visible
promise.

## Director judgment

- One concept per visual chapter; concrete before abstract.
- Follow `frontend-design`'s selected reference-led or original path for visual identity and scene variation.
- Render exact stats/names/CTAs as real text, never AI-image text.
- Build to narration words and hold a resolved chart/scene before moving on.
- Ordinary subtitles are caption-track data owned by assembly. Only decorative
  kinetic captioning may be baked into the composition, and the user must know
  it is not separately editable.

## Constraints

- Deterministic only: no real-time timers, network runtime behavior, or unfixed
  randomness; the renderer seeks discrete frames.
- Keep all assets inside the composition directory.
- This Skill authors/renders compositions; routing chooses the line and other
  Skills generate AI footage.
