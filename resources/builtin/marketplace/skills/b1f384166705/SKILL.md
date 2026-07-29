---
name: swiftui-dev
description: Use for SwiftUI development work: review and refactor SwiftUI view structure, Observation usage, MV patterns, dependency boundaries, and ViewModel choices; audit SwiftUI rendering, state updates, scrolling, layout, and Instruments evidence; or use xctrace/Time Profiler CLI scripts to record, export, symbolicate, and rank macOS/iOS native hotspots. Use when the user mentions SwiftUI architecture, SwiftUI refactor, Observation, MV, ViewModel boundaries, SwiftUI performance, Instruments, Time Profiler, xctrace, native app hotspots, scrolling jank, hangs, hitches, or body updates.
---

# SwiftUI Dev

Use this skill for SwiftUI development, architecture, structure, performance, and Apple native app profiling. It combines:

- SwiftUI view refactor and Observation/MV guidance.
- SwiftUI code-first performance audit.
- Native macOS/iOS Time Profiler CLI workflow with `xctrace`, `atos`, and included scripts.

Do not use this skill for web performance, server profiling, generic PR review, product planning, or non-Apple UI frameworks. For ordinary implementation work without SwiftUI architecture/performance/native profiling concerns, use the development skill.

## Route The Work

| User intent | Read |
|---|---|
| Refactor SwiftUI View structure, split large `body`, review Observation / MV / ViewModel boundaries | `references/swiftui-refactor.md` |
| SwiftUI page is slow, scrolling janks, body updates too often, Instruments trace needs interpretation | `references/swiftui-performance.md` |
| Record/analyze macOS or iOS native Time Profiler traces from CLI, symbolicate and rank hotspots through the standard Orkas Skill Runner | `references/native-trace.md` |
| Need deeper Apple/WWDC context for SwiftUI update causes, hangs, Instruments lanes | Read the specific Apple summary files listed in the relevant reference |

If the user provides only symptoms, start with code-first SwiftUI review. Ask for trace/screenshots only when code review is inconclusive or the user explicitly wants trace analysis.

## Required Inputs

For SwiftUI code review:

- Target view or feature code.
- Data flow: `@State`, `@Binding`, `@Environment`, `@Observable`, `@Query`, services, models.
- Symptoms and reproduction steps.
- Device/OS/build configuration when performance is involved.

For native profiling:

- App name and binary path, or existing `.trace` bundle.
- Attach PID or launch binary path.
- Slow interaction to exercise during capture.
- Capture duration, defaulting to 90 seconds.
- Matching symbols / binary and permission to launch or attach.

Proceed with explicit assumptions for code-only reviews. Stop before profiling if required tools or permissions are missing.

## Core Workflow

1. **Classify the task**: SwiftUI structure/refactor, SwiftUI performance, or native trace profiling.
2. **Start code-first for SwiftUI**: inspect structure, data flow, Observation ownership, identity, layout, and body work before requesting heavier tooling.
3. **Use Instruments evidence when available**: treat traces/screenshots/CSV as evidence, not as the whole answer.
4. **Make targeted recommendations**: order issues by likely impact and confidence.
5. **Verify with the same scenario**: compare before/after CPU, frame drops, memory peak, sample counts, or the specific user-visible symptom when data exists.

## Boundaries

- Do not invent metrics, trace findings, sample counts, call stacks, device settings, or benchmark results.
- Do not run `xctrace` unless the user has provided a local target, trace, or explicit permission and the environment is macOS with Xcode tools.
- Do not interpret stale symbols as real hotspots. Binary, trace, and load address must match.
- Do not introduce ViewModels by default. Prefer SwiftUI-native state/data flow unless existing code or user requirements justify a view model.
- Do not change business logic during refactor unless the user explicitly asks.
- If source files must be edited, follow the existing project style and verify with relevant build/tests/profiling.

## Output Format

Use this concise structure unless a reference template is more specific:

```markdown
# SwiftUI Dev Review: [Target]

## Inputs And Assumptions

## Findings
| Priority | Finding | Evidence | Recommendation | Confidence |
|---|---|---|---|---|

## Suggested Changes

## Verification Plan

## Risks / Limits

## Handoff To Next Stage
```

For native trace analysis, use the report structure in `references/native-trace.md`.

## Quality Checklist

Before finalizing, verify:

- The task is Apple-native or SwiftUI-specific.
- SwiftUI structure recommendations preserve clear data ownership and framework-native state flow.
- Findings cite code, trace evidence, screenshots, or clearly labeled assumptions.
- Recommendations are targeted, not generic "optimize everything" advice.
- Refactors preserve behavior unless requested otherwise.
- Profiling commands, trace path, binary path, load address, and confidence are reported when CLI profiling is used.
- The user gets a concrete verification plan.
