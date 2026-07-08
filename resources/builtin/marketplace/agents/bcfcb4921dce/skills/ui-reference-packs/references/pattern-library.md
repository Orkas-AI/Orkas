# Pattern Library Boundaries

These page patterns are inspired by OpenDesign's `design-templates/` catalogue. They are structural references, not default templates. Use a pattern only when the user request, source screenshot, or design contract clearly permits it.

## Pattern Selection

1. Identify the artifact type from the design contract.
2. Check whether the user's words or visible source structure match a trigger.
3. If a pattern is not triggered, do not use it just because it is visually polished.
4. If multiple patterns match, choose the one closest to the primary user job and keep the rest as optional follow-up states.

## Patterns

### `dashboard`

Use when:

- The user says dashboard, analytics, monitoring, KPI, admin metrics, ops wall, report view, or performance overview.
- The screenshot visibly contains metrics, charts, filters, tabular monitoring, or operational summaries.

Expected structure:

- App shell or top toolbar, KPI summaries, chart or trend region, filters, detailed table/list, alerts or annotations, drilldown affordances.

Do not use when:

- The source is a homepage, prompt input, landing view, editor, login, profile, form, chat, or simple settings page without metrics.

### `kanban-board`

Use when:

- The user says kanban, task board, sprint board, pipeline, stages, backlog, doing, review, done.
- The screenshot visibly contains columns of cards or status lanes.

Expected structure:

- Columns with stable widths, draggable-card affordance, status counts, owner/priority metadata, add/filter/search actions.

Do not use when:

- The task is a generic project page, dashboard, or document organizer without explicit columns.

### `pricing-page`

Use when:

- The user says pricing, plans, tiers, billing page, subscription comparison, packages, checkout plan selector.
- The artifact is clearly a marketing/commercial page.

Expected structure:

- Header, plan cards, feature comparison, FAQ, trust/guarantee or billing interval controls.

Do not use when:

- The task is internal billing settings, invoice management, or finance operations; those are app workflows, not pricing pages.

### `mobile-app`

Use when:

- The user asks for mobile app, iOS, Android, phone screen, app UI, mobile onboarding, or a screenshot is mobile-shaped.

Expected structure:

- One primary job per screen, mobile safe-area constraints, reachable primary action, tab/nav only when the workflow needs it.

Do not use when:

- The request is responsive web only. Responsive mobile behavior is not the same as a framed mobile app concept.

### `web-prototype`

Use when:

- The user asks for a web app/page prototype, landing page, product page, workflow demo, or interactive HTML concept.

Expected structure:

- First viewport shows the actual experience, not a generic marketing shell, unless it is a landing page.
- Sections follow the user's product job and source contract.

Do not use when:

- The user asked to implement inside an existing repo screen; use that app's structure instead.

### `wireframe-annotated`

Use when:

- The user asks for wireframe, lo-fi, redline spec, annotated layout, engineering handoff, or early IA exploration.

Expected structure:

- Greyscale structure, numbered pins, concise notes, responsive layout intent, not final visual styling.

Do not use when:

- The user asked for final visual design or polished HTML; wireframes can be a section only if explicitly requested.

### `live-artifact`

Use when:

- The user asks for refreshable, synced, recurring, connector-backed, live dashboard/report, auditable data view, or reusable artifact.
- `ui-live-artifact` has classified the mode as `live_ready_html` or `connected_live`.

Expected structure:

- Data source/provenance surface, refresh status, template/data separation, safe placeholder states, no credentials in files.

Do not use when:

- The user only wants a one-off mockup, static redesign, image-to-HTML conversion, or screenshot polish.
- No refresh/data-source/provenance need is present. Use ordinary HTML instead.

### `brand-board`

Use when:

- The user asks for logo, wordmark, icon, brand identity, visual identity, style tile, or design system board.

Expected structure:

- Mark/wordmark variants, color tokens, type samples, spacing/sizing, usage examples, do/don't notes, HTML presentation.

Do not use when:

- The user asks for raw image generation only; route to the image agent unless UIDesigner is explicitly asked to present it as HTML.

## Conflict Handling

- Screenshot contract beats pattern trigger unless the user explicitly asks to transform the screen type.
- User-selected form fields from the launch UI are weaker than attached screenshots and explicit request text.
- If a broad category says "dashboard" but the screenshot is a prompt/input homepage, ask one clarification or preserve the screenshot.
- If the artifact type remains ambiguous after contract extraction, choose the simplest structure that preserves visible information architecture.
