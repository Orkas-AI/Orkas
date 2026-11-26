# MV Patterns Reference

Source provided by user: "SwiftUI in 2025: Forget MVVM" (Thomas Ricouard).

Use this as guidance when deciding whether to introduce a view model.

Key points:
- Default to MV: views are lightweight state expressions and orchestration points.
- Prefer `@State`, `@Environment`, `@Query`, `task`, and `onChange` over view models.
- Inject services and shared models via `@Environment`; keep logic in services/models.
- Split large views into smaller views instead of moving logic into a view model.
- Avoid manual data fetching that duplicates SwiftUI/SwiftData mechanisms.
- Test models/services and business logic; views should stay simple and declarative.
