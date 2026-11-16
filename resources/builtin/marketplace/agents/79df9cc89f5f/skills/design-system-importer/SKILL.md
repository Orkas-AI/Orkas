---
ownerAgent: 79df9cc89f5f
name: design-system-importer
description_zh: 把参考图、参考视频、截图和品牌规范转成可执行的画面与时序约束（复刻/编辑/借鉴）。
description_en: Turns reference images, videos, screenshots and brand guides into concrete visual and timing constraints (reproduce, edit or guide).
---

# design-system-importer

Use this when a video has an external reference or style source: a reference image or video, `DESIGN.md`, brand guide, screenshot, a website the user asks to match, design notes, or an explicit named visual direction.

Do not use it for ordinary editing, narration, shot generation, or clip selection. Do not ask the user to approve the result. Do not use it for vague adjectives like "modern", "clean", "premium", or "more polished" when no source is named; in those cases, let `frontend-design` choose the look from the brief.

## Reference intent before technique

To rebuild a reference, first read [reference-recreation.md](@skill/video-craft/references/reference-recreation.md) for content, motion, timing and audio evidence. Token extraction alone does not reproduce a look.

For every supplied image or video, first classify what the user wants from it. Explicit user requirements always override defaults; infer only when the user is silent:

- `reproduce`: preserve the content, identity, composition, structure, style, motion, timing, or audio the user named.
- `edit`: use the media as the original, protect everything unaffected, and change only what was asked.
- `guide`: borrow only selected roles and do not imply exact fidelity. This is the safe default for an otherwise unspecified reference.

A request to change the supplied original implies edit; an explicit restore, recreate or match request implies reproduce; otherwise default to guide.

Keep each inspected media file inside the video folder, under `assets/references/`. For video, `reference.inspect` with `video_dir` keeps a frozen copy and returns its path, so no second copy is needed.

## Source access is an optimization

If the user owns reusable source code, vectors, layers, or assets, use them when that is the safest way to get the same result. If only pixels are available, derive the same spatial and temporal anchors from pixels.

Do not load or recreate an entire external design system.

## Extract compact tokens

Put these straight into the page's CSS and motion; do not write a design document:

- Colours: background, surface, text, muted, primary accent, optional secondary accent, with the intended contrast.
- Type: display, body, data or label, caption roles; scale and weight intent. Do not rely on fonts that are not available.
- Shape: radius, stroke, shadow, divider, border, and density.
- Layout: grid, editorial, cinematic, dashboard, diagrammatic, poster, product demo, or another concrete grammar.
- Motion: entrance, emphasis, data build and exit patterns, compatible with a seekable GSAP timeline.
- Assets: what images, icons and marks are allowed, need replacing, or must be avoided.

Keep it small. If more than 6 chromatic colours or 3 font roles are needed, pick the smallest faithful subset.

## Fidelity

Choose from user intent, not convenience:

- Exact: the user asks to reproduce or continue the supplied design. Preserve at least three named aspects.
- Close: keep its recognizable system and spatial grammar while adapting content, shape and motion.
- Adapt: borrow selected tokens or a visual principle; do not claim pixel fidelity.

For a video used to reproduce, edit, or control motion or timing, map source time ranges to target scenes, and be able to say which source moment each scene follows.

## Map to video

Web and brand systems are not videos. Convert them for motion:

- First frame: choose the style's strongest thumbnail-friendly signal.
- Safe zones: enlarge type and spacing beyond web density.
- Scene variation: turn repeated web sections into distinct beats.
- Motion: make the brand grammar move with purpose; do not animate every component.
- Captions: keep them as captions, not as part of the style system.

## Output

In your final reply, say in a line or two what source was used, what was kept, what was simplified, and anything the user excluded.
