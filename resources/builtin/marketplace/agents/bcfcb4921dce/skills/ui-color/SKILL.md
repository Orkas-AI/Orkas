---
ownerAgent: bcfcb4921dce
name: ui-color
description_zh: "构建和审查 UI 配色，覆盖 OKLCH/OKLAB、调色板、语义色、对比度、图表色、暗色模式和可访问性色彩规则。"
description_en: "Build and review UI color systems across OKLCH/OKLAB, palettes, semantic color, contrast, chart color, dark mode, and accessible color rules."
category: rnd
---

# ui-color

Use this skill when creating or reviewing palettes, contrast, semantic color, dark mode, or chart colors. It adapts Color Expert-style color reasoning into practical UI work.

## Color Roles First

Start with roles before choosing hues:

- `bg`: page background.
- `surface`: panels, rows, cards, inputs.
- `surface-raised`: dialogs, menus, popovers.
- `text`: primary content.
- `text-muted`: metadata and helper text.
- `border`: dividers, input outlines, table rules.
- `accent`: primary action, selection, active state.
- `focus`: visible keyboard focus.
- `danger`, `warning`, `success`, `info`: semantic states.
- `chart-*`: data series, separate from action colors.

Do not use the same accent for primary action, warning, and chart series.

## OKLCH And Perceptual Rules

When authoring new palettes:

- Prefer OKLCH/OKLAB reasoning for even lightness and chroma steps.
- Keep neutral surfaces low-chroma.
- Use accent chroma deliberately; high chroma should be rare in work tools.
- Build light and dark variants by role, not by automatic inversion.
- Keep semantic colors distinct in hue and lightness.

When the codebase uses hex, HSL, RGB, or CSS variables, implement in the local format while preserving the role logic.

## Contrast Rules

Check contrast for:

- Body text on page and panel backgrounds.
- Muted text on surfaces.
- Buttons in default, hover, pressed, and disabled states.
- Inputs, focus rings, and validation messages.
- Table row selection and hover.
- Status chips and alerts.
- Chart labels and legends.

Do not rely on color alone for state. Pair semantic colors with text, icon shape, position, or pattern.

## Palette Construction

For product UI:

- Use 1 primary accent.
- Add at most 1 secondary accent unless data visualization requires more.
- Keep neutral scale broad enough for hierarchy.
- Keep borders visible but quiet.
- Reserve saturated colors for action, selection, and status.

For dashboards:

- Separate categorical chart colors from UI actions.
- Avoid too many similar blues or purples.
- Make critical alerts readable in both color and text.

For brand/editorial pages:

- Color may be more expressive, but the product/place/object must stay inspectable.

## Dark Mode

Dark mode is not inverted light mode:

- Raise surfaces through lightness differences, not heavy shadows.
- Keep text contrast high without pure white everywhere.
- Lower accent chroma if it blooms.
- Re-check semantic colors; red and yellow often need separate dark-mode values.

## Review Output

When reporting color decisions:

- List role tokens.
- Explain accent and semantic usage.
- Note contrast risks.
- Note one-hue or over-saturation risks.
- State whether chart/data colors are separate from action colors.
