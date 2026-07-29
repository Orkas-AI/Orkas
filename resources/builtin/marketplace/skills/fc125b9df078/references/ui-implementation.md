# UI Implementation

Use this reference when creating or improving UI inside an existing app, or when delivering a clear standalone greenfield UI artifact.

## Intake

Capture only what is needed:

- Product goal or user story.
- Target screen, route, component, or workflow.
- Existing app framework and styling system.
- Required states: default, empty, loading, error, success, disabled, selected.
- Responsive targets and accessibility constraints.
- Any requested visual style or brand reference.

## Implementation Steps

1. Inspect nearby screens/components before designing when an existing app is present.
2. Reuse the app's component system, icons, tokens, utility classes, and layout patterns. For standalone work, choose a minimal self-contained HTML/CSS/JS structure with no unnecessary dependencies.
3. Define the UI structure before coding: navigation, primary content, actions, feedback, and edge states.
4. Implement in small changes.
5. Check responsive behavior and text fit.
6. For a standalone artifact, include visible focus treatment, semantic labels or alt text, and `prefers-reduced-motion`; keep every requested section and action reachable, and back each action with included or inline sample content rather than a missing placeholder file.
7. For a runnable local HTML entry, call `html_preview`. Treat its desktop/mobile screenshots and runtime/resource/overflow evidence as the rendered baseline; source inspection, a media-query grep, a local server, PID, or HTTP response cannot prove visual behavior.
8. If either viewport fails, repair the reported defect and rerun the same entry. Do not mask horizontal overflow with a global `overflow-x: hidden`, shrink the entire page, or declare completion from the desktop screenshot alone.
9. In the final handoff, explicitly say both desktop/mobile screenshot sizes were captured and inspected. Report the preview's Tab-key focus traversal and visible-focus counts, hash/mail links, filled/submitted forms, and observed download filenames, MIME types, and byte sizes. Add focused state-transition and app-specific interaction checks when this generic audit cannot prove the requested behavior.
10. When `html_preview` is unavailable or fails for an environmental reason, label browser, responsive, link, form, and download checks unverified and provide copy-paste deployment steps for a static host. Still make the verification plan concrete: name desktop and mobile viewports, overflow/text-fit checks, tab order and focus, link targets, form behavior, and generated download content and filename. Do not search for or install another browser runtime.

## Design Decisions To Make Explicit

| Area | Decision |
|---|---|
| Layout | Page structure, grid/flex behavior, density |
| Components | Existing components reused, new components needed |
| States | Empty/loading/error/success/disabled/selected |
| Interaction | Click, keyboard, focus, hover, validation |
| Responsive | Mobile/tablet/desktop behavior |
| Accessibility | Labels, focus, contrast, keyboard, touch target |
| Visual style | Existing app style or selected reference |

## Frontend Quality Gate

- Text does not overlap or overflow important containers.
- Buttons and controls have stable dimensions.
- Primary action is clear.
- Empty/error/loading states are useful.
- Keyboard focus and accessible names are present where needed.
- Motion respects the user's reduced-motion preference.
- UI remains usable on mobile and desktop.
- Runnable local HTML has a fresh successful `html_preview` result for both viewports, or the rendered result remains explicitly unverified with the exact blocker.
- External style references are adapted, not copied wholesale.

## Handoff Note

If the request explicitly targets an existing app but its required files are unavailable, produce a compact UI plan with:

- Screen layout.
- Component list.
- State list.
- Visual style direction.
- Acceptance notes for the implementer.
