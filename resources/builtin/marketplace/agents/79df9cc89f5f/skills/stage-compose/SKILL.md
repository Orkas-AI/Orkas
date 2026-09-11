---
ownerAgent: 79df9cc89f5f
name: stage-compose
description_zh: Orkas HTML 视频合成的编写知识——如何写一个 composition（index.html）、用时间线驱动动画、声明画幅与时长，再渲染成 mp4；解说/动画/动态图形/字幕叠加的核心技能。
description_en: Authoring knowledge for Orkas HTML video compositions — how to write an index.html composition, drive animation from a timeline, declare canvas + duration, then render to mp4; core skill for explainer/animation/motion-graphics/caption work.
---

# stage-compose

Author an Orkas HTML composition and turn it into video. In Orkas, lint,
inspect, snapshot, draft, and export run through built-in `video_studio`.

Apply `frontend-design` before writing `manifest.art_direction`. When the user
provides a reference image/video, DESIGN.md, brand guide, screenshot, design
notes, or named style, apply `design-system-importer` to create intent-bound
media constraints and compact tokens. After snapshot, apply
`composition-design-review` yourself as an advisory frame checklist; it never
replaces native QA or creates a gate.

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
frame set, wait for go-ahead, then draft the complete composition as one mp4.
Approved export re-encodes the same whole composition at delivery quality. The
new draft reopens final-video confirmation; do not imply only one scene can be
encoded or skip whole-composition QA.

In other words, `composition.draft` re-encodes the complete composition as one mp4;
export is not a scene-only shortcut.

## Fast COMPOSE runbook

1. Read this installed root once per conversation; re-read only when runtime
   reports an updated installation. Read an existing canonical manifest. Apply
   `frontend-design`; apply `design-system-importer` only for a concrete style
   source; apply `composition-design-review` only after snapshot.
2. Stop for direction before writing any manifest, narration, or art direction.
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
5. On every new/resumed production turn, call `composition.status`. Reconcile
   file/state disagreement through `gate-control`. Plan identity is normalized
   approved intent, not raw manifest hash; implementation-only art direction,
   formatting, HTML/CSS/SVG/motion makes a new candidate without reopening plan.
   Once current, call `composition.doctor` once that turn, fix missing required
   capabilities, then call `composition.prepare`.
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
    [render-and-preview.md](references/render-and-preview.md). Run inspect +
    snapshot, use contact sheet as the complete index, open full scale only the
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
compile `spec.json` or use fixed visual templates.

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
- Choose one subject-derived signature device and spend distinctiveness there.
- Render exact stats/names/CTAs as real text, never AI-image text.
- Build to narration words and hold a resolved chart/scene before moving on.
- Vary scene types; no three near-identical layouts in a row.
- Ordinary subtitles are caption-track data owned by assembly. Only decorative
  kinetic captioning may be baked into the composition, and the user must know
  it is not separately editable.

## Constraints

- Deterministic only: no real-time timers, network runtime behavior, or unfixed
  randomness; the renderer seeks discrete frames.
- Keep all assets inside the composition directory.
- This Skill authors/renders compositions; routing chooses the line and other
  Skills generate AI footage.
