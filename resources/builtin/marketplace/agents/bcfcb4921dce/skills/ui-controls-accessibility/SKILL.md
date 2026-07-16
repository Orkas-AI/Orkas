---
ownerAgent: bcfcb4921dce
name: ui-controls-accessibility
description_zh: "处理复杂表单、复合控件或专项可访问性审查，覆盖控件分类、状态、响应式、文本适配、键盘操作和 A11y；普通界面使用紧凑执行器的基础规则。"
description_en: "Handle complex forms, composite widgets, or focused accessibility reviews across control taxonomy, states, responsive behavior, text fit, keyboard use, and A11y; ordinary UI uses the compact executor's baseline rules."
category: rnd
---

# ui-controls-accessibility

## Requested Outcome Gate

Before rendering, turn every explicitly requested workflow outcome into a compact ledger: `user outcome -> triggering control/event -> rendered state branch -> recovery/next action`. Success and failure are separate outcomes. If a backend is unavailable, give each outcome a distinct, clearly labeled preview control with an explicit action name such as `data-action="import-success"` and `data-action="import-failure"`; wire each action to its own feedback branch and recovery. Do not deliver while any requested outcome exists only in prose, an unreachable conditional, an ambiguous shared trigger, or a generic error state from a different step.

Use this specialist for complex forms, non-trivial composite widgets, accessibility audits, or control/state failures that need deeper guidance. Ordinary controls, focus, labels, and responsive behavior are covered by `ui-design-executor` and do not require loading this skill.

## Control Taxonomy

Use familiar controls for the job:

- Button: clear command.
- Icon button: familiar compact command, with tooltip or accessible label.
- Toggle or checkbox: binary setting.
- Radio group: mutually exclusive choice where every option should be visible.
- Segmented control: small mode set that changes a view or filter.
- Select or combobox: larger option set.
- Menu: secondary commands.
- Tabs: peer views with persistent context.
- Slider: continuous numeric adjustment.
- Stepper or numeric input: precise numeric adjustment.
- Table or grid: comparison and repeated scanning.
- Drawer: secondary workflow while preserving main context.
- Modal: blocking decision or short focused task.
- Tooltip: explain an icon or concise unfamiliar label, not required content.

Do not style decorative pills as controls unless they have standard keyboard and state behavior.

## Required States

Represent states that a real product would need:

- Default, hover, active/pressed, focus-visible, disabled.
- Selected/current for tabs, nav, filters, rows, and options.
- Empty, loading, success, warning, error.
- Validation for form fields.
- Permission or unavailable state when actions are gated.
- Mobile collapsed state for navigation, filters, and dense tables.

Do not add every state to every component. Add the states the workflow can actually reach.

State coverage is an implementation requirement, not a prose checklist. For a standalone prototype, put each critical state in real DOM or rendering logic and make it inspectable through the real workflow, a small preview-only state switcher, or a clearly labeled state gallery. Listing state names while shipping only the happy path does not count.

## Accessibility Checks

Minimum checks:

- Contrast: body text, muted text, controls, borders, focus rings, and semantic status.
- Keyboard: tab order, visible focus, Escape for popovers/modals, Enter/Space activation where expected.
- Composite widgets: tabs use `tablist`/`tab` semantics with `aria-selected`, roving focus, and Left/Right or Up/Down arrow-key movement as appropriate; menus, listboxes, and grids follow their expected keyboard model.
- Labels: every input and icon-only action needs a visible label, aria-label, or clear surrounding context.
- Target size: small controls need enough clickable area.
- Text scaling: labels and buttons must fit with realistic localized text.
- Motion: avoid critical information that appears only through animation; respect reduced-motion where practical.
- Status: do not rely on color alone.

## Responsive Rules

Define stable responsive behavior:

- Navigation may collapse; primary action remains reachable.
- Tables switch to horizontal scroll, column priority, or list cards depending on data shape.
- Filters collapse into a drawer or toolbar menu.
- Two-pane layouts become stacked or detail-over-list.
- Fixed-format UI such as boards, grids, tiles, and toolbars need stable dimensions.
- Text must wrap or truncate intentionally; it must not overlap controls.

Do not scale font size with viewport width. Use explicit type roles and breakpoints.

If the brief explicitly forbids horizontal scrolling or names a narrow target such as 320px, do not choose horizontal table/nav scrolling. Use column priority, stacked labeled rows/cards, wrapped navigation, and full-width actions so the primary workflow fits the viewport.

## Form And Data Rules

Forms:

- Group related fields.
- Put helper/error text near the field.
- Show required/optional intent clearly.
- Use inline validation for recoverable errors.
- Implement the reachable lifecycle: pristine, dirty/touched invalid, submitted-pending with duplicate submission blocked, recoverable server/error feedback, and success. Do not show dirty validation on first render. Every outcome the user explicitly requests (for example import success and import failure) needs its own reachable real-workflow or preview trigger. With no backend, prefer two explicit named preview actions over a hidden flag or an overloaded generic error button; a conditional branch that is never called with one outcome is dead code and does not count.
- Wire field errors with `aria-invalid` and `aria-describedby` where applicable; move or announce focus to the error summary after a failed submit when the form is long.

Data:

- Align numbers for comparison.
- Keep row actions predictable.
- Use status chips sparingly and consistently.
- Provide sorting/filtering controls only when useful for the data size.

## Output Checklist

For every UI brief or implementation, include:

- Control choices and why.
- Key states represented.
- Where each critical state is implemented and how to reach it.
- Keyboard/focus expectations.
- Mobile behavior.
- Text-fit and localization risk.
- Contrast or status-color notes.
