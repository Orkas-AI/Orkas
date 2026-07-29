---
name: product-test
description: Use to turn a PRD section, user story, feature slice, or behavior description into product test scenarios and pass/fail conditions. Use when the user asks for product testing, acceptance criteria, Given/When/Then scenarios, QA-ready scenarios, pass/fail checks, edge cases, error states, non-functional acceptance checks, or story-level verification.
---

# Product Test

Use this skill to define the observable behavior that must be true for a story or feature to be considered done. It turns product context into concise, testable Given/When/Then scenarios that engineers and QA can verify without guessing intent.

Do not use this skill to write a full PRD, redesign the feature, break work into engineering tasks, write implementation plans, run tests, write automation code, or create exhaustive test suites. Stay focused on product-level acceptance scenarios for a specific story, feature slice, or behavior.

## When To Use

- A user story, PRD section, or feature slice already exists.
- The team needs clear pass/fail conditions before or during implementation.
- QA needs explicit happy path, edge case, error state, or non-functional scenarios.
- A story is too vague and needs observable done conditions.

If the feature scope is unclear, ask for the smallest missing context before drafting criteria.

## Instructions

1. **Confirm the slice**: identify the exact story, workflow, user role, or behavior being accepted.
2. **Capture inputs and assumptions**: list source material, scope boundaries, and missing context.
3. **Separate scenario types**: cover happy path first, then edge cases, error states, and non-functional expectations.
4. **Use stable acceptance IDs and Given/When/Then only**: each criterion should be independently testable and observable so engineering evidence can map back to it.
5. **Describe recovery behavior**: when validation fails or a dependency breaks, state what the user sees and how they can recover.
6. **Avoid implementation leakage**: do not mention internal classes, tables, functions, or code paths unless the acceptance surface is technical by nature.
7. **Review for pass/fail clarity**: rewrite subjective criteria into measurable outcomes.
8. **End with handoff**: state what is ready for QA or engineering, what still needs clarification, and the observable evidence surface for each acceptance ID without prescribing implementation details.

## Output Format

Use `references/product-test-template.md` as the default structure. Keep scenarios concise and avoid duplicate coverage.

## Required Boundaries

- Do not invent product behavior that is not implied by the source material. Mark assumptions clearly.
- Do not convert every possible test case into acceptance criteria; focus on story-level pass/fail behavior.
- Do not include implementation instructions, file names, commands, or detailed QA automation steps.
- Do not use vague outcomes such as "works correctly" or "is user-friendly"; make the observable result explicit.
- If current legal, pricing, policy, or platform behavior affects acceptance, verify sources before relying on it.

## Quality Checklist

Before finalizing, verify:

- Criteria map to a specific story, feature slice, or behavior.
- Happy path appears before edge cases and error states.
- Each criterion has one clear observable outcome.
- Error states include user-visible recovery behavior.
- Non-functional criteria are included when relevant.
- Assumptions and open questions are visible.
- No implementation details leak into acceptance criteria.
- Acceptance IDs can be mapped one-to-one to an engineering evidence matrix.
