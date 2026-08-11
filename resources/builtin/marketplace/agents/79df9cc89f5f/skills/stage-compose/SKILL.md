---
ownerAgent: 79df9cc89f5f
name: stage-compose
min_app_version: "1.6.5"
description_zh: Orkas HTML 视频合成的编写知识——如何写一个 composition（index.html）、用时间线驱动动画、声明画幅与时长，再渲染成 mp4；解说/动画/动态图形/字幕叠加的核心技能。
description_en: Authoring knowledge for Orkas HTML video compositions — how to write an index.html composition, drive animation from a timeline, declare canvas + duration, then render to mp4; core skill for explainer/animation/motion-graphics/caption work.
category: creation
---

# stage-compose

How to author an Orkas HTML composition and turn it into a video. Host-neutral: this skill describes the artifact you produce and the outcome you want (a rendered mp4). In Orkas, composition lint/inspect/draft/render runs through the built-in `video_studio` tool. Compatibility is enforced before install by the marketplace `min_app_version` field on the agent/skill.

For visual direction, apply `frontend-design` before writing `manifest.art_direction`. If the user provides a reference image, reference video, DESIGN.md, brand guide, screenshot, design notes, or explicit named style, apply `design-system-importer` to convert it into intent-bound VideoStudio media constraints and compact tokens. `composition-design-review` is an advisory visual checklist you apply yourself to snapshot evidence before showing a preview; nothing is submitted to the host and no gate depends on it. It must not replace native draft QA or create an open-ended redesign loop.

COMPOSE gate stops and authorization transitions are host protocol owned only by `gate-control`. This skill supplies the manifest, contact sheet, draft, QA evidence, and production readiness state; pass those facts to `gate-control` and obey its returned stop or operation instead of restating field ids or approval ordering here.

## No-runtime advisory package

When production tools cannot run in this transport, return the complete unexecuted candidate package without advancing state, fabricating approval, or claiming a rendered artifact — and do not stop at routing either. `gate-control`'s no-runtime branch owns the package's protocol, and
`references/no-runtime-package.md` holds what COMPOSE adds to it. Read that
file only when the runtime is actually unavailable; the ordinary path never
needs it.

Visual QA repair is an evidence-driven workflow, not a rigid state machine or
general redesign prompt. Recorded facts identify completed work and current
dependencies, while the model chooses the next repair from the actual evidence.
Only final delivery has a strict quality boundary; intermediate failures must
remain editable and recoverable. `gate-control` alone owns any user
authorization transition:

Every QA failure or recovery handoff must carry the current reviewable
artifact package, not only a reason or status: name/link the returned
`current_candidate`, contact sheet or sampled frames, failed draft when one
exists, and `findings_path`/inline findings. Label the package as current but
unapproved, then state the bounded repair and next cheap check. Omit a field
that was not returned rather than inventing it. A blocker message that hides
available artifacts is incomplete. Treat
`review_package.presentation_required:true` as a response contract: show its
`primary_artifact`, summarize its `conclusion`, use the other paths as
supporting evidence. If no media exists yet, show the returned script,
manifest, or authored HTML so the user can still judge the work. Ask the user
only for a genuine creative/cost decision, and derive two or three concrete
options from the visible artifact and findings instead of asking a context-free "how should I proceed?" question.

Do not expose native error identifiers such as `E_GATE_B_*`, "Gate B", repair
budgets, signatures, or schema terminology in normal user-facing prose. In Chinese output use "生成旁白音频", "将旁白音频加入视频", and "旁白音频生成失败"; never use "旁白物化". In any UI language, translate
`composition.materialize_narration` as generating or adding narration audio
rather than "materialize". Translate every result into three compact parts in
the user's UI language: **what happened** (which artifact or field needs
work), **what remains safe** (their confirmation and preserved artifacts), and
**what happens next** (the concrete repair plus the next check). An "approval
validation" artifact error is not a bad user confirmation: use the returned
`artifact_issues` to distinguish a missing file from invalid JSON or an
invalid manifest field. When
`review_package.conclusion.automatic_recovery_expected:true`, do not end the
turn after promising recovery — read the named artifacts, repair only
structure that preserves the confirmed meaning, and retry the returned
operation in the same turn. Ask again only if that repair would change the
approved script, duration, delivery contract, or other creative intent.

The top-level continuation fields take precedence over a prose error message.
`next_step_owner:agent` plus `execution.continue_in_current_turn:true` means the
result is nonterminal: execute the named file mutation, retry the validator,
and continue production. Do not merely tell the user what the model should do.
`next_step_owner:user` requires the current artifact and two or three concrete
form choices in the same response. `next_step_owner:external` stops safely at
the preserved artifact without claiming that automatic recovery is underway.

- **Fatal inspect blocker:** repair the reported runtime/structural contract and rerun `composition.inspect`. Until the fatal count is zero, do not call snapshot or draft, and do not present the keyframe preview.
- **Visual review required:** when inspect returns `ok:true`, `visual_review_required:true`, and `preview_capture_allowed:true`, call `composition.snapshot` before editing so the user and the repair loop receive contact-sheet evidence. High-confidence visual blockers may produce frames but cannot reach the keyframe preview stop or advance to draft; advisories continue normally.
- **Passing snapshot, before showing the preview:** inspect every returned `frame_paths` item in one pass, not only the contact sheet or one representative scene. Batch all concrete visible blockers into one verdict. Repair only the affected scenes, then rerun inspect + snapshot; do not show, draft, or approve the stale preview. Other scenes and the approved direction remain frozen.
- **Snapshot semantic failure:** keep returned `current_candidate`, `preview_qa`, and `frame_evidence` visible as unapproved; change the implicated frame/scene signature, then rerun inspect + snapshot. Never retry unchanged input or treat failed evidence as review-ready. While passes remain, choose a materially different repair from the evidence; once exhausted, stop editing that turn.
- **Exhausted visual QA cycle:** show current evidence/findings and let the user choose from the returned options — redirect, simplify, waive the named check, or another materially different attempt — then end. Never start another internal cycle as the silent default. A later real reply grants the next cycle; the host opens it before that turn's first native call. No recovery operation exists.

Each QA repair step has one next operation and one bounded repair target. A later passing snapshot may open the preview gate; prohibitions above apply while the reported blocker or stale signature still exists.

**A retime moves every scene window — re-time the motion inside them.** When `composition.materialize_narration` returns `scaffold_retimed:true`, read its `scene_retiming` entries: each shifted scene's tweens must move to the new window. An entrance still positioned at its pre-retime time leaves that scene blank at the frame QA samples, which reports as a blank/scene-not-visible finding rather than as the stale tween it is. Fix the choreography before rerunning inspect/snapshot; a silent scene keeps a real designed duration, so do not treat a shortened window as permission to drop its beat.

**A passing snapshot ends the turn — until the current visual identity's go-ahead.** Present the complete frame set with exact paths plus one line inviting changes, and stop — do not call `composition.draft` in the same turn; the host refuses it and no wording gets past that. Writing the stop yourself is the only way the user gets a message they can act on. Render on the next turn, after their reply. A recapture of identical visual bytes inherits that reply. A change to visible copy, layout, assets, scene windows, or motion creates a new visual identity, so show the changed complete frame set once before rendering it. Narration/audio-only work inherits the prior preview when the scene windows and pixels remain unchanged. `gate-control` owns the wording of that stop.

## Post-gate authorization and revisions

`gate-control` is the single canonical authorization and state-transition policy for Gate B, Preview, Gate D, signed amendments, and exhausted visual-QA recovery. On every gate submission or post-gate edit, read that compact skill and run its bundled resolver before calling a production tool or emitting another form. This skill owns COMPOSE artifacts and QA craft; it does not redefine gate authorization.

For COMPOSE scope classification, styling-only changes to HTML/CSS/SVG/layout/motion/palette/assets stay `visual_only`. Changes to signed delivery fields, approved copy, narration, timing, language, source mappings, semantic roles, or narration intent are `gate_b_payload`. When uncertain, inspect the requested files and resolve scope without asking a technical confirmation.

For a `visual_only` change after a draft or final already exists, the source edit stays localized but the encoded artifact does not: re-capture and show the changed complete frame set, end that preview turn, then on the user's reply `composition.draft` re-encodes the complete composition as one mp4. A later approved `composition.export` re-encodes that same complete composition at delivery quality. The changed draft re-opens the final video confirmation. Never describe export as the only final encode, imply that only the changed scene can be encoded, or skip the new whole-composition draft and its QA/confirmation.

After the resolver authorizes a normal revision, edit only the bounded files and follow its returned reconcile/QA operation. This skill never infers recovery authority or substitutes a different transition.

## Fast COMPOSE runbook

Before Gate B, make the candidate plan internally executable; after approval, keep the production turn narrow:

1. Read the currently installed copy of this skill once per conversation; re-read it only when the runtime announces an updated installation, not on every resumed turn — the copy already in session history stays authoritative until then. Then read `project/composition/composition-manifest.json` if one already exists. Also read `frontend-design`; read `design-system-importer` only when a concrete style source or explicit named reference exists. Read `composition-design-review` after a successful snapshot, as the checklist for your own frame pass.
2. **Stop for the direction before writing anything.** End that turn with two or three genuinely different concepts for this brief plus the locked facts, and let the user pick — `gate-control` owns the wording. Nothing below happens until they reply: authoring a manifest, a narration line, or an art direction against an unchosen direction is work that gets thrown away, and on 2026-08-07 a run spent eleven minutes doing exactly that before the user saw anything.

3. **The plan is one file**: the canonical `project/composition/composition-manifest.json`. Duration, language, audio ownership, scene windows, approved copy and the words each scene speaks all live there. There is no shotlist and no separate script: a second file restating any of it only creates two copies to reconcile, and reconciling copies is what produced `shotlist.shots.missing` and `script.narration_missing`. The approval result returns `plan_script` — the same plan rendered as readable prose — so show that at the confirmation instead of writing a script file. Declare captions with `composition.caption_mode` when the delivery has them; absent means none. For narration, first call `video_studio` with `op:"speech.capabilities"`, choose only one returned `route_ref` + `voice_ref` whose native or verified supported locale matches `video_language`, and copy its `display_name` with the exact BCP-47 `language` and a natural `speed` into the manifest—never use a candidate non-native language and never invent or recall a provider voice id. Before showing Gate B, write the candidate schema-version 2 source of truth `project/composition/composition-manifest.json`. It owns canvas, immutable target duration, fps, video language, scene windows, complete approved `source_shots` mappings, semantic roles, the narration intent, audio ownership, and `art_direction`. For standalone narrated work, put the complete candidate words in each scene's `narration_text` and keep pre-production audio at `owner:"none"`, `tracks:[]`, plus the selected `narration_intent`. For visual-only/SFX-only COMPOSE, keep `narration_text` empty and say at the gate that no voiceover will be generated. Do not create an audio file or a second structural contract yet.
4. For standalone narration, run the free `composition.check_narration_fit` against that candidate manifest before opening Gate B. Open Gate B only when it returns `gate_b_ready:true`. Only `over` withholds it: revise the affected scenes' `narration_text` to the returned `suggested_units`, then run the free check again without asking the user. `under` means narration finishes before the clip does, which is an accepted delivery — carry it into Gate B as planned and pad it only when the trailing silence is not the edit you intended. After a measured TTS mismatch, the check automatically uses the persisted voice/speed calibration; never let a later generic estimate reverse that measured recommendation. This is an internal timing repair, not a new creative gate: when the free check returns `approval_inherited:true` and `gate_b_required:false`, the native state has carried the existing Gate B approval to the bounded revision, archived stale audio, and returned to `manifest_ready`; call `composition.prepare` and continue without showing Gate B again. If it returns `repair_authorization_status:"rejected"`, only then treat the change as a new plan requiring Gate B. After two non-converging free checks, stop repeating the same wording strategy, diagnose the measured difference, make a materially different timing-focused edit within the authorized scope, and recheck. Never open Gate B or send another speech request merely because the prior timing edits did not converge.
5. On every new/resumed production turn, call canonical `composition.status`; if files and recorded evidence disagree, pass that evidence through `gate-control` and follow the returned recovery. Gate B identity is the normalized approved-intent hash, not the raw hash of `composition-manifest.json`: raw script/manifest hashes remain artifact and concurrency evidence, while implementation-only `art_direction`, formatting, HTML, CSS, SVG, and motion edits create a new candidate without reopening Gate B. Only a changed approved-intent hash is a plan amendment. Once the plan signature is current, run canonical `composition.doctor` before any paid operation and fix missing required capabilities, then call `composition.prepare`. `doctor` reports this MACHINE's capabilities (bundled ffmpeg, speech runtime); its answer cannot change because a plan was re-signed or a file was edited, so run it once per turn and never repeat it after an amendment or a QA repair. `stage` and `next_allowed_ops` are compatibility hints, not an operation whitelist; native operations enforce their own current-fact preconditions. If standalone narration is needed, call `composition.materialize_narration` after prepare and before presenting a complete draft or final delivery — the Narration / audio track section below owns what that operation does, what it preserves, and how its failures are handled.

6. Model-author the visual content, CSS, SVG, and deterministic tweens inside the prepared scaffold, following `frontend-design`'s discipline and the `art_direction` you already wrote: confirm the visual identity, cover, any `reference_fidelity` contract and `VisualDirectionV1`, author each scene's resolved frame first, then add GSAP entrances into that layout. The HTML visual quality floor below states the render-contract rules this step must satisfy. An incomplete visual snapshot may be produced and revised while narration recovery is pending — visual work, lint, inspect, snapshot and preview revision all continue; keep the candidate explicitly incomplete. Required narration blocks only a complete draft/final delivery, not inspection or editing. Keep each scene's tweens inside its scaffold `// ORKAS-SCENE-MOTION-BEGIN:<scene-id>` … `END` block and target only elements inside that scene's own section. This is attribution, not a gate: code outside the blocks or cross-scene targets still render and pass QA, but they mark the composition non-attributable, so unchanged scenes lose incremental-render reuse and every visual edit re-renders the full video.

   Then run `composition.inspect`. If it reports blocking design-contract errors, repair every one of them in one message — they are independent findings, and fixing them one per message spends a full round trip each — starting from the manifest art direction, then rerun inspect once before snapshot or draft. A failed inspect can still carry layout evidence: when it returns `runtime_probe_ran:true` the page was measured despite the block, so repair those findings in the same pass instead of waiting for the next cycle. Advisory (`warning`) findings are read and judged, never repaired in a loop — taste checks such as casing style, cover composition, thesis specificity and reference ambition report without blocking, so weigh them against the frames and move on. Only `error` findings stop the line. Retry only after the canonical manifest or HTML signature changes; at most two distinct repair passes across the shared inspect/snapshot cycle, and advisory or duplicated findings do not consume one. `E_INSPECT_RETRY_NO_CHANGE` blocks only the unchanged probe; `E_INSPECT_ALREADY_PASSED` means follow the prior next action. A non-converging cycle follows the exhausted-cycle rule above. Never install dependencies or start a browser, HTTP server, watcher, Puppeteer, Playwright, or headless Chrome for QA — native `video_studio` operations own that runtime — and never recreate root timing, media playback, vendor setup, or timeline registration with ad-hoc code. QA repair is internal work and never creates a technical user gate.

   Treat each returned `current_candidate.revision_id` as an immutable content snapshot: edits create a new candidate instead of overwriting the meaning of a previous preview or approval. Canonical files resolve from their recorded path-and-hash facts, so the private content-addressed snapshot path is storage evidence, not an edit target. A failed inspect, snapshot, or draft still returns the current candidate — present its contact sheet, frame, draft, or findings as "current version, not yet approved" and continue repair. On repeated user revisions preserve the complete accepted delta chain: if revision 2 shortened scene 2 and revision 3 changes scene 5, revision 3 carries both. After every changed signature rerun inspect/snapshot over the whole composition, review the newly attached complete contact sheet and only its QA-named or visibly risky `frame_paths`, and publish only the current candidate's locators — never an earlier contact sheet, and never `first_frame` as if it were the whole preview.

7. Open the HTML Preview Gate before rendering when target duration >= 20s or scene count >= 3; the native tool enforces this so short multi-scene work cannot pass only structural QA. Also use it for shorter work when render rework is likely expensive because of dense text, complex SVG/GSAP, many branded/supplied assets, or a prior draft failure. Skip it only for genuinely short/simple work: target duration < 20s, scene count <= 2, no narration/timing complexity, and no obvious visual-risk signal.
8. If HTML preview evidence is required, run `composition.inspect` and `composition.snapshot` to `project/composition/preview/first-frame.png`. Snapshot runs the same fail-closed preflight first, captures at least one semantic midpoint for every scene plus hook/payoff evidence, and returns distinct `first_frame`, raster `contact_sheet`, and `frame_paths` fields. The published contact sheet must contain every recorded frame in one visible image; `first_frame` is compatibility/cover evidence and must never be presented as if it were the complete preview. Before handing readiness to `gate-control`, read `composition-design-review` and run your own frame pass economically: read the contact sheet as the complete index, then open at full scale only the frame-0 cover, every frame a QA finding names, and frames whose sheet cell shows risk (dense or doubtful text, suspected overlap or blankness); compare concrete references side-by-side when `reference_fidelity` exists. Reading every frame file individually costs minutes per pass and repeats what deterministic QA already sampled — drill in where evidence points, not everywhere. The review is advisory: nothing is submitted to the host, and the host publishes the contact sheet with the passing snapshot. Collect all visible blockers across all frames before editing, make one batched localized repair, then rerun inspect/snapshot and re-check the complete new frame set; when the frames read well, the preview review is already open. On native failure, use `preview_qa`, `frame_evidence`, or `findings_path`; never retry the same signature. Pass the final readiness/error result and any later user decision to `gate-control`, then perform only its returned edit, reconcile, QA, or production operation.
9. Run `composition.draft`. The production path reuses the canonical manifest, fail-closed preflight, runtime seek probe, render, audio/media QA, semantic sampled-frame QA, and one report. Structural errors never spend a full-render attempt.
10. If draft fails, repair the highest structural source (`composition-manifest.json` first, then its art direction/mapped content, then visual HTML). Do not repeat a draft for the same input signature; use the returned evidence, make a materially different canonical edit, run cheap checks, and retry after the signature changes. Internal retry limits never create a user confirmation.
11. After draft, keep native render-specific QA—encoding, media duration, audio stream/loudness, semantic frame coverage, blank/frozen frames, and timing. Do not repeat static layout review after rendering; proceed when `gate_d_ready:true`. A successful draft is not terminal: keep the production step in progress and never close with only the draft link. When `gate_d_ready:true`, freeze the manifest, HTML, assets, and narration; show the existing draft mp4 plus the QA headline and pass that readiness state to `gate-control` so it opens Final video confirmation.

The default path is **direction stop -> candidate manifest -> free calibrated narration fit -> one Gate B -> artifact signature -> doctor -> native scaffold -> recoverable narration materialization (when needed) -> VisualDirectionV1 and visual identity check -> resolved-frame HTML authoring -> GSAP motion into those layouts -> per-scene preview/draft evidence**. `VideoProductionStateV1` is the durable domain-state source for this sequence; Agent plan/completed-work state stores its state reference/revision and must call status/reconcile rather than inventing or skipping a VideoStudio stage. Do not write or compile `spec.json`; fixed visual templates are not part of the COMPOSE path because visual quality and extensibility still belong to the model.

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
the native approval is current. It reruns render, media and frame QA at high
quality, writes the frame-0 cover beside the video as `<video-name>-cover.png`,
and returns `next_action:"deliver_final"`; the final response must include the
video and mention the cover, or a clear blocker. Call it once and let the host
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
economical frame pass from step 7, repair all blockers together, and rerun
inspect + snapshot — a changed snapshot requires re-checking its full new frame
set. When the frames read well, hand `gate-control` the published contact
sheet, the `index.html` path, and a compact readiness note: why preview applied
(duration / scene count / complexity / prior failure), the inspect headline,
and what approval means (render the mp4 draft next). Then obey the transition
it returns. Keep preview revisions lightweight; do not synthesize new narration or render mp4 while the preview artifact is still under review.

Use `update_visual_baseline:true` only when the user or an explicit project
workflow promotes an approved preview to a golden baseline; later snapshots
compare matching frames and report changes as advisories, never as an automatic
rerender loop.

The preview does not replace the mp4 draft — it cannot validate audio muxing,
final encoded quality, sampled-frame video QA, or exact narration pacing. After
approval, always run `composition.draft` and open Gate D with the video.

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

Every scene needs canonical numeric `start` and `duration`; do not invent `start_s`/`duration_s`. Use `source_shots` to name the approved beat each scene renders and `narration_text`/`narration_refs` for voice alignment. Those ids are canonical — with no shotlist to alias them, a `source_shots` change is a change of approved intent and reopens the plan confirmation. Use audio owner `assembler` for AUTO segments that must render silent.

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
- **Timing**: position every tween on the generated paused GSAP timeline from the scaffold's `S("<scene-id>")`, never a literal second (see the render contract below); manifest duration is final.
- **SVG-first visual layer**: prefer inline SVG for non-text motion graphics such as diagrams, connectors, nodes, progress paths, charts, orbit lines, icon-like marks, and background geometry. Keep readable prose in normal HTML text boxes unless the SVG text is large, simple, and verified.
- **Use GSAP only when time-based motion is needed**: static SVG, CSS layout, and simple held states do not need GSAP. When animation is needed, keep GSAP as the timeline/orchestration layer that animates SVG groups or a small set of HTML containers. Do not build dozens of absolutely positioned HTML nodes/cards/lines when one SVG graph can carry the visual.
- **No remote runtime resources**: `index.html` must not load CDN scripts, remote fonts, remote images, or remote CSS during render. Fetch or copy required runtime files into `project/composition/assets/` during authoring, then reference them with relative paths such as `./assets/vendor/gsap.min.js`. Draft QA blocks `http://` and `https://` references.
- **Local GSAP vendor**: the native path prepares the built-in offline vendor referenced by the scaffold. Do not manually patch `assets/vendor/gsap.min.js`.

## HTML visual quality floor

The common failure mode is technically valid HTML that looks like a low-effort
web mockup. `frontend-design` owns the cure — scene grammar, depth, type
register, anti-template defaults — and you have already written it into
`art_direction`. Author from that contract. Four rules belong to the render
contract itself and are enforced here:

- **Every composition must render something at t=0** — each AUTO segment too,
  not just the cover. Native QA samples frame 0 of every composition it checks,
  so a scene tweened from `opacity: 0` or opened with a fade-in captures blank
  and returns `EMPTY_HOOK_FRAME` plus `EXPECTED_SCENE_NOT_VISIBLE`. In an
  assembled video a blank first frame is also a visible gap at the cut. Author
  the resolved frame first and animate FROM a visible state — the scene AND the
  elements carrying its cover: a container that renders while its
  `data-role="title"` starts at `opacity: 0` returns
  `HOOK_PROMISE_NOT_VISIBLE`. A deliberate fade-from-black opening is the one
  exception and needs the user to have asked for it.
- **Frame 0 of the delivered opening is a dedicated cover**: one approved
  headline, one dominant hero, and at least two concrete signals of what the
  viewer will learn. Put `data-role="visual" data-cover-hero` on the
  topic-specific dominant group and render at least two `content_signals` as
  visible frame-0 copy (`data-cover-signal="<value>"` when the element carries
  no readable text of its own). A signal that only restates the headline is not
  a second signal.
- **Give QA its hooks**: `data-scene-id` on scene clips and
  `data-role="title|body|label|caption|visual"` on major text/visual groups.
  Keep readable text as real HTML text, not baked into images.
- **Never write a timeline position as a literal second.** Scene visibility is
  runtime-owned — leave it alone — and position every tween you author from the
  scaffold helpers `S("<scene-id>")`/`D("<scene-id>")`, which read that
  section's `data-start`/`data-duration`. The narration audio is measured after
  you author, a retry can reach that step on an already-authored file, and
  every scene window shifts then, so a literal plays against the wrong scene.
  `inspect` returns `AUTHORED_ABSOLUTE_TIMELINE_SECONDS` with the line and the
  `S()` expression that replaces it.

Native QA blocks semantic readability failures: small text, unsafe text,
overflow, overlap, occlusion, clipping, low contrast. Thin art direction,
repeated layout grammar, one-note palettes, and decorative complexity remain
advisories unless they break a concrete approved promise in a specific frame.

## Manifest art direction before HTML

Before styling the generated scaffold, write `art_direction` inside `project/composition/composition-manifest.json`. It is an internal visual contract, not a user gate and not a second structural artifact.

`frontend-design` owns this contract's field list and the pre-code anti-template check that must run before any HTML is written — name the first generic design move you rejected and the brief-specific replacement; if you cannot name that replacement, the contract is not ready. It catches the lazy defaults before HTML: purple/blue neon, glowing black-background circles, centered equal-weight layouts, identical cards, decorative emoji/icons, tiny badges, web-dashboard fragments, pure black/white, and web-scale type. When `style_source` exists, also name what was adapted, simplified, and not copied. Its field list — `aesthetic`,
`visual_direction` (VisualDirectionV1), `cover`, `typography_tokens`, `anti_template_check` (legacy `anti_template` is still accepted by native QA, but new manifests write the longer name),
`color_tokens`, per-scene `depth_layers`/`motion_verbs`, and the rest — is
written from that skill, not from a second copy here. Two additions this line
owns:

- `style_source`: from `design-system-importer` when a DESIGN.md, brand guide,
  screenshot, reference site, Figma notes, existing app UI, or explicit named
  style was used. Omit when there is no external style source.
- `references` + `reference_fidelity`: required for every concrete reference image or video. Declare each item's `media_type`, reproduce/edit/guide `intent`, user/inferred `intent_basis`, roles, composition-local `path`, required state, `preserve`/`may_change`, and target scenes; explicit user requirements override defaults, and an unspecified reference defaults to `intent:guide,intent_basis:inferred`. Composition/structure roles need normalized `layout_anchors`; video reproduce/edit/motion/timing roles need source-time-to-target-scene `temporal_anchors`. Declare `mode:exact|close|adapt` and `verification.minimum_score`; exact mode preserves at least three axes with a score floor of at least 85.

## Video language vs chat language

Keep two language concepts separate:

- **User UI language** comes from system context. Use it for chat replies, gate summaries, status text, form labels, and any explanation addressed to the user.
- **Video language** comes from the VideoStudio `language` input and `manifest.composition.language`. It is the primary language for the deliverable: Gate B script and manifest content, `approved_copy`, `narration_text`, captions, titles, subtitles, CTAs, and visible HTML text.

Use the video language locked at the plan confirmation under `gate-control`; do not infer a second default in this line skill. After the plan confirmation locks video language, do not introduce bilingual copy unless the user explicitly requested it or approved it with the production plan. Proper nouns, product/model/API names, code identifiers, and non-approved decorative texture text may remain in their original language. If the user deliberately selects English in a Chinese UI, explain the plan in Chinese while making the video copy English. If the selected video language is Chinese, do not add unapproved decorative English HUD slogans merely to create a tech mood.


The unified preflight enforces the manifest, scaffold, and art direction before snapshot or rendering. It blocks when `composition-manifest.json` is missing, unversioned, invalid, overlapping, or incomplete; when `manifest.art_direction` lacks the preview-required aesthetic thesis, dedicated cover contract, `VisualDirectionV1`, motion budget, scene variation budget, per-scene depth layers, or per-scene motion verbs; when a concrete reference lacks a local executable fidelity contract, its source asset is missing, or an exact reference declares an inadequate preservation floor; when root/scene/audio attributes differ from the canonical manifest; when scene timing falls outside the composition duration or overlaps unintentionally; when declared scene headline/title/on-screen copy is missing from `index.html`; when HTML references a missing local asset, an absolute path, an asset outside the composition directory, or a remote runtime URL; or when HTML calls `gsap.*` without the generated local vendor and paused registered timeline, or controls media imperatively. It warns without blocking when scenes repeat the same layout grammar or the palette is one-note.

Preserve approved English casing: sentence/natural title case for titles and
sentence case for body, captions, subtitles, and CTAs. Existing all caps may
remain only when that exact casing appears in approved user copy or an
external brand/source, and then only for one short metadata label, acronym, or
code. A model-authored art direction, design tradition, typography register, or generic tech/editorial mood never authorizes converting copy to all caps; never use a broad `text-transform: uppercase` rule.

Typography and layout budgets bind every readable element, including badges,
pills, labels, captions, cards, nodes, and microcopy. Do not put long labels in
circles or small decorative nodes. If approved copy cannot fit safely, shorten
on-screen text without changing meaning; ask the user only when the message
would change.

## Inspect and repair policy

The draft repair budget mirrors the inspect/snapshot one: after a failing
draft, repair once and re-run; a second pass only when the remaining blockers
are fewer and clearly localized. `E_REPAIR_BUDGET_EXCEEDED` does not mean stop
working — read the last error and evidence, make a materially different
localized edit, run the cheap checks, and retry once the input signature
changes. It blocks another draft for the same signature only, never editing,
reconciliation, lint, inspect, or a later draft. Regenerating `index.html`
counts as one strategy; do it only for a structural failure. If only visual
advisories remain and draft returned `ok: true`, present the mp4 with QA notes
instead of looping. This is internal non-billable recovery and creates no user
form.

Repair the cause, not the symptom:
- `FONT_TOO_SMALL`: reduce text density, shorten copy, enlarge/reflow
  containers, or move labels out of small shapes — do not simply scale every
  font up and create overflow.
- `missing_timeline_registry`, `gsap_timeline_not_registered`: register a
  paused GSAP timeline on `window.__timelines[compositionId]` using the exact
  root `data-composition-id`.
- `timed_element_missing_clip_class`, `root_composition_missing_data_start`,
  `media_missing_data_start`, `imperative_media_control`: let the renderer own
  timing and playback through `data-start`, `data-duration`, `.clip`, and
  media data attributes — never custom `play()`/`pause()`/`currentTime`,
  timers, or a `seekTo` API.
- `text_occluded`, `text_box_overflow`, `content_overlap`: restructure the
  scene layout or regenerate that scene from the contract's boxes; numeric
  nudges do not fix it.
- `STATIC_FRAME_RUN`: fix timeline registration, clip timing, or scene
  variation; never deliver a draft whose sampled frames repeat across scenes.

Repair `composition-manifest.json`, its art direction, mapped content, or
visual HTML directly; never introduce `spec.json` as a workaround.

## Narration / audio track

**Decide ownership first.** A standalone COMPOSE deliverable owns its voice:
plan with `audio.owner:"none"`, then let `composition.materialize_narration`
change the validated manifest to `audio.owner:"composition"` and write the
`<audio>` element the renderer muxes. A composition that is a SEGMENT of an
AUTO production renders **SILENT** — no narration track — because the
assembler mixes the one narration in its own tier; baking it here too gives
the finished video two overlapping drifting voices, and the mix step refuses a
non-silent base (`E_EDIT_BASE_HAS_AUDIO`) to catch exactly that. Use
`audio.owner:"assembler"` whenever such a segment carries `narration_text`,
and `"none"` only when it has no narration at all.

A narration failure blocks narration and complete delivery only — never visual evidence or internal repair. Do not terminate with a narration form while visual evidence is still missing: preserve the transaction, keep authoring, lint, inspect and snapshot, deliver the current incomplete candidate, then surface the narrowly scoped retry decision.

When this composition does speak, read
`references/narration.md` before calling
`composition.materialize_narration`: it owns the approved-words rule, the
track shape, the measured-duration and retiming behavior, the music and
talking-head caveats, and what a failed materialization means.

## Render (the outcome)

Produce the finished video from the composition **directory**. Iterate with `composition.draft`; when `gate-control` returns an export transition for the frozen draft, run the single high-quality `composition.export` pass. Draft and export use the same canonical manifest, preflight, source, inspect, audio, media, and semantic video QA. Raw render-only operations are not exposed to the agent.

## Director judgment (compose line)

`video-craft` owns the shared craft. These are the calls specific to designed
and animated explainers:

- **One concept per visual chapter** — don't stack two ideas in one scene.
- **Concrete before abstract** — real data, diagrams, steps before a metaphor.
- **Aesthetic thesis before styling** — pick one signature device from the
  subject matter (`frontend-design`) and spend distinctiveness there.
- **Render exact text as real text** — stats, names, CTAs are typed into the
  composition, never baked into AI imagery, which hallucinates numbers and
  cannot be corrected.
- **Build to the narration words**, not arbitrary beats; hold a fully-built
  scene or chart 2–3s before moving on.
- **Vary scene types** — no three near-identical layouts in a row.
- **Ordinary subtitles are caption-track data, not burned into this
  composition**: the assembler burns them at the end, so a later typo fix is a
  one-line edit instead of a whole re-render. Only a purely decorative caption
  treatment that IS the visual design (kinetic highlight sweeps, word-by-word
  reveals) may live inside the composition — and when it does, tell the user
  that styled caption is part of the picture and not separately editable.

## Constraints

- Deterministic only: no real-time timers, no network-dependent runtime behavior, no randomness without a fixed seed — the renderer seeks discrete frames.
- Keep all referenced assets inside the composition directory so the render is self-contained.
- This skill authors and renders compositions; it does not pick the production line (see the routing skill) or generate AI footage.
