---
ownerAgent: bcfcb4921dce
name: ui-design-source
description_zh: "处理 Figma 链接/导出、设计稿截图、PDF、JSON、现有 HTML 或设计说明，把来源抽取成 frame map、源图到 HTML 检查点、组件/变量/资产/交互清单、保真边界和 UIDesigner 实现交接；没有真实访问能力时不假装已导入。"
description_en: "Handle Figma links/exports, design screenshots, PDFs, JSON, existing HTML, or design notes by extracting a frame map, source-to-HTML checkpoints, components/variables/assets/interactions, fidelity boundaries, and UIDesigner implementation handoff; never pretend a design source was imported when access is unavailable."
category: rnd
---

# ui-design-source

Use this skill when the user provides Figma material, design-export files, screenshots of design tools, PDFs, JSON, existing HTML, or asks for design-to-HTML/code fidelity. It adapts OpenDesign/Figma handoff discipline for UIDesigner without requiring a live Figma runtime.

This skill turns design-source evidence into a compact handoff for `ui-design-contract`, `ui-reference-packs`, `ui-design-system`, and `ui-html-renderer`.

## Access Rules

- If a Figma connector, MCP, plugin API, or exported file is actually available, inspect it with the available tool or file reader.
- If the user only provides a Figma URL and no available Figma access exists, ask for a screenshot/export or continue only from visible notes. Do not claim "Figma imported", "frames inspected", or "variables read".
- If the design source is an image or PDF, treat it like a screenshot: extract what is visible, label uncertain text/spacing, and preserve information architecture.
- If the design source is HTML/CSS, inspect the rendered surface when possible and use source files only to clarify tokens/components.

## Source Intake

Classify the source:

- `figma_url`: URL or file key, not enough by itself unless a connector/tool is available.
- `figma_export_json`: nodes, components, variables, styles, constraints, or plugin export.
- `design_screenshot`: frame image, prototype screenshot, app screenshot, or reference image.
- `design_pdf`: exported specs, deck, or annotated design handoff.
- `existing_html`: current artifact, app page, or prototype.
- `design_notes`: Markdown/text PRD, redlines, specs, or designer comments.

For each source, record:

- Path/link/attachment identity.
- What was actually inspectable.
- Confidence: `high`, `medium`, or `low`.
- Missing access or missing data.

## Extract Design Source Map

Before rendering, produce this compact map:

```markdown
## Design Source Map
- Source type:
- Frames/screens:
- Primary frame:
- Visible copy:
- Layout regions:
- Components:
- Variants/states:
- Variables/tokens:
- Assets/icons/images:
- Interactions/prototype notes:
- Responsive constraints:
- Implementation targets:
- Fidelity requirements:
- Unknowns:
```

For Figma-like sources, look specifically for:

- Frame size, grid, auto-layout direction, gaps, padding, constraints.
- Component instances, variants, slot/content overrides, states.
- Variables/styles for color, typography, radius, elevation, spacing, effects.
- Text styles and localization risks.
- Exportable assets and which assets must be replaced or recreated.
- Prototype links, overlays, interactions, transitions, and disabled/error states.

## Source-To-HTML Checkpoints

For screenshot/design-to-HTML work, use a staged pass inspired by strong screenshot-to-code workflows, but keep UIDesigner's HTML-first and evidence-first rules:

1. Inventory the source before styling: visible text, major regions, controls, repeated patterns, image/icon assets, data shape, and unknown areas.
2. Choose the target stack from the user's request or repo context. Standalone drafts default to self-contained HTML/CSS; only use Tailwind, Bootstrap, React, Vue, or a component library when the target project already uses it or the user asks.
3. Create a source-to-HTML mapping for each major region: source region, intended HTML section/component, preserved details, intentional changes, and fidelity risk.
4. Render critical states, not just the happy path: loading, populated, empty, error, disabled, selected, hover/focus, validation, and mobile behavior when relevant.
5. Compare the HTML against the source/contract after rendering. Fix drift in layout, hierarchy, visible copy, density, and component role before decorative polish.

Do not fill missing screenshot content with dashboard metrics, sidebars, fake records, or template blocks. If sample data is necessary, label it as sample and keep it out of observed evidence.

## Fidelity Modes

Choose one mode and state it:

- `exact`: reproduce the supplied frame as closely as HTML allows; preserve layout, text, spacing, and component structure.
- `adaptive`: keep the design language and hierarchy but make it responsive, accessible, and implementation-friendly.
- `systemize`: extract tokens/components from the design and build a reusable HTML design system sample.
- `redesign`: use the design as evidence, then intentionally change structure according to user goals.

If the user says "根据设计稿实现", "Figma to HTML", "1:1", or "保真", default to `exact` unless responsive/product constraints require `adaptive`.

## Component Mapping

Map design components to implementation components:

```markdown
## Component Mapping
- Design component:
- HTML/app component:
- Props/content:
- States:
- Tokens used:
- Accessibility notes:
- Responsive behavior:
- Fidelity risk:
```

Use local app components when implementing in a repo. For standalone HTML, define semantic HTML/CSS components with the same roles and states.

When a design source exposes component metadata, keep the mapping implementation-neutral:

- Prefer semantic roles and props over library-specific names.
- Record variant axes such as size, emphasis, state, density, and destructive/success semantics.
- Preserve accessibility intent such as label relationships, focus order, landmark roles, and keyboard affordances.
- Treat shadcn/Radix/Headless UI/React Spectrum/Ant/MUI-style components as behavioral references only unless the local repo already uses them.

## Handoff To Other Skills

- Send evidence and unknowns to `ui-design-contract`.
- Use `ui-reference-packs` only if the source lacks a clear style system or the user asks for a named style direction.
- Send tokens/components to `ui-design-system`.
- Send fidelity mode, frame map, and source-to-HTML mapping to `ui-html-renderer`.
- Use `ui-design-review` after rendering to check visual drift, responsive behavior, and state coverage.

## Safety And Ownership

- Do not copy protected logos, proprietary illustrations, or third-party brand assets unless the user owns or supplied them for this work.
- Do not persist access tokens, cookies, API keys, raw provider responses, or private metadata in HTML or handoff files.
- Do not reveal internal source paths in user-facing copy unless the path is the deliverable location or needed for debugging.

## Output Shape

When using this skill, include this handoff when useful:

```markdown
## Design Source Handoff
- Source inspected:
- Access level:
- Fidelity mode:
- Frame/source map:
- Component mapping:
- Token mapping:
- Assets:
- Unknowns:
- HTML acceptance gates:
```
