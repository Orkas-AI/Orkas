---
ownerAgent: 79df9cc89f5f
name: frontend-design
description_zh: 页面视频的视觉方向：设计模板、字体、配色、版式与动效。写 index.html 前按需读。
description_en: Visual direction for page-rendered video: design presets, type, palette, layout and motion. Read as needed before writing index.html.
---

# frontend-design

Choose a look before writing `index.html`, and put the decisions straight into its CSS. Do not write a design document.

- **A concrete reference exists** (the user's brand, a reference video, a product site you captured): take palette, type and layout from what you actually see. Use the real logo and real screens at hero size, never a redrawn placeholder.
- **No reference:** read [references/design-presets.md](references/design-presets.md), pick the one preset that fits the product, read only that preset's file, and remap it onto the brand's colors.

Read more only when stuck: [visual-primitives.md](references/visual-primitives.md) for reusable CSS and SVG patterns, [worked-compositions.md](references/worked-compositions.md) for examples.

Make it belong to this product:

- One clear focal point per frame. Big type and big product beat many small things.
- At most 2 font families and about 3 colors on screen. Contrast of at least 4.5:1 for text.
- Avoid the generic look: centered cards on a gradient, floating blobs, glow, decorative icons in circles. Use the product's own materials instead.
- Vary the scenes: change framing, scale or layout from one scene to the next.
- Never linear easing. Entrances about 0.3–0.5s, staggered by 0.1–0.2s, one focal entrance at a time.
