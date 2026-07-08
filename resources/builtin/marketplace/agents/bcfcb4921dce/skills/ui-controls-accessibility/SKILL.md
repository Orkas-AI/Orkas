---
ownerAgent: bcfcb4921dce
name: ui-controls-accessibility
description_zh: "选择正确控件并检查可访问性，覆盖控件分类、状态覆盖、响应式、文本适配、键盘操作和 A11y 规则。"
description_en: "Choose the right controls and check accessibility across control taxonomy, states, responsive behavior, text fit, keyboard use, and A11y rules."
category: rnd
---

# ui-controls-accessibility

Use this skill when choosing controls, defining states, checking responsive behavior, or reviewing accessibility. It adapts UI Skills-style practical UI rules into implementation-ready design work.

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

## Accessibility Checks

Minimum checks:

- Contrast: body text, muted text, controls, borders, focus rings, and semantic status.
- Keyboard: tab order, visible focus, Escape for popovers/modals, Enter/Space activation where expected.
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

## Form And Data Rules

Forms:

- Group related fields.
- Put helper/error text near the field.
- Show required/optional intent clearly.
- Use inline validation for recoverable errors.

Data:

- Align numbers for comparison.
- Keep row actions predictable.
- Use status chips sparingly and consistently.
- Provide sorting/filtering controls only when useful for the data size.

## Output Checklist

For every UI brief or implementation, include:

- Control choices and why.
- Key states represented.
- Keyboard/focus expectations.
- Mobile behavior.
- Text-fit and localization risk.
- Contrast or status-color notes.
