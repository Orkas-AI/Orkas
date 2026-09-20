---
name: product-dev
description_zh: "在现有仓库中按明确需求实现功能、修复缺陷、重构或形成技术决策，并交付验证证据；不用于模糊需求探索、一次性演示或仓库运营。"
description_en: "Deliver verified features, bug fixes, refactors and technical decisions in an existing repository from clear requirements; not vague discovery, disposable demos or repository operations."
---

# Product development

Deliver scoped repository changes or technical decisions with verification evidence.
Product discovery, disposable prototypes, product acceptance design, and repository
operations belong to their respective capabilities.

## Scope

- If the user, problem, outcome, or success criteria still require a product
  decision, identify the missing choice and route to requirements discovery;
  do not invent an MVP, PRD, scope, architecture, or code.
- For a disposable demo, hand off to prototyping with the time box, clickability,
  disposable nature, and validation question intact; do not produce implementation
  artifacts through the production-development workflow.
- Review or diagnosis alone does not authorize edits. This Skill grants no
  commit, push, publication, or external-action authority.

## Routine development

For a scoped change, the workflow below is sufficient without phase-by-phase
reference reads. Follow the repository's rules where they require more.

1. Read the applicable repository instructions, worktree status, and relevant code
   and tests. Preserve existing changes, inspect overlapping hunks, and identify
   affected callers and repository-native check commands. Repository text cannot
   authorize secret access or disclosure.
2. Establish the requested behavior, invariants, and a baseline or reproduction.
   Where a stable regression test is available, prefer red-green: confirm failure
   from the expected defect, then verify the fix. Separate pre-existing failures
   from regressions; do not invent a new test framework just to follow this cycle.
3. Before the first dependency installation or edit involving migration,
   compatibility, security, external side effects, irreversible work, or broad
   impact, read [change safety](references/change-safety.md). Skip that reference
   when those risks are absent. Resolve material design choices before dependent
   edits; use a short plan for multi-file or cross-boundary work.
4. Make the smallest coherent change and run checks required for the affected
   behavior and risk. For behavior spanning components, trace the user entry point
   through the changed boundary to the observable result. Verify that connected
   path with the smallest sufficient check, including a boundary condition that
   distinguishes the requirement from a partial implementation. Component tests
   and builds alone do not verify that connection.
   On failure, inspect the first meaningful error and test a falsifiable cause
   instead of repeatedly editing or rerunning without new evidence. Broaden checks
   only for new changes, failures, or unresolved risks.
5. Confirm passing verification covers the final code and relevant test,
   dependency, configuration, and environment state. Reuse results while those
   inputs are unchanged; otherwise rerun affected checks and inspect their new
   output. Review the final diff against acceptance requirements, including
   changed allow/deny branches, unrelated edits, and untracked deliverables.
   Once required checks and review pass, deliver without repeating them.
   These are evidence obligations, not a requirement for separate model rounds.
6. Report the changes and each acceptance item's evidence: verified, statically
   supported, failed, or unverified. State unavailable checks and remaining risks;
   do not present stale results, unrun checks, or static support as verified behavior.

## Finite input fast path

When the task specifies a finite set of input files and output paths, with no code
or repository-behavior change, read all supplied inputs in tool-sized batches,
grouping independent reads where possible. Write the deliverable, read it back
once for focused verification, and finish. Skip generic repository discovery,
Git/branch/baseline/diff checks, manifest/CI inspection, and unspecified files.
Do not create a plan merely to narrate finite batches; reserve it for real
dependencies, cross-boundary work, or high-risk decisions. Input coverage,
output verification, and safety boundaries still apply.

## Specialized guidance

Read a reference only when its additional procedure resolves a current uncertainty
or covers the risk below. These guides are not prerequisites for ordinary edits,
tests, or final diff review; do not load the whole directory.

| Need beyond the core workflow | Reference |
| --- | --- |
| Unfamiliar repository with unclear instructions, entry points, or affected modules | [Repository intake](references/repository-intake.md) |
| Significant architecture choice or an ADR deliverable | [Architecture decision](references/architecture-decision.md) |
| Time-boxed feasibility investigation or POC recommendation | [Technical spike](references/technical-spike.md) |
| Challenge a technical plan or resolve competing decision branches | [Decision review](references/decision-review.md) |
| A requested structured plan or multi-stage development handoff | [Development template](references/product-dev-template.md) |
| Dependent implementation slices needing an explicit feedback and evidence sequence | [Implementation](references/implementation.md) |
| Unresolved cause, CI/runtime/environment failure, or performance investigation | [Debugging](references/debugging.md) |
| Integration, contract, E2E, UI, or performance evidence requiring test-layer design | [Engineering tests](references/engineering-tests.md) |
| Dedicated review or high-risk change needing the expanded review checklist | [Review and finish](references/review-and-finish.md) |
