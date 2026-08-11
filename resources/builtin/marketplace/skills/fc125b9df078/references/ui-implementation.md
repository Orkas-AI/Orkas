# UI Implementation

Use this reference when creating or improving UI inside an existing app, or when delivering a clear standalone greenfield UI artifact.

## Intake

Capture only what is needed:

- Product goal or user story.
- Target screen, route, component, or workflow.
- Existing app framework and styling system.
- Required states: default, empty, loading, error, success, disabled, selected.
- Requested viewport targets and accessibility constraints.
- Any requested visual style or brand reference.

## Implementation Steps

1. Inspect nearby screens/components before designing when an existing app is present.
2. Reuse the app's component system, icons, tokens, utility classes, and layout patterns. For standalone work, choose a minimal self-contained HTML/CSS/JS structure with no unnecessary dependencies.
3. Define the UI structure before coding: navigation, primary content, actions, feedback, and edge states.
4. Implement in small changes.
5. Check text fit at the actual requested viewport; check responsive behavior only when the user requests multi-device or narrow-screen support.
6. For a standalone artifact, include visible focus treatment, semantic labels or alt text, and `prefers-reduced-motion`; keep every requested section and action reachable, and back each action with included or inline sample content rather than a missing placeholder file.
7. For a runnable local HTML entry, call `html_preview` with the actual requested viewport target. `screenshots` defaults to false; use `screenshots:true` only for the final visual review. Use `target:"responsive"` only for an explicit responsive, multi-device, or narrow-screen request; otherwise omit target for desktop or use mobile for an explicitly mobile artifact. Source inspection, a media-query grep, a local server, PID, or HTTP response cannot prove rendered behavior.
8. If any requested viewport fails, repair the reported defect and rerun the same entry; failed checks return diagnostics without screenshots. Do not mask horizontal overflow with a global `overflow-x: hidden` or shrink the entire page.
9. In the final handoff, name every user-requested screenshot size actually captured and inspected. Report Tab-key focus traversal and visible-focus counts, hash/mail links, filled/submitted forms, and observed download filenames, MIME types, and byte sizes.
10. When `html_preview` is unavailable or fails for an environmental reason, label browser, requested viewport behavior, link, form, and download checks unverified and provide copy-paste deployment steps for a static host. Still make the verification plan concrete: name each requested viewport, overflow/text-fit checks, tab order and focus, link targets, form behavior, and generated download content and filename. Do not search for or install another browser runtime.

## Design Decisions To Make Explicit

| Area | Decision |
|---|---|
| Layout | Page structure, grid/flex behavior, density |
| Components | Existing components reused, new components needed |
| States | Empty/loading/error/success/disabled/selected |
| Interaction | Click, keyboard, focus, hover, validation |
| Viewport | Behavior at the requested desktop, mobile, or multi-device target |
| Accessibility | Labels, focus, contrast, keyboard, touch target |
| Visual style | Existing app style or selected reference |

## Frontend Quality Gate

- Text does not overlap or overflow important containers.
- Buttons and controls have stable dimensions.
- Primary action is clear.
- Empty/error/loading states are useful.
- Keyboard focus and accessible names are present where needed.
- Motion respects the user's reduced-motion preference.
- UI remains usable at every user-requested viewport.
- Runnable local HTML has a fresh successful `html_preview` result for every user-requested viewport, or the rendered result remains explicitly unverified with the exact blocker.
- External style references are adapted, not copied wholesale.

## Handoff Note

If the request explicitly targets an existing app but its required files are unavailable, produce a compact UI plan with:

- Screen layout.
- Component list.
- State list.
- Visual style direction.
- Acceptance notes for the implementer.
