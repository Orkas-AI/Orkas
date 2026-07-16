---
ownerAgent: bcfcb4921dce
name: ui-design-review
description_zh: "评审 HTML 页面、截图或已实现界面，按严重度输出可修复问题、证据、改法和验证建议。"
description_en: "Review HTML pages, screenshots, or implemented UI with prioritized fixable findings, evidence, fixes, and validation guidance."
category: rnd
---

# ui-design-review

Use this skill when the task is to review, critique, QA, or polish an existing UI, screenshot, HTML artifact, or implemented screen.

Pair this skill with `ui-craft-checks` for launch-readiness, HTML QA, screenshot/design-source fidelity, accessibility, state coverage, forms, motion, typography, responsive behavior, live-ready artifacts, and anti-template polish.

For polish requests, use `ui-artifact-workspace` when the target is a standalone artifact. Do not restart the design from scratch. Inspect the canonical directory, manifest, current render, and source files; preserve the user's content and contract, then make the smallest set of high-impact fixes that improves hierarchy, responsiveness, accessibility, and visual craft in place.

## Review Stance

Findings first. Prioritize user-impacting issues over taste commentary:

1. Blocking workflow or comprehension issue.
2. Accessibility or responsive failure.
3. Layout, overlap, or text-fit risk.
4. Incorrect control or missing state.
5. Weak hierarchy, density, typography, or visual system.
6. Color, contrast, and semantic status risk.
7. Lower-priority polish.

Do not lead with a compliment. A short summary can come after findings.

## Follow-Up Modes

Choose the mode that matches the user's wording:

- Audit: identify the highest-impact issues.
- Critique: explain what feels generic, overdesigned, underdesigned, or inconsistent.
- Polish: edit or specify targeted improvements while preserving intent.
- Harden: repair mobile overflow, clipped text, contrast problems, missing states, broken links, and fragile layout assumptions.
- Motion: add restrained motion only where it improves feedback, state change, or comprehension.
- Live-ready: prepare the artifact for sharing with final visual QA and a short risk list.

Remove common AI-generated tells when they do not serve the product: purple-blue glow gradients, generic feature-card rows, oversized rounded panels everywhere, empty marketing adjectives, inconsistent spacing, decorative effects without job value, and missing real interaction states.

## Evidence To Inspect

Use whatever is available:

- Rendered HTML or app preview.
- Desktop and mobile screenshots.
- Source CSS/HTML/component files.
- Design system tokens.
- Figma notes, screenshot references, or existing product screens.

If a rendered view is available, review the rendered view, not only source code.

## Findings Format

Use:

```markdown
## Findings
- [P1] Title
  Evidence: ...
  Why it matters: ...
  Fix: ...

## Open Questions
- ...

## Summary
- ...
```

Severity guide:

- P0: unusable, broken, or cannot complete the main task.
- P1: serious workflow, accessibility, responsive, or comprehension problem.
- P2: noticeable quality or consistency issue.
- P3: polish.

When `ui-craft-checks` is active, map its P0/P1/P2 gates onto these findings. P0 craft failures should be fixed or called out before lower-priority taste notes.

## Review Checklist

Workflow:

- Main task is obvious.
- Primary action is clear.
- Secondary actions are discoverable but not competing.
- Repeated work is efficient.

Layout:

- No overlap or clipped text.
- Responsive behavior is intentional.
- Fixed-format elements have stable dimensions.
- Spacing supports hierarchy.

Controls:

- Correct control type.
- Hover, focus, selected, disabled, and error states exist where needed.
- Icon-only controls have accessible names.
- Menus and popovers have clear trigger and dismissal behavior.

Typography:

- Type scale matches container.
- Labels and table text are readable.
- No hero-scale type in compact panels.
- Line length and wrapping are controlled.

Color:

- Contrast is sufficient.
- Semantic colors are not reused as arbitrary accents.
- Palette is not one-note.
- Status is not color-only.

Taste:

- Design fits the domain.
- Visual signature helps the workflow.
- Generic AI UI tropes are absent or justified.

## Fix Guidance

Each finding should point to an implementable change:

- Component or file when known.
- Token adjustment if systemic.
- Layout rule or responsive breakpoint.
- State to add.
- Copy or label adjustment if it affects usability.

If the user asks you to fix the UI and a repo is available, switch to implementation after the review and verify the rendered result.
