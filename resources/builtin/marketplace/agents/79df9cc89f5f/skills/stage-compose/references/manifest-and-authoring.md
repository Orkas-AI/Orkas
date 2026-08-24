<!-- stage-compose reference. Read this before authoring or materially editing
composition-manifest.json, the prepared scaffold, or visual HTML/CSS/SVG. -->

# Manifest and composition authoring

## Canonical composition manifest

Write `project/composition/composition-manifest.json` before
`composition.prepare`. It is the only structural source of truth; never
duplicate canvas, duration, scenes, or audio ownership in another contract.

It owns canvas, immutable target duration, fps, video language, scene windows,
complete approved `source_shots`, semantic roles, narration intent, audio
ownership, and `art_direction`. Declare captions with
`composition.caption_mode`; absent means none. Standalone narrated work stores
complete candidate words in each `narration_text` and pre-production audio as
`owner:"none"`, `tracks:[]`, plus selected `narration_intent`. Visual/SFX-only
work keeps narration empty and says at plan review that no voiceover is made.

```json
{
  "schema_version": 2,
  "composition": {
    "id": "main", "width": 1920, "height": 1080,
    "duration": 60, "target_duration": 60, "fps": 30, "language": "en"
  },
  "scenes": [{
    "id": "hook", "start": 0, "duration": 5,
    "approved_copy": ["Orkas 1.5.0"],
    "narration_text": "A concise line for this exact window.",
    "narration_refs": ["n01"], "source_shots": ["s01"],
    "roles": ["title", "visual"]
  }],
  "audio": {
    "owner": "none", "tracks": [],
    "narration_intent": {
      "route_ref": "managed:orkas-voice",
      "voice_ref": "<copy exactly from speech.capabilities>",
      "display_name": "Vivi", "language": "zh-CN", "speed": 1
    }
  }
}
```

This is planned pre-production form. Plan approval signs `narration_intent`;
`composition.materialize_narration` reads it without execution-time overrides,
changes owner to `composition`, writes the track, preserves intent, and replaces
estimated with measured timing. Schema version 1 is legacy recovery only.

Every scene uses numeric `start` and `duration`, never `start_s`/`duration_s`.
`source_shots` names approved beats and narration fields align voice. With no
shotlist alias, a `source_shots` change alters approved intent. AUTO segment
audio owner is `assembler` when it carries narration and must render silent.

Materialization creates `project/composition/narration-map.json`. For external
narration only, provide a compatible map before draft:

```json
{"lines":[{"id":"n01","scene_id":"hook","start":0,"end":3.2,"text":"Meet Orkas 1.5.0."}]}
```

Use matching `narration_ref`; timed media refs are valid when the map line has
matching scene or time. Without a map, every narrated scene needs inline
narration plus numeric timing or draft QA blocks final review.

## Native scaffold

`composition.prepare` derives root canvas/timing, scene clips, semantic ids,
declarative audio, local GSAP vendor, paused master timeline, and registration.
Do not hand-create or replace protected fields. After authoring, use
`composition.reconcile` to update only protected root/clip/audio metadata while
preserving DOM/CSS/SVG; deliberately update custom tween timing after retime.

Author visual DOM inside generated scene roots and motion on
`window.__ORKAS_COMPOSITION_TIMELINE__`. Never call media `play`, `pause`, set
`currentTime`, or create a wall-clock/unregistered timeline.

## Authoring patterns

- Canvas: manifest declares 16:9 = 1920×1080, 9:16 = 1080×1920, or 1:1 =
  1080×1080 once; scaffold mirrors it.
- Scenes: one canonical window per beat; do not retime clip attributes separately.
- Text: safe padding, large contrast, one idea per scene.
- Assets: relative paths inside composition dir, e.g. `./assets/shot1.png`.
- Timing: every tween begins from scaffold `S("<scene-id>")`, never a literal.
- Prefer inline SVG for diagrams, connectors, nodes, charts, paths, icon-like
  marks, and geometry; keep prose in HTML text.
- Use GSAP only for time-based motion and animate SVG groups or a few HTML
  containers; avoid dozens of absolute card/line nodes.
- No CDN scripts, remote fonts/images/CSS, or other remote runtime resources.
  Copy needed assets locally. Native prepares offline GSAP; never patch it.

## Art direction before HTML

Write `art_direction` inside the manifest. It is an internal visual contract,
not another artifact or user gate. `frontend-design` owns its field list and
pre-code anti-template check: name the first generic move rejected and the brief-
specific replacement. Reject lazy defaults such as purple/blue neon, glowing
black circles, centered equal-weight layouts, identical cards, decorative
emoji/icons, tiny badges, dashboard fragments, pure black/white, and web-scale
type. When `style_source` exists, name what was adapted, simplified, and not
copied.

Fields come from `frontend-design`: `aesthetic`, `visual_direction`
(`VisualDirectionV1`), `cover`, `typography_tokens`, `anti_template_check`,
`color_tokens`, and per-scene `depth_layers`/`motion_verbs`. This line adds:

- `style_source` from `design-system-importer` for a concrete external source;
  omit when none.
- `references` + `reference_fidelity` for every concrete reference image/video
  and only then. Unspecified reference defaults to
  `intent:guide,intent_basis:inferred`.

## Video language and copy

User UI language controls chat, review summaries, and explanations. Video
language comes from VideoStudio input and `manifest.composition.language`; it
controls plan/script, approved copy, narration, captions, titles, subtitles,
CTAs, and visible HTML. Use the language locked by `gate-control`, do not infer a
second default, and do not add unapproved bilingual or decorative English copy.
Proper nouns, product/API names, code, and approved source text may remain.

Preserve approved English casing: natural title/sentence case. Existing all caps
may remain only when exact approved/source casing, and only for a short label,
acronym, or code. Never use broad `text-transform:uppercase` for model-authored
mood. Typography/layout budgets bind badges, pills, labels, captions, cards,
nodes, and microcopy. Shorten safely without changing meaning; ask only if
meaning would change.

## Unified preflight

Preflight blocks missing/invalid/overlapping manifest; incomplete art direction,
cover, VisualDirectionV1, motion/variation/depth contracts; missing reference
fidelity/source; root/scene/audio drift; timing outside duration; missing
declared copy; missing/outside/absolute/remote assets; GSAP without local vendor
and registered paused timeline; and imperative media control. Repeated layout
grammar or one-note palette warns without blocking.
