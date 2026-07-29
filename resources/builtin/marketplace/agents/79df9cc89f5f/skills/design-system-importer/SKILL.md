---
ownerAgent: 79df9cc89f5f
name: design-system-importer
description_zh: VideoStudio 的参考媒体与设计系统输入层——统一处理参考图片、参考视频、品牌规范、网站截图和设计说明，按复刻/编辑/借鉴意图写入可执行的画面与时序约束。
description_en: Reference-media and design-system input layer for VideoStudio. Treat reference images, reference videos, screenshots, brand guides, and design notes uniformly, compiling reproduce/edit/guide intent into executable spatial and temporal constraints.
category: creation
---

# design-system-importer

Use this when COMPOSE or an AUTO compose segment has any external reference media or style source: a reference image, reference video, `DESIGN.md`, brand guide, screenshot, existing website, design notes, or an explicit named visual direction.

Do not use it for ordinary editing, TTS, shot generation, or clip selection. Do not introduce a new user Gate. The output is an internal style extraction that feeds `project/composition/composition-manifest.json::art_direction` and the model-authored `project/composition/index.html`.

Do not use it for vague adjectives like "modern", "clean", "premium", "dynamic", or "more polished" when no source is named. In those cases, let `frontend-design` choose the aesthetic thesis directly from the video brief.

## Reference Intent Before Input Technique

For every supplied image or video, first classify what the user wants from it. Explicit user requirements always override defaults; infer only when the user is silent:

- `reproduce`: preserve the declared content, identity, composition, structure, style, motion, timing, or audio axes.
- `edit`: use the media as the original, protect all declared unaffected axes, and change only `may_change`.
- `guide`: borrow only the declared roles and do not imply exact fidelity. This is the safe default for an otherwise unspecified reference.

Record `intent_basis:"user"` for an explicit requirement and `intent_basis:"inferred"` for a fallback. A request to change the supplied original implies edit; an explicit restore/recreate/match request implies reproduce; otherwise default to guide. Mixed instructions keep their operational intent while the user's exact protected and changeable axes remain authoritative. This classification is independent of origin. A screenshot, exported frame, camera photo, generated image, HTML capture, design-tool export, uploaded MP4, or generated video receives the same contract when the requested intent and roles are the same.

Copy every exact inspected media file into `project/composition/assets/references/` before authoring and record that composition-local path. Do not rely on a chat thumbnail, stale temporary path, or prose description after the source has been supplied.

## Source Access Is An Optimization, Not A Different Contract

If the user owns reusable source code, vectors, layers, or assets, use them when that is the safest way to satisfy the same reference contract. If only pixels are available, derive the same spatial/temporal anchors from pixels. Availability of HTML, an ImageStudio project, or another authoring format must not change the requested intent, roles, fidelity floor, or review rubric.

Adapt style; do not copy logos, protected assets, proprietary text, or trademarked UI one-to-one.
Keep extraction small enough to fit inside the manifest art direction. Do not load or recreate an entire external design system.

## Extract Compact Tokens

Write a `style_source` object under `art_direction` in `project/composition/composition-manifest.json`:

```json
{
  "art_direction": {
    "style_source": {
      "source_type": "brand_system | design_notes | reference_media | existing_product | named_reference",
      "source_basis": "file path, user note, or inspected artifact",
      "adaptation_boundary": "what may be borrowed vs what must not be copied",
      "confidence": "high | medium | low",
      "fidelity_mode": "exact | close | adapt"
    }
  }
}
```

Then normalize the source into sibling fields in `manifest.art_direction` that model-authored HTML/CSS/SVG can consume:

- `color_tokens`: background, surface, text, muted, primary accent, optional secondary accent, plus intended contrast relationship.
- `typography_tokens`: display, body, data/label, caption roles; scale and weight intent; avoid relying on fonts that are not available.
- `shape_tokens`: radius, stroke, shadow, divider, border, and density.
- `layout_language`: grid, editorial, cinematic, dashboard, diagrammatic, poster, product-demo, or another concrete grammar.
- `motion_language`: entrance, transition, emphasis, data-build, and exit patterns; keep it compatible with GSAP timeline seeking.
- `asset_rules`: what images/icons/marks are allowed, need replacement, or must be avoided.
- `do_not_copy`: logos, exact layouts, trademarked copy, screenshots, or protected illustrations unless the user owns them.

Keep the imported style small. If more than 6 chromatic colors or 3 font roles are needed, summarize the conflict and pick the smallest faithful subset.

## Write An Executable Media Contract

For every concrete image or video, write `art_direction.references`; then write the shared `art_direction.reference_fidelity` policy:

```json
{
  "references": [{
    "id": "reference-1",
    "media_type": "image | video",
    "path": "assets/references/reference.mp4",
    "intent": "reproduce | edit | guide",
    "roles": ["content", "identity", "composition", "structure", "style", "motion", "timing", "audio"],
    "required": true,
    "preserve": ["subject identity", "camera path", "beat timing"],
    "may_change": ["copy"],
    "target_scene_ids": ["scene-1"],
    "temporal_anchors": [
      { "source_start_sec": 0, "source_end_sec": 3.2, "target_scene_id": "scene-1" }
    ]
  }],
  "reference_fidelity": {
    "mode": "exact | close | adapt",
    "preserve": ["composition", "identity", "motion"],
    "may_change": ["copy", "aspect-safe reflow"],
    "layout_anchors": [{ "id": "hero", "role": "hero", "bounds": { "x": 0.08, "y": 0.12, "width": 0.5, "height": 0.7 } }],
    "verification": { "minimum_score": 85, "compare_frames": ["first-frame", "scene-1-mid"] }
  }
}
```

Choose the mode from user intent, not convenience:

- `exact`: the user asks to reproduce/continue the supplied design. Preserve at least three named axes; minimum score must be at least 85.
- `close`: keep its recognizable system and spatial grammar while adapting content/aspect/motion.
- `adapt`: borrow selected tokens or a visual principle; do not claim pixel fidelity.

Map image composition/structure into normalized layout anchors, not only adjectives. For a video used to reproduce, edit, control motion, or control timing, map source time ranges to target scenes with temporal anchors. The model must be able to answer what stays, what changes, where it appears, and when each preserved beat happens.

## Map To Video

Web and brand systems are not videos. Convert them for motion:

- First frame: choose the style's strongest thumbnail-friendly signal.
- Safe zones: enlarge type and spacing beyond web density.
- Scene variation: turn repeated web sections into distinct beats.
- Motion: make the brand grammar move with purpose; do not animate every component.
- Captions: keep ordinary subtitles in `tracks.captions.lines`, not in the style system.

## Output

After extraction, `manifest.art_direction` must state:

- What source was used.
- Which tokens were adopted.
- Which tokens were deliberately simplified.
- Which elements must not be copied.
- What visual signature will make the video feel related to the reference without becoming a clone.
- Which image/video reference intent and roles, preserve/may-change rules, target scenes, layout/temporal anchors, and scored verification floor apply.
