---
ownerAgent: 79df9cc89f5f
name: design-system-importer
description_zh: VideoStudio 的设计系统输入层 - 当用户提供 DESIGN.md、品牌规范、参考网站/截图、Figma 导出的设计说明或"做成某某风格"时,把外部风格压缩成 stage-compose 可用的 design-contract/style tokens,避免整包加载风格库。
description_en: Design-system input layer for VideoStudio. Use when a user provides DESIGN.md, brand guidelines, a reference site/screenshot, Figma-exported design notes, or asks for a named style. Convert the style into compact stage-compose design-contract/style tokens without loading a whole design library.
category: creation
---

# design-system-importer

Use this only when COMPOSE or an AUTO compose segment has an external style source: a `DESIGN.md`, brand guide, visual reference, screenshot, existing website, Figma notes, or an explicit user request such as "make it feel like Linear/Stripe/Notion" or "follow this brand".

Do not use it for ordinary editing, TTS, shot generation, or clip selection. Do not introduce a new user Gate. The output is an internal style extraction that feeds `project/composition/design-contract.json` and the hand-authored `project/composition/index.html`.

Do not use it for vague adjectives like "modern", "clean", "premium", "dynamic", or "more polished" when no source is named. In those cases, let `frontend-design` choose the aesthetic thesis directly from the video brief.

## Input Priority

Prefer concrete local material over memory:

1. User-provided `DESIGN.md`, brand guide, or style brief.
2. User-provided screenshot/image/video stills.
3. Existing product/app UI in the workspace.
4. A named public style reference only when the user explicitly names it. If current details matter and the source was not provided, retrieve or ask for it instead of inventing specifics.

Adapt style; do not copy logos, protected assets, proprietary text, or trademarked UI one-to-one.
Keep extraction small enough to fit inside the design contract. Do not load or recreate an entire external design system.

## Extract Compact Tokens

Write a `style_source` object into `project/composition/design-contract.json`:

```json
{
  "style_source": {
    "source_type": "design_md | brand_guide | screenshot | site | named_reference | existing_app",
    "source_basis": "file path, user note, or inspected artifact",
    "adaptation_boundary": "what may be borrowed vs what must not be copied",
    "confidence": "high | medium | low"
  }
}
```

Then normalize the source into tokens that hand-authored HTML/CSS/SVG can consume:

- `color_tokens`: background, surface, text, muted, primary accent, optional secondary accent, plus intended contrast relationship.
- `typography_tokens`: display, body, data/label, caption roles; scale and weight intent; avoid relying on fonts that are not available.
- `shape_tokens`: radius, stroke, shadow, divider, border, and density.
- `layout_language`: grid, editorial, cinematic, dashboard, diagrammatic, poster, product-demo, or another concrete grammar.
- `motion_language`: entrance, transition, emphasis, data-build, and exit patterns; keep it compatible with GSAP timeline seeking.
- `asset_rules`: what images/icons/marks are allowed, need replacement, or must be avoided.
- `do_not_copy`: logos, exact layouts, trademarked copy, screenshots, or protected illustrations unless the user owns them.

Keep the imported style small. If more than 6 chromatic colors or 3 font roles are needed, summarize the conflict and pick the smallest faithful subset.

## Map To Video

Web and brand systems are not videos. Convert them for motion:

- First frame: choose the style's strongest thumbnail-friendly signal.
- Safe zones: enlarge type and spacing beyond web density.
- Scene variation: turn repeated web sections into distinct beats.
- Motion: make the brand grammar move with purpose; do not animate every component.
- Captions: keep ordinary subtitles in `tracks.captions.lines`, not in the style system.

## Output

After extraction, the design contract must state:

- What source was used.
- Which tokens were adopted.
- Which tokens were deliberately simplified.
- Which elements must not be copied.
- What visual signature will make the video feel related to the reference without becoming a clone.
