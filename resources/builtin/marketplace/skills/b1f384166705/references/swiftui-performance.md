# SwiftUI Performance

Use this reference for SwiftUI rendering, scrolling, body updates, layout, CPU/memory, hangs, hitches, and Instruments evidence.

## Decision Tree

- If the user provides code, start with code-first review.
- If the user describes symptoms only, ask for the target view and reproduction steps, then do code-first review.
- If code review is inconclusive, guide the user to collect Instruments evidence.
- If the user provides trace screenshots, trace exports, or hotspot data, analyze evidence first and tie findings back to code.

## Code-First Review

Collect:

- Target view/feature code.
- Data flow: state, environment, observable models, queries, services.
- Symptoms and reproduction steps.
- Device/OS/build configuration when known.

Look for:

- View invalidation storms from broad state changes.
- Unstable identity in lists: `id` churn, `UUID()` per render, fragile `id: \.self`.
- Heavy work in `body`: sorting, filtering, formatting, image decoding, expensive computed properties.
- Layout thrash: deep stacks, `GeometryReader`, preference chains, text/layout churn.
- Large images without downsampling or resizing.
- Over-animated hierarchies and implicit animations on large trees.
- AppKit/UIKit hosting updates inside SwiftUI.
- Main-thread work during navigation, scrolling, search, import, sync, or animation.

## Common Fixes

- Narrow state scope closer to leaf views.
- Stabilize list identities.
- Move heavy work out of `body`; precompute on change, cache, or move into model/service.
- Use small subviews to reduce invalidation fan-out.
- Consider `.equatable()` or value wrappers for expensive subtrees only when equality is cheap and meaningful.
- Downsample images before rendering.
- Reduce layout complexity or use stable sizing where possible.
- Avoid broad observable dependencies when a row only needs a small derived value.

## Instruments Workflow

Ask the user to collect:

- Release build when practical.
- SwiftUI template in Instruments, plus Time Profiler and Hangs/Hitches when relevant.
- Exact interaction: scroll, navigation, animation, search, launch, import, sync.
- SwiftUI timeline lanes and Time Profiler call tree screenshots or trace export.

Interpret:

- Update groups and body evaluation frequency.
- Long platform view updates.
- Other long updates: geometry, text, layout, and SwiftUI work.
- Cause/effect relationships for why updates occur.
- Hangs/hitches around the reported interaction.

## Reference Files

Read only when needed:

- `references/optimizing-swiftui-performance-instruments.md`
- `references/understanding-improving-swiftui-performance.md`
- `references/understanding-hangs-in-your-app.md`
- `references/demystify-swiftui-performance-wwdc23.md`

## Output

Provide:

- Short metrics table when before/after or trace metrics exist.
- Top issues ordered by likely impact.
- Evidence for each finding.
- Proposed fixes with estimated effort.
- Verification plan using the same scenario.
