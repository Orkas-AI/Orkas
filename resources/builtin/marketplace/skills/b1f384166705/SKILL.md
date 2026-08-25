---
name: swiftui-dev
description_zh: "评审和重构 SwiftUI 架构、Observation/MV 状态边界、渲染、滚动与布局，或用 Instruments、xctrace 和 Time Profiler 证据分析 macOS/iOS 原生热点；用于 SwiftUI 设计与性能工作，不用于 Web 或服务端分析。"
description_en: "Review and refactor SwiftUI architecture, Observation/MV state boundaries, rendering, scrolling, and layout, or analyze native macOS/iOS hotspots with Instruments, xctrace, and Time Profiler evidence. Use for SwiftUI design and performance work, not web or server profiling."
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
| Refactor SwiftUI View structure, split large `body`, review Observation boundaries | [SwiftUI refactor](references/swiftui-refactor.md) |
| Decide whether MV, framework-native state, or a ViewModel is justified | [MV patterns](references/mv-patterns.md) |
| SwiftUI page is slow, scrolling janks, or body updates too often | [SwiftUI performance](references/swiftui-performance.md) |
| Build a dependency/update mental model before deeper profiling | [WWDC23 performance model](references/demystify-swiftui-performance-wwdc23.md) |
| Inspect current SwiftUI Instrument lanes or Cause & Effect evidence | [SwiftUI Instruments workflow](references/optimizing-swiftui-performance-instruments.md) and [SwiftUI timeline guide](references/understanding-improving-swiftui-performance.md) |
| Diagnose a main-thread hang or run-loop stall | [App hangs guide](references/understanding-hangs-in-your-app.md) |
| Record/analyze macOS or iOS native Time Profiler traces from CLI, symbolicate and rank hotspots through the standard Orkas Skill Runner | [Native trace workflow](references/native-trace.md) |

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

For native trace analysis, use the report structure in the [native trace workflow](references/native-trace.md).

## Quality Checklist

Before finalizing, verify:

- The task is Apple-native or SwiftUI-specific.
- SwiftUI structure recommendations preserve clear data ownership and framework-native state flow.
- Findings cite code, trace evidence, screenshots, or clearly labeled assumptions.
- Recommendations are targeted, not generic "optimize everything" advice.
- Refactors preserve behavior unless requested otherwise.
- Profiling commands, trace path, binary path, load address, and confidence are reported when CLI profiling is used.
- The user gets a concrete verification plan.
