# SwiftUI Refactor

Use this reference for SwiftUI View structure, dependency injection, Observation usage, MV patterns, and ViewModel boundaries.

## Core Guidelines

### View Ordering

Prefer this order inside a SwiftUI view:

1. Environment values.
2. Stored `let` values.
3. `@State` and other stored properties.
4. Non-view computed properties.
5. `init`.
6. `body`.
7. Computed view builders and view helpers.
8. Helper / async functions.

### Prefer Model-View

- Default to SwiftUI-native Model-View patterns.
- Views are lightweight state expressions; models/services own business logic.
- Favor `@State`, `@Environment`, `@Query`, `task`, and `onChange` for orchestration.
- Inject services and shared models via `@Environment` when that matches the app architecture.
- Split large views into subviews before adding a ViewModel.

For deeper rationale, read `references/mv-patterns.md`.

### Split Large Bodies

- If `body` spans multiple logical sections, split it.
- Keep simple computed view helpers in the same file when that improves local readability.
- Extract standalone `View` types when there is state, complex branching, reuse, or a clear component boundary.
- Prefer passing small inputs, bindings, and callbacks over passing the entire parent state.

### ViewModel Handling

- Do not introduce a ViewModel unless the request or existing code clearly calls for one.
- If a ViewModel exists, make it non-optional when possible.
- For `@Observable` reference types owned by a root view, store them as `@State`.
- Initialize `@State` view models in `init` when dependencies are provided by the view.
- Avoid `bootstrapIfNeeded` patterns when a clear initializer can establish state.

Example:

```swift
@State private var viewModel: SomeViewModel

init(dependency: Dependency) {
    _viewModel = State(initialValue: SomeViewModel(dependency: dependency))
}
```

## Refactor Workflow

1. Reorder the view to match the ordering rules.
2. Identify which state actually drives each section.
3. Split large body sections into smaller views or helpers.
4. Move business logic out of views only when it is genuinely business logic or expensive work.
5. Preserve behavior unless the user asks for behavior changes.
6. Check Observation usage and dependency boundaries.
7. Provide a before/after summary and verification plan.

## Output

- Structural issues found.
- Refactor plan with behavior-preserving steps.
- Code changes if the user asked for implementation.
- Risks: data flow changes, animation changes, identity changes, preview coverage.
- Verification: build, previews, relevant unit/UI tests, and manual scenario.
