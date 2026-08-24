<!-- stage-compose reference. Read this only after inspect, snapshot, draft,
or artifact validation enters a failure/recovery branch. -->

# QA and repair detail

## Failure classification

- Fatal inspect blocker: repair runtime/structural contract and rerun inspect.
  Do not snapshot, draft, or present preview before fatal count reaches zero.
- Visual review required: if inspect is structurally successful and capture is
  allowed, snapshot before editing so the repair loop has frame evidence. Visual
  blockers may produce frames but do not reach preview/draft; advisories continue.
- Passing snapshot: inspect the returned frame set as directed by the root,
  batch visible blockers, repair affected scenes, rerun inspect + snapshot, and
  never present/approve stale evidence.
- Snapshot semantic failure: preserve candidate, `preview_qa`, and
  `frame_evidence` as unapproved. Change implicated signature before retry. Use a
  materially different evidence-based repair while passes remain.
- Exhausted visual QA: show current evidence/findings plus returned redirect,
  simplify, waive, or another-attempt choices and end. A later real reply grants
  the next cycle; no restart/recovery operation exists.

Each repair has one bounded target and one next operation. Native passing
snapshot may later open preview; prohibitions persist while blocker/stale
signature remains.

## Artifact-validation recovery

An “approval validation” error is not a bad user confirmation. Use returned
`artifact_issues` to distinguish missing file, invalid JSON, or invalid manifest
field. If `automatic_recovery_expected:true`, do not stop after promising a
repair: read named artifacts, repair only structure preserving confirmed meaning,
retry the returned operation in this turn, and continue. Ask again only if repair
changes approved script, duration, delivery, or creative intent.

Call music, captions, and narration implemented only when both manifest and
rendered artifact contain them. Required narration blocks complete draft/final,
not visual inspection or editing.

## Inspect/snapshot cycle

Repair all independent findings in one pass. A failed inspect may still have
runtime measurements when `runtime_probe_ran:true`; use them now. Advisory
warnings such as casing, cover composition, thesis specificity, or reference
ambition are judged against frames and never loop-repaired. Retry only after
manifest/HTML signature changes, with at most two distinct strategies across the
shared inspect/snapshot cycle. `E_INSPECT_RETRY_NO_CHANGE` blocks only unchanged
probe. A repeated already-passing signature returns cached contact sheet and
preview revision; publish them and do not rerun.

Treat content-addressed snapshots as storage evidence, never edit targets. A
failed inspect/snapshot/draft still returns the candidate; present available
contact sheet/frame/draft/findings as current but unapproved while continuing.
Preserve cumulative user deltas across revisions. After a changed signature,
rerun whole-composition inspect/snapshot; use contact sheet as full index and
drill into QA-named or visibly risky frames.

## Draft repair budget

After failing draft, repair once and rerun; a second pass is allowed only when
remaining blockers are fewer and localized. `E_REPAIR_BUDGET_EXCEEDED` blocks
another draft for the same signature, not editing, reconcile, lint, inspect, or
a later changed-signature draft. Make a materially different localized edit and
cheap checks. Regenerate `index.html` only for structural failure. If only
advisories remain and draft is `ok:true`, present mp4 plus QA notes instead of
looping. This internal non-billable recovery creates no user gate.

## Repair causes, not symptoms

- `FONT_TOO_SMALL`: reduce density, shorten copy, enlarge/reflow, or move labels
  out of small shapes; do not globally scale fonts into overflow.
- `missing_timeline_registry`, `gsap_timeline_not_registered`: register paused
  GSAP on `window.__timelines[compositionId]` using exact root id.
- `timed_element_missing_clip_class`, `root_composition_missing_data_start`,
  `media_missing_data_start`, `imperative_media_control`: renderer owns timing
  through `data-start`, `data-duration`, `.clip`, and media attributes; never
  custom play/pause/currentTime, timers, or `seekTo`.
- `text_occluded`, `text_box_overflow`, `content_overlap`: restructure scene or
  regenerate from contract boxes; numeric nudges are not a fix.
- `STATIC_FRAME_RUN`: fix timeline registration, clip timing, or scene variation;
  never deliver a draft whose sampled scenes repeat.

Repair manifest, art direction, mapped content, or visual HTML directly; never
introduce `spec.json` as workaround.
