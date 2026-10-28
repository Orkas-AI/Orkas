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
4. If multiple inspectable source screens define the scope, enumerate the complete set and keep one row per source: identity/path, target route/component, must-preserve visible anchors, intentional changes, and separate `inspected`, `implemented`, and `compared` status. Do not sample the set when promising complete coverage.
5. Implement in small changes.
6. Check text fit at the actual requested viewport; check responsive behavior only when the user requests multi-device or narrow-screen support.
7. For a standalone artifact, include visible focus treatment, adequate contrast, semantic labels or alt text, and `prefers-reduced-motion`; keep every requested section and action reachable, and back each action with included or inline sample content rather than a missing placeholder file.

## Verification and handoff

1. For a runnable local HTML entry, call `html_preview` on the actual entry. Use `target:"responsive"` only for an explicit responsive, multi-device, or narrow-screen request; otherwise omit target for desktop or use mobile for an explicitly mobile artifact. Source inspection, a media-query grep, a local server, PID, or HTTP response cannot prove rendered behavior.
2. Inspect diagnostics and repair recoverable runtime, resource, layout, focus, or interaction defects, then rerun the same entry. Failed checks return diagnostics without screenshots. Do not mask horizontal overflow with a global `overflow-x: hidden` or shrink the entire page.
3. Keep `screenshots` false for audit-only calls. After any relevant edit, discard affected earlier evidence; after the final relevant edit, run with `screenshots:true` for every requested target and inspect the fresh screenshots and interaction evidence.
4. Check each requested action's actual result against its purpose, including navigation destinations, form behavior, and generated download content and filename. A triggered event, declared MIME type, or nonzero byte count alone does not establish that the result is correct or usable. Use available tools to inspect the result; keep any check you cannot perform explicitly unverified.
5. Before claiming a multi-screen source set complete, compare every promised screen against a fresh rendered target. Build success, route/link validity, shared tokens, no-overflow checks, and spot checks do not prove unreviewed screens. If coverage is partial, name every remaining source; if the user contradicts fidelity, reopen the full ledger before asking for an example already present in the sources.
6. If `html_preview` is environmentally unavailable, keep the affected rendered and interaction behavior unverified and state the blocker. Do not search for or install another browser runtime.
7. In the final handoff, summarize the requested behavior verified on the final revision, captured targets and sizes, unresolved failures, and unverified paths. Keep diagnostic counts internal unless needed to explain a finding or requested by the user. For standalone output, include copy-paste deployment steps for a suitable static host and an executable checklist for remaining recipient checks: requested viewports, overflow/text fit, tab order and visible focus, link targets, forms, and generated download content and filename.

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
- External style references are adapted, not copied wholesale.

## Handoff Note

If the request explicitly targets an existing app but its required files are unavailable, produce a compact UI plan with:

- Screen layout.
- Component list.
- State list.
- Visual style direction.
- Acceptance notes for the implementer.
