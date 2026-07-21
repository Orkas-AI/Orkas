---
ownerAgent: 79df9cc89f5f
name: stage-compose
min_app_version: "1.6.0"
description_zh: Orkas HTML 视频合成的编写知识——如何写一个 composition（index.html）、用时间线驱动动画、声明画幅与时长，再渲染成 mp4；解说/动画/动态图形/字幕叠加的核心技能。
description_en: Authoring knowledge for Orkas HTML video compositions — how to write an index.html composition, drive animation from a timeline, declare canvas + duration, then render to mp4; core skill for explainer/animation/motion-graphics/caption work.
category: creation
---

# stage-compose

How to author an Orkas HTML composition and turn it into a video. Host-neutral: this skill describes the artifact you produce and the outcome you want (a rendered mp4). In Orkas, composition lint/inspect/draft/render runs through the built-in `video_studio` tool. Compatibility is enforced before install by the marketplace `min_app_version` field on the agent/skill.

For visual direction, apply `frontend-design` before writing `manifest.art_direction`. If the user provides a DESIGN.md, brand guide, reference site, screenshot, Figma notes, or explicit named style, apply `design-system-importer` to convert that source into compact VideoStudio tokens. `composition-design-review` is a bounded pre-preview visual check whenever snapshot evidence exists, with a post-draft fallback only when no reviewed preview was required; it must not replace native draft QA or create an open-ended redesign loop.

COMPOSE gate forms and authorization transitions are host protocol owned only by `gate-control`. This skill supplies the script, shotlist, manifest, contact sheet, draft, QA evidence, and production readiness state; pass those facts to `gate-control` and obey its returned form or operation instead of restating field ids or approval ordering here.

AUTO child compositions are the one Gate B inheritance path. They must use local `script.md`/`shotlist.json`/manifest artifacts derived from the signed parent segment's `composition_plan`. Ask `gate-control` to resolve parent-plan inheritance with the owning `plan_path` and `segment_id`; on success continue with the returned production operation, and on mismatch return to the single parent EDL review instead of inventing a child confirmation.

Visual QA repair is a strict state machine, not a general redesign prompt. `gate-control` alone owns any user authorization transition:

- **Fatal inspect blocker:** repair the reported runtime/structural contract and rerun `composition.inspect`. Until the fatal count is zero, do not call snapshot, preview approval, or draft.
- **Visual review required:** when inspect returns `ok:true`, `visual_review_required:true`, and `preview_capture_allowed:true`, call `composition.snapshot` before editing so the user and the repair loop receive contact-sheet evidence. High-confidence visual blockers may produce a preview but cannot mint preview approval or advance to draft; advisories continue normally.
- **Passing snapshot awaiting design review:** inspect every returned `frame_paths` item in one pass, not only the contact sheet or one representative scene. Batch all concrete visible blockers into one verdict. Repair only the affected scenes, then rerun inspect + snapshot; do not show, draft, or approve the stale preview. Other scenes and the approved direction remain frozen.
- **Snapshot semantic failure:** use the returned `preview_qa`/`frame_evidence`, repair the implicated frame/scene so the canonical manifest or HTML signature changes, then rerun inspect + snapshot. Never retry an unchanged signature or treat failed evidence as review-ready. Stop on the native repair-budget error.
- **Exhausted visual QA cycle:** pass the exact native result to `gate-control` and obey its resolver. This skill does not decide whether a form or recovery operation is allowed.

Each QA repair step has one next operation and one bounded repair target. A later passing snapshot may open the preview gate; prohibitions above apply while the reported blocker or stale signature still exists.

## Post-gate authorization and revisions

`gate-control` is the single canonical authorization and state-transition policy for Gate B, Preview, Gate D, signed amendments, and exhausted visual-QA recovery. On every gate submission or post-gate edit, read that compact skill and run its bundled resolver before calling a production tool or emitting another form. This skill owns COMPOSE artifacts and QA craft; it does not redefine gate authorization.

For COMPOSE scope classification, styling-only changes to HTML/CSS/SVG/layout/motion/palette/assets stay `visual_only`. Changes to signed delivery fields, approved copy, narration, timing, language, source mappings, semantic roles, or narration intent are `gate_b_payload`. When uncertain, inspect the requested files and resolve scope without asking a technical confirmation.

After the resolver authorizes a normal revision, edit only the bounded files and follow its returned reconcile/QA operation. This skill never infers recovery authority or substitutes a different transition.

## Fast COMPOSE runbook

Before Gate B, make the candidate plan internally executable; after approval, keep the production turn narrow:

1. On every new or resumed COMPOSE turn, re-read the currently installed copy of this skill; an online Marketplace update supersedes any older copy already present in session history. Then read only `project/script.md` and `project/shotlist.json`. Also read `frontend-design`; read `design-system-importer` only when a concrete style source or explicit named reference exists. Read `composition-design-review` after a successful snapshot returns `preview_design_review_required:true`; if preview was skipped, read it only when a successful draft returns `design_review_required:true`.
2. Gate B `shotlist.json` must lock `target_duration_seconds`, `video_language`, `audio_mode`, `caption_mode`, and `music_mode`; silence, no captions, and no music must be explicit values rather than omissions. For narration, first call `video_studio` with `op:"speech.capabilities"`, choose only one returned `route_ref` + `voice_ref` whose native or verified supported locale matches `video_language`, and copy its `display_name` with the exact BCP-47 `language` and a natural `speed` into the manifest—never use a candidate non-native language and never invent or recall a provider voice id. Before showing Gate B, write the candidate schema-version 2 source of truth `project/composition/composition-manifest.json` from the same script/shotlist. It owns canvas, immutable target duration, fps, video language, scene windows, complete approved `source_shots` mappings, semantic roles, the narration intent, audio ownership, and `art_direction`. For standalone narrated work, put the complete candidate words in each scene's `narration_text` and keep pre-production audio at `owner:"none"`, `tracks:[]`, plus the selected `narration_intent`. For visual-only/SFX-only COMPOSE, keep `narration_text` empty and say at the gate that no voiceover will be generated. Do not create an audio file or a second structural contract yet.
3. For standalone narration, run the free `composition.check_narration_fit` against that candidate manifest before opening Gate B. Open Gate B only when it returns `gate_b_ready:true`. When it returns `over` or `under`, revise `script.md`, `shotlist.json`, and matching scene `narration_text` together to the returned `suggested_units`, then run the free check again without asking the user. After a measured TTS mismatch, the check automatically uses the persisted voice/speed calibration; never let a later generic estimate reverse that measured recommendation. This is an internal timing repair, not a new creative gate: when the free check returns `approval_inherited:true` and `gate_b_required:false`, the native state has carried the existing Gate B approval to the bounded revision, archived stale audio, and returned to `manifest_ready`; call `composition.prepare` and continue without showing Gate B again. If it returns `repair_authorization_status:"rejected"`, only then treat the change as a new plan requiring Gate B. Allow at most two free revision checks for one measured mismatch; if they still do not converge, report the deterministic fit result as a blocker instead of opening Gate B repeatedly or sending another speech request.
4. On every new/resumed production turn, call canonical `composition.status`; if files and recorded evidence disagree, pass that evidence through `gate-control` and follow the returned recovery. Once the plan signature is current, run canonical `composition.doctor` before any paid operation and fix missing required capabilities, then call `composition.prepare`. `stage` and `next_allowed_ops` are compatibility hints, not an operation whitelist; native operations enforce their own current-fact preconditions. If standalone narration is needed, call `composition.materialize_narration` after prepare and before snapshot/draft delivery. It reuses the same calibrated fit policy, synthesizes once, persists a recoverable transaction plus measured voice calibration, records hashes/measured duration, writes per-scene `narration-map.json`, and retimes the canonical manifest. If visual HTML was already authored, the operation preserves model DOM/CSS/SVG and reconciles only protected timing/audio bindings. A resumed call recovers matching audio without another paid request. Never use generic `generate_speech` for standalone COMPOSE narration.
5. Model-author the visual content, CSS, SVG, and deterministic tweens inside the prepared scaffold; visual work and lint/inspect may proceed while narration is pending, but snapshot, draft, approval, and export remain blocked until required narration is materialized. Use the HyperFrames-style discipline from `frontend-design`: first confirm the visual identity and `VisualDirectionV1` in `manifest.art_direction`; then author each scene's resolved/hero frame as static HTML/CSS/SVG using the declared video scale, depth layers, typography register, motion verbs, and rhythm pattern; only after the resolved layout is readable add GSAP entrances, reveals, and transitions into that layout. Do not begin with hidden/offscreen animated start states, generic placeholder diagrams, decorative emoji/icons, centered equal-weight layouts, or web-scale type. Then run `composition.inspect`; if it reports blocking design-contract errors, repair the manifest art direction first and rerun inspect before snapshot or draft. Inspect findings are always host-persisted. Retry only after the canonical manifest or HTML signature changes, and allow at most two distinct repair passes across the shared inspect/snapshot QA cycle; advisory or duplicated findings do not consume a pass. `E_INSPECT_RETRY_NO_CHANGE` is terminal until inputs change. `E_VISUAL_REPAIR_BUDGET_EXCEEDED` is terminal for the current cycle; pass the exact result to `gate-control` and obey its resolver instead of deciding a form here. `E_INSPECT_ALREADY_PASSED` means follow the prior next action without rerunning inspect. Do not recreate root timing, media playback, vendor setup, or timeline registration with ad-hoc code. Never install dependencies or start a browser, HTTP server, watcher, Puppeteer, Playwright, or headless Chrome for QA; native `video_studio` operations own that runtime. QA repair is internal work; `gate-control` alone decides whether a user recovery gate exists.
6. Open the HTML Preview Gate before rendering when target duration >= 20s or scene count >= 3; the native tool enforces this so short multi-scene work cannot pass only structural QA. Also use it for shorter work when render rework is likely expensive because of dense text, complex SVG/GSAP, many branded/supplied assets, or a prior draft failure. Skip it only for genuinely short/simple work: target duration < 20s, scene count <= 2, no narration/timing complexity, and no obvious visual-risk signal.
7. If HTML preview evidence is required, run `composition.inspect` and `composition.snapshot` to `project/composition/preview/first-frame.png`. Snapshot runs the same fail-closed preflight first, captures at least one semantic midpoint for every scene plus hook/payoff evidence, and returns distinct `first_frame`, `contact_sheet`, and `frame_paths` fields. Before showing the preview or handing readiness to `gate-control`, read `composition-design-review`, inspect every returned frame path at usable scale, and call `composition.submit_design_review` with the complete `reviewed_frame_paths` list. The contact sheet is an index, not a substitute for checking individual frames. Collect all visible blockers across all frames before editing; submit one `repair` verdict, make one batched localized repair, then rerun inspect/snapshot and review the complete new frame set. Only a `passed` result publishes the contact sheet and opens the existing Preview Gate. On native failure, use `preview_qa`, `frame_evidence`, or `findings_path`; never retry the same signature. Pass the final readiness/error result and any later user decision to `gate-control`, then perform only its returned edit, reconcile, QA, or production operation.
8. Run `composition.draft`. The production path reuses the canonical manifest, fail-closed preflight, runtime seek probe, render, audio/media QA, semantic sampled-frame QA, and one report. Structural errors never spend a full-render attempt.
9. If draft fails, repair the highest structural source (`composition-manifest.json` first, then its art direction/mapped content, then visual HTML) and rerun within the bounded repair budget. Stop when the budget is exhausted.
10. After draft, keep native render-specific QA—encoding, media duration, audio stream/loudness, semantic frame coverage, blank/frozen frames, and timing. When the result says `design_review_inherited_from_preview:true`, do not repeat static layout review; proceed when `gate_d_ready:true`. Only when preview was skipped and draft returns `design_review_required:true`, use `composition-design-review` as the fallback, inspect its evidence, and submit a structured verdict. A fallback `repair`/`blocked` verdict is signature-bound: repair, reconcile, and render a new draft before it can pass. When `gate_d_ready:true`, freeze the manifest, HTML, assets, and narration; show the draft mp4 plus the QA headline and pass that readiness state to `gate-control`.

The default path is **candidate script/shotlist/manifest -> free calibrated narration fit -> one Gate B -> artifact signature -> doctor -> native scaffold -> recoverable narration materialization (when needed) -> VisualDirectionV1 and visual identity check -> resolved-frame HTML authoring -> GSAP motion into those layouts -> per-scene preview/draft evidence**. `VideoProductionStateV1` is the durable domain-state source for this sequence; Agent plan/completed-work state stores its state reference/revision and must call status/reconcile rather than inventing or skipping a VideoStudio stage. Do not write or compile `spec.json`; fixed visual templates are not part of the COMPOSE path because visual quality and extensibility still belong to the model.

## How to call the render path

Use the Orkas-native tool call:

```json
{"op":"composition.draft","composition_dir":"project/composition","output_path":"project/render/draft.mp4","quality":"draft","report_path":"project/render/draft-report.json","findings_path":"project/composition/qa/inspect.json"}
```

The tool returns JSON. A tool error means a structural/render-safety issue or Orkas runtime issue must be fixed before continuing.
For draft output, the report includes contract/source alignment, lint, inspect, media probe, loudness, audio timing, video-frame QA, real render throughput, optional visual-regression status, and compact `design_review_inputs`. Video QA samples the first frame and scene starts/mids so an empty hook frame, blank scene boundary, or long frozen sampled run blocks Gate D. It also writes a contact sheet and per-sample evidence frames for design review when available.
Use the draft command's lint and inspect gates before rendering. Lint blocks render-contract errors such as unregistered timelines, missing clip timing, invalid root timing, and imperative media control. Semantic visual defects on readable content—small text, overflow, occlusion, overlap, low contrast, safe-area violations, and primary elements outside canvas—are blockers. Decorative out-of-canvas accents plus palette/layout-variety findings remain advisory design feedback.
When using `findings_path`, the full QA payload is saved to disk; read the file only when the summary points to a specific issue that needs detail.
Stop and repair when `draft_disposition.blocking_error_count > 0`, lint/contract/audio/source/video QA fails, or the renderer cannot produce media. A passed approved-preview review is inherited, so do not repeat static layout review after rendering. Only when preview was skipped and the draft requests fallback design review must that verdict pass before Gate D; advisory-only palette/variety findings travel in the Gate D note.

Raw `composition.render` is not exposed to the agent because it would bypass video QA. Give the frozen draft signature and user submission to `gate-control`; only an export transition returned by that policy may call the QA-gated high export:

```json
{"op":"composition.export","composition_dir":"project/composition","output_path":"project/render/final.mp4","report_path":"project/render/final-report.json"}
```

`composition.export` is allowed only when the composition inputs still match the successful draft and the native approval state is current. It reruns render, media QA, and video-frame QA at high quality, then returns `next_action: "deliver_final"`. The system publishes the exported mp4 as the final visible deliverable; the final response must include that media artifact or a clear blocker.

For an export authorized by `gate-control`, call `composition.export` once and let the host choose the highest safe fps for the current machine; a `render_profile.degraded_fps` fallback is internal execution, has `confirmation_required:false`, and must continue directly to delivery. Never modify `composition-manifest.json`, call `composition.reconcile`/`composition.draft`/`composition.snapshot`, or reopen Preview/Gate D solely because the host lowered fps or another non-content encoder setting. Set `strict_render_settings:true` only when the user explicitly required exact technical settings. If strict settings or an extremely heavy composition have no safe fallback, report the export constraint as a blocker without inventing another content approval gate.

## HTML Preview Gate

Use the HTML Preview Gate to avoid expensive mp4 rerenders when visual rework is likely. It is a cost-control gate, not a new creative milestone, and it is only for the COMPOSE line. Decide from expected rework cost:

- **Preview first (hard gate)** when duration >= 20s or scene count >= 3. `composition.draft` rejects missing, stale, failed, or not-explicitly-approved previews.
- **Preview first** for shorter pieces with dense text, multiple chapters, supplied/brand assets, complex SVG/GSAP motion, tight narration timing, or a prior draft/repair failure.
- **Skip preview** only when duration < 20s, scene count <= 2, and the HTML is simple enough that rendering the draft is cheaper than asking for another confirmation.
- Do not use product/promo/version-update labels alone as the trigger. Those labels only contribute to risk when the piece is long, visually dense, or expensive to rerender.

When preview is triggered:

1. Run inspect and write findings:

```json
{"op":"composition.inspect","composition_dir":"project/composition","findings_path":"project/composition/qa/inspect-preview.json"}
```

2. Run the keyframe snapshot. `output_path` remains the first-frame PNG for compatibility; the result also contains a contact sheet and semantic evidence for every scene:

```json
{"op":"composition.snapshot","composition_dir":"project/composition","output_path":"project/composition/preview/first-frame.png"}
```

3. Read `composition-design-review`, inspect every path in `frame_paths`, and submit one complete verdict with the exact `reviewed_frame_paths`. Do not expose the preview while this internal review is pending. If any frame has a blocker, list all blockers found across the full set, repair them together, then rerun inspect + snapshot; a changed snapshot requires review of its full new frame set.

4. Only after `composition.submit_design_review` returns `preview_gate_ready:true`, hand `gate-control` the now-published contact sheet, the `index.html` path, and a compact readiness note:
   - reason for preview: duration / scene count / complexity / prior failure
   - inspect headline: blocking count or main advisory
   - what approval means: render mp4 draft next

5. After the user responds, obey the edit or production transition returned by `gate-control`. Keep preview revisions lightweight; do not synthesize new narration or render mp4 while the preview artifact is still under review.

Use `update_visual_baseline: true` only when the user or an explicit project workflow promotes an approved preview to a golden baseline. Later snapshots/drafts compare matching sampled frames and report changes as advisories; baseline drift never starts an automatic rerender loop.

The HTML Preview Gate does not replace the mp4 draft. It cannot validate audio muxing, final encoded video quality, sampled-frame video QA, or exact narration pacing. After approval, always run `composition.draft` and open Gate D with the video.

## Canonical composition manifest

Write `project/composition/composition-manifest.json` before `composition.prepare`. This is the only structural source of truth; never duplicate its canvas, duration, scene windows, or audio ownership in design-contract.json.

```json
{
  "schema_version": 2,
  "composition": { "id": "main", "width": 1920, "height": 1080, "duration": 60, "target_duration": 60, "fps": 30, "language": "en" },
  "scenes": [
    {
      "id": "hook",
      "start": 0,
      "duration": 5,
      "approved_copy": ["Orkas 1.5.0"],
      "narration_text": "A concise line for this exact window.",
      "narration_refs": ["n01"],
      "source_shots": ["s01"],
      "roles": ["title", "visual"]
    }
  ],
  "audio": {
    "owner": "none",
    "tracks": [],
    "narration_intent": {
      "route_ref": "<copy exactly from speech.capabilities>",
      "voice_ref": "<copy exactly from speech.capabilities>",
      "display_name": "Vivi",
      "language": "zh-CN",
      "speed": 1
    }
  }
}
```

This is the planned pre-production form. Gate B signs `narration_intent`; `composition.materialize_narration` reads it without execution-time overrides, changes `audio.owner` to `composition`, writes the narration track, preserves the intent, and replaces estimated timing with measured timing. Schema version 1 is accepted only for legacy recovery.

Every scene needs canonical numeric `start` and `duration`; do not invent `start_s`/`duration_s`. Use `source_shots` for approved-shot mapping and `narration_text`/`narration_refs` for voice alignment. Use audio owner `assembler` for AUTO segments that must render silent.

`composition.materialize_narration` writes `project/composition/narration-map.json` automatically from the measured audio and approved per-scene narration. For externally supplied narration only, provide a compatible map before draft:

```json
{
  "lines": [
    { "id": "n01", "scene_id": "hook", "start": 0.0, "end": 3.2, "text": "Meet Orkas 1.5.0." }
  ]
}
```

Then use `"narration_ref": "n01"` or a comma-separated list on the matching scene. Timed media refs such as `"assets/narration.mp3#t=0.0,3.2"` are also valid when the map line includes `scene_id` or matching start/end. If no map is present, every narrated scene must include inline `narration`/`narration_text` plus numeric start/duration or start/end; otherwise draft QA blocks Gate D.

## Native composition scaffold

`composition.prepare` owns the structural HTML contract. It derives the root canvas/timing, scene clips, semantic scene ids, declarative audio elements, local GSAP vendor reference, paused master timeline, and timeline registration from `composition-manifest.json`. Do not hand-create or replace those fields. After visual authoring, use `composition.reconcile` to update only protected root/clip/audio metadata while preserving authored DOM/CSS/SVG; custom tween timing still must be adjusted deliberately when scene timing changes.

Author visual DOM inside the generated scene roots and add motion to `window.__ORKAS_COMPOSITION_TIMELINE__`. Never call `play`, `pause`, or assign `currentTime` on media; media timing is declarative and renderer-owned. Never create another wall-clock or unregistered timeline.

## Authoring patterns

- **Canvas per aspect ratio**: declare it once in the manifest: 16:9 → 1920×1080, 9:16 → 1080×1920, 1:1 → 1080×1080. The scaffold mirrors it into HTML.
- **Scenes**: declare one canonical scene window per storyboard beat in the manifest. Do not independently retime generated clip attributes.
- **On-screen text**: keep it inside the frame with padding; large, high-contrast type; one idea per scene.
- **Assets**: reference images/footage produced upstream by relative path inside the composition dir (e.g. `./assets/shot1.png`).
- **Timing**: position every tween on the generated paused GSAP timeline with an explicit time; manifest duration is final.
- **SVG-first visual layer**: prefer inline SVG for non-text motion graphics such as diagrams, connectors, nodes, progress paths, charts, orbit lines, icon-like marks, and background geometry. Keep readable prose in normal HTML text boxes unless the SVG text is large, simple, and verified.
- **Use GSAP only when time-based motion is needed**: static SVG, CSS layout, and simple held states do not need GSAP. When animation is needed, keep GSAP as the timeline/orchestration layer that animates SVG groups or a small set of HTML containers. Do not build dozens of absolutely positioned HTML nodes/cards/lines when one SVG graph can carry the visual.
- **No remote runtime resources**: `index.html` must not load CDN scripts, remote fonts, remote images, or remote CSS during render. Fetch or copy required runtime files into `project/composition/assets/` during authoring, then reference them with relative paths such as `./assets/vendor/gsap.min.js`. Draft QA blocks `http://` and `https://` references.
- **Local GSAP vendor**: the native path prepares the built-in offline vendor referenced by the scaffold. Do not manually patch `assets/vendor/gsap.min.js`.

## HTML visual quality floor

The common failure mode is technically valid HTML that looks like a low-effort web mockup. Before writing code, convert the approved beat into a video-frame grammar:

- Pick one scene grammar from the brief: full-bleed object/texture, kinetic typography, diagram build, data mark, map/flow, editorial argument, product surface, or before/after comparison. Do not default to a centered card, bento grid, purple/blue gradient, or generic SaaS dashboard.
- Make frame 0 useful as a thumbnail: visible promise, strong focal shape, and subject-specific signal. Do not tween the entire first scene from opacity zero or start with a blank fade-in unless the user explicitly asked for that.
- Use one dominant visual plus one readable text zone per scene. Give the frame a topic-derived background field, a meaningful midground, and foreground accents/metadata so the composition has depth rather than a small cluster in a large empty canvas. If the beat needs three or more text zones, split the scene or turn details into SVG labels/diagram nodes.
- Author opening, explanation, and resolved states before writing tweens. Build the resolved composition first, then reveal or transform only the structures that communicate the beat; a container fade is not a scene idea.
- Reuse one content-specific carrier across adjacent scenes when possible, transforming it between document, path, chart, interface, map, or convergence states instead of resetting to a title slide.
- Give every scene a different framing move or visual state. Three consecutive title/card/list scenes with only copy changes is a design failure, even when it renders correctly.
- Keep text in real HTML, but give important elements QA hooks such as `data-scene-id` on scene clips and `data-role="title|body|label|caption|visual"` on major text/visual groups.
- Use SVG for the signature device and meaningful structure. Rows of identical cards, tiny badges, and decorative boxes are not a substitute for a visual idea.
- Let the contract's colors and type roles drive CSS variables. Extra colors are allowed only when they carry brand, hierarchy, data meaning, or scene variation.

Native QA blocks semantic readability failures including small text, unsafe text, overflow, overlap, occlusion, clipping, and low contrast. Thin art direction, repeated layout grammar, one-note palettes, and decorative complexity remain advisories unless design review ties them to a concrete broken promise.

## Manifest art direction before HTML

Before styling the generated scaffold, write `art_direction` inside `project/composition/composition-manifest.json`. It is an internal visual contract, not a user gate and not a second structural artifact.

## Video language vs chat language

Keep two language concepts separate:

- **User UI language** comes from system context. Use it for chat replies, gate summaries, status text, form labels, and any explanation addressed to the user.
- **Video language** comes from the VideoStudio `language` input and `manifest.composition.language`. It is the primary language for the deliverable: Gate B script/shotlist content, `approved_copy`, `narration_text`, captions, titles, subtitles, CTAs, and visible HTML text.

Use the video language locked during direction confirmation under `gate-control`; do not infer a second default in this line skill. After direction confirmation locks video language, do not introduce bilingual copy unless the user explicitly requested it or approved it with the production plan. Proper nouns, product/model/API names, code identifiers, and non-approved decorative texture text may remain in their original language. If the user deliberately selects English in a Chinese UI, explain the plan in Chinese while making the video copy English. If the selected video language is Chinese, do not add unapproved decorative English HUD slogans merely to create a tech mood.

The contract must declare these budgets compactly:
- `aesthetic`: from `frontend-design`: subject world, audience, one job, tone, signature device, aesthetic risk, and `anti_template_check` (legacy `anti_template` is accepted by native QA, but new manifests should write `anti_template_check`).
- `visual_direction`: `VisualDirectionV1` from `frontend-design`: real design tradition/reference, composition behavior, lazy defaults rejected, video scale, depth-layer rule, motion-verb rule, typography register, and rhythm pattern. This is the P0/P1 front-loaded aesthetic director for HTML authoring, not a fixed template.
- `style_source`: from `design-system-importer` when a DESIGN.md, brand guide, screenshot, reference site, Figma notes, existing app UI, or explicit named style was used. Omit when there is no external style source.
- `scenes`: visual focus and layout type only. Structural start/duration, approved copy, source shots, and narration refs stay exclusively in the manifest. Designed scenes may include `scene_world`, `hero_visual`, `composition`, `depth_layers`, `motion_verbs`, `opening_state`, `resolved_state`, `continuity_in`, `continuity_out`, and selected `primitive_refs`.
- `layout_boxes`: safe text box, visual box, caption box, and maximum label count per scene.
- `typography_tokens`: title/body/caption/label floors plus type roles and register. Default floors for 1920x1080: title >=72px, body/supporting text 28-42px, label/caption 18-26px, safe margin >=96px, no more than two text blocks and about 12-16 English words per scene. Preserve the same readability intent for 9:16 and 1:1. Preserve approved English casing: sentence/natural title case for titles and sentence case for body, captions, subtitles, and CTAs. Existing all caps may remain only when that exact casing appears in approved user copy or an external brand/source, and then only for one short metadata label, acronym, or code. A model-authored art direction, design tradition, typography register, or generic tech/editorial mood never authorizes converting copy to all caps; never use a broad `text-transform: uppercase` rule. Avoid default two-sans pairings unless the external style source explicitly requires them; use scale, weight, width, color, spacing, mono/data roles, or serif/sans contrast to make hierarchy visible while preserving approved casing.
- `color_tokens`: named baseline values with rationale: background, surface, text, muted, primary accent, and any purposeful supporting accents the approved visual idea needs.
- `motion_budget`: max animated groups per scene, allowed transitions, easing, rhythm pattern, which SVG/HTML groups move, what each motion communicates, and the concrete motion verbs assigned to primary elements.
- `scene_variation`: how the sequence avoids three near-identical layouts, transitions, or card/title scenes in a row.

The palette is a design contract, not a mechanical hue cap. The HTML/CSS/SVG should derive its main system from `color_tokens` through CSS variables or equivalent structured constants, but do not flatten or recolor a scene just to reduce a static color count. Add purposeful local colors when they improve hierarchy, brand fidelity, data meaning, or scene variation, and keep them named or easy to audit.

The unified preflight enforces the manifest, scaffold, and art direction before snapshot or rendering. It blocks when:
- `composition-manifest.json` is missing, unversioned, invalid, overlapping, or incomplete.
- `manifest.art_direction` lacks the preview-required aesthetic thesis, `VisualDirectionV1`, motion budget, scene variation budget, per-scene depth layers, or per-scene motion verbs needed to guide model-authored HTML.
- Root/scene/audio attributes differ from the canonical manifest.
- Scene timing falls outside the composition duration or overlaps unintentionally.
- Declared scene headline/title/on-screen copy is missing from `index.html`.
- HTML references a missing local asset, an absolute path, an asset outside the composition directory, or a remote runtime URL.
- HTML calls `gsap.*` without the generated local vendor/paused registered timeline, or controls media imperatively.

It warns, without blocking, when scenes repeat the same layout grammar or the palette is one-note. Sampled DOM findings on readable content—safe-zone, contrast, overlap, clipping, overflow, and small type—are blocking; decorative accents may extend outside canvas when clearly marked as non-semantic.

Typography and layout budgets are binding for every readable element, including badges, pills, labels, captions, cards, nodes, and microcopy. Do not put long labels in circles or small decorative nodes; use larger cards, capsules, or nearby labels. If approved copy cannot fit safely, shorten on-screen text without changing meaning. Ask the user only when the message would change.

Run a pre-code anti-template check from `frontend-design`: name the first generic design move you rejected and the brief-specific replacement. If you cannot name that replacement, the contract is not ready. The check should catch lazy defaults before HTML: purple/blue neon, glowing black-background circles, centered equal-weight layouts, identical cards, decorative emoji/icons, tiny badges, web-dashboard fragments, pure black/white, and web-scale type. When `style_source` exists, also name what was adapted, simplified, and not copied from the reference.

## Inspect and repair policy

Before any user-facing HTML preview, complete snapshot design review across every returned frame. After preview approval (or when preview is legitimately skipped), run the draft command. If lint, contract/source/audio timing, media/video-frame QA, or inspect `draft_disposition.blocking_error_count` is not OK, repair once and run the draft command again. A second repair pass is allowed only when the remaining blockers are fewer and clearly localized. If the script returns `E_REPAIR_BUDGET_EXCEEDED`, do not delete the repair state or run another draft command; show a concise blocker with the report path and the last error.

Repairs should address the cause, not just the symptom:
- `FONT_TOO_SMALL`: reduce text density, shorten copy, enlarge/reflow containers, or move labels out of small shapes. Do not simply increase every font size if that creates overflow.
- `missing_timeline_registry`, `gsap_timeline_not_registered`: register a paused GSAP timeline on `window.__timelines[compositionId]`, using the exact root `data-composition-id`.
  - `timed_element_missing_clip_class`, `root_composition_missing_data_start`, `media_missing_data_start`, `imperative_media_control`: let the renderer own timing and media playback through `data-start`, `data-duration`, `.clip`, and media data attributes. Do not drive render-critical timing with custom `play()`, `pause()`, `currentTime`, timers, or a custom `seekTo` API.
- `text_occluded`, `text_box_overflow`, `content_overlap`: restructure the scene layout or regenerate the affected scene from the contract's boxes. Do not rely on small numeric nudges.
- `STATIC_FRAME_RUN`: fix the timeline registration, scene clip timing, or scene variation; do not deliver a draft whose sampled frames are identical across multiple scenes.

If repair makes blocking errors worse, or if structural/render-safety blockers remain after the allowed repair passes, stop with a concise blocker report and the findings path. Regenerating `index.html` counts as one of the two repair passes; do it only when the failure is structural, not as an open-ended loop. If only visual advisories remain and `--op draft` returned `ok: true`, present the mp4 draft with QA notes instead of silently looping. Repair `composition-manifest.json`, its art direction, mapped content, or visual HTML directly; do not introduce `spec.json` as a workaround.

Use `composition-design-review` before the Preview Gate whenever snapshot returns `preview_design_review_required:true`; inspect every returned frame path and submit the exact full path set. After draft, run it only as a fallback when the result still says `design_review_required:true`. A review blocker must be visible in a specific scene/frame and break readability, the approved promise, required brand/style tokens, motion timing, or asset safety. Treat minor polish as Gate D notes, but never skip a required structured verdict.

## Narration / audio track

**WHO OWNS NARRATION — decide this first:**
- **Standalone COMPOSE deliverable** (the composition IS the finished video, no assemble step): plan with `audio.owner="none"`, then let `composition.materialize_narration` change the validated manifest to `audio.owner="composition"` and generate the `<audio>` scaffold element that the renderer muxes.
- **Composition is a SEGMENT in an AUTO/assemble pipeline** (the assembler will mix narration in its mix tier — `stage-assemble` step 3): render this composition **SILENT — do NOT add a narration `<audio>` track**. If you bake narration in here AND the assembler mixes it, narration is added twice and you get two overlapping, drifting voices (the "two voices" defect). The mix step now refuses a non-silent base (`E_EDIT_BASE_HAS_AUDIO`) precisely to catch this. Background music inside the composition is also best left to the assembler so it can duck consistently under the one narration.

To give a STANDALONE explainer a voiceover: approve its words at Gate B, write those exact words as scene `narration_text`, prepare the planned manifest, then call `composition.materialize_narration`. Do not call generic `generate_speech`, manually patch the resulting track, instantiate `Audio`, call `.play()`/`.pause()`, assign `.currentTime`, or use a GSAP callback to control media.

```json
"audio": {
  "owner": "composition",
  "tracks": [
    { "id": "narration", "kind": "narration", "src": "assets/narration.mp3", "start": 0, "duration": 60, "volume": 1 }
  ]
}
```

- `composition.target_duration` and the final scene end remain equal to the Gate B delivery target. The narration track records its measured spoken length and may leave a short intentional tail for music/visual payoff; it must never silently shorten the composition.
- `composition.materialize_narration` uses the manifest's approved total duration as its target automatically. Its free mixed-language preflight counts CJK characters, Latin words/initialisms, numbers/versions, punctuation pauses, and speed. `E_TTS_TEXT_TOO_LONG` returns before billing and requires returning to the Gate B script instead of silently shortening approved words.
- Always pass the approved manifest duration as the narration `target_duration` through `composition.materialize_narration` rather than calling generic speech synthesis with an implicit or guessed target.
- After one successful synthesis, the operation records `measured_duration_sec`, allocates scene windows within the immutable target, writes `narration-map.json`, and rebuilds the untouched scaffold. If measured speech is longer than target or more than 10% short, the recoverable transaction and a bounded timing-repair authorization are preserved. Revise the synchronized narration copies and run the free fit check; when it returns `approval_inherited:true`, continue from `composition.prepare` without re-opening Gate B. A structural change or narration rewrite beyond the authorized edit scope still requires a new Gate B approval.
- If `composition.materialize_narration` fails, never silently continue: respect its production state and error code, then either fix the approved narration input or explicitly proceed silent with that stated at the gate. Draft QA flags a contract that declares narration while the composition has no audio (`NARRATION_DECLARED_BUT_SILENT`) — do not present such a draft as if it were complete.
- Narration output is fixed at `project/composition/assets/narration.mp3`, keeping the composition self-contained and making successful synthesis idempotent across resumed Agent turns.
- Add background music only after narration timing is materialized, keep its volume low (e.g. 0.2), update the manifest track, then call `composition.reconcile` so protected audio markup stays synchronized without replacing visual HTML. Do not make music part of narration duration fitting.
- Keep narration audio inside the composition dir so the render is self-contained.
- **Talking-head caveat:** when this composition is being overlaid onto AI-generated talking-head footage that already has **lip-synced built-in speech** (generation line), do NOT add a narration `<audio>` track. The renderer's muxed audio replaces the clip's own voice, so a synthesized narration would desync from the mouth. Use this composition for captions / lower-thirds only and let the clip's built-in audio stand (background music at low volume is fine; spoken narration is not).

## Render (the outcome)

Produce the finished video from the composition **directory**. Iterate with `composition.draft`; when `gate-control` returns an export transition for the frozen draft, run the single high-quality `composition.export` pass. Draft and export use the same canonical manifest, preflight, source, inspect, audio, media, and semantic video QA. Raw render-only operations are not exposed to the agent.

## Director judgment (compose line)

Craft calls specific to designed/animated explainers, on top of the shared craft reference (video-craft):

- **One concept per visual chapter** — don't stack two ideas in one scene; give each its own build.
- **Concrete before abstract** — real data, diagrams, steps before a metaphor; the metaphor only lands once the concrete version is understood.
- **Aesthetic thesis before styling** — use `frontend-design` to choose one signature visual device that comes from the subject matter; spend distinctiveness there and keep the rest disciplined.
- **Reference styles become tokens** — use `design-system-importer` for DESIGN.md/brand/reference input, then adapt the tokens to video safe zones and motion. Do not clone protected layouts or assets.
- **Design review happens before costly rendering** — when snapshot requests it, inspect the complete frame set and submit the verdict before exposing the Preview Gate. Use post-draft review only as a no-preview fallback. Block only on concrete visible failures; template feel, hierarchy, and polish issues that do not break the promise go to the later review note.
- **Render exact text as real text** — stats, names, CTAs are typed into the composition, never baked into AI imagery (which hallucinates numbers and can't be corrected).
- **Build to the narration words**, not arbitrary beats; hold a fully-built scene/chart ≥ 2–3 s before moving on.
- **Vary scene types** — no three near-identical layouts in a row; alternate full-frame / split / diagram / quote.
- **Spoken/readable captions live in the plan's `tracks.captions.lines` (data), NOT burned into this composition** — the assembler burns them via `burnsubs` at the end, so a later typo fix is a one-line edit, not a re-render of the whole composition. Only a PURELY DECORATIVE caption treatment that IS the visual design (kinetic highlight sweeps, word-by-word reveals) may live inside the composition — and when it does, tell the user that styled caption is part of the picture and not separately editable later. Keep ordinary subtitles as caption-track data, synced to the voice.
- The host blocks undersized or unreadable semantic text before draft; oversized palette and decorative complexity remain advisories judged against the design thesis, brand, and scene clarity. (Orkas: use `video_studio` `op: "composition.draft"`.)

## Constraints

- Deterministic only: no real-time timers, no network-dependent runtime behavior, no randomness without a fixed seed — the renderer seeks discrete frames.
- Keep all referenced assets inside the composition directory so the render is self-contained.
- This skill authors and renders compositions; it does not pick the production line (see the routing skill) or generate AI footage.
