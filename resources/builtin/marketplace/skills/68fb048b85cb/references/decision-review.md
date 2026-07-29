# Decision Review Reference

Use this reference before finalizing an ADR or spike recommendation when the user asks to challenge a plan, compare architecture branches, or surface hidden assumptions.

## Review Flow

1. **Map decision branches**: identify 3-6 top-level branches, such as data model, integration boundary, runtime, deployment model, migration path, observability, or vendor choice.
2. **Resolve foundational branches first**: start with decisions that constrain other decisions.
3. **Ask evidence-seeking questions**: prefer questions answerable from code, docs, metrics, logs, or constraints.
4. **Recommend before asking when possible**: state the likely answer and why, then ask for confirmation only where user context is required.
5. **Close each branch**: record the decision, rejected option, evidence, risk, and follow-up.

## Grill-Me Mode

Use this mode when the user says "grill me", "challenge this plan", "stress-test this implementation", or when a technical plan is still conceptual.

- Start by listing the 3-6 decision branches you see.
- Walk one branch at a time, in dependency order.
- For each question, first provide your recommended answer and rationale.
- Ask exactly one question, then wait for the user's response before moving to the next question.
- If a question can be answered by reading the codebase, docs, tests, logs, or existing plans, resolve it yourself instead of asking the user.
- Stop only when every branch has a concrete decision or an explicit follow-up; do not leave "it depends" unresolved.
- Close with one paragraph summarizing the decisions made and the remaining risks.

## Questions To Ask

Use only the questions that matter for the current decision.

### Scope

- What exactly is being decided now?
- What is explicitly out of scope?
- Is this decision reversible, expensive to reverse, or effectively permanent?

### Evidence

- What evidence supports the preferred option?
- What evidence would change the decision?
- Which claims are still assumptions?
- Are benchmark numbers, vendor claims, or API limits verified?

### System Fit

- Which existing architecture decisions constrain this choice?
- Does this introduce a new runtime, vendor, data store, protocol, or operational burden?
- What migration path is required?
- What will become harder to test, debug, deploy, or observe?

### Consequences

- What becomes easier?
- What becomes harder?
- What failure modes are introduced?
- What future options does this preserve or close?
- Who owns the operational risk after launch?

### Follow-up

- What needs a spike before an ADR can be accepted?
- What should be measured after implementation?
- What checkpoint should revisit this decision?

## Closeout Template

```markdown
## Decision Review Closeout

- Resolved decision:
- Preferred option:
- Rejected options:
- Evidence:
- Remaining assumptions:
- Risks accepted:
- Follow-up:
- Recommended artifact: ADR / spike summary / implementation plan
```
