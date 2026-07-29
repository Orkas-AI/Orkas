---
artifact: product-test
version: "1.0"
created: <YYYY-MM-DD>
status: draft
---

# Product Test: [Feature Or Story Title]

## Inputs

| Source | What It Contributes | Confidence | Notes |
|---|---|---|---|
| [Source material] | [Story / PRD section / design note / user feedback] | High / Medium / Low | |

## Story Context

[Briefly restate the user need, feature slice, scope boundary, and any assumptions that matter for testing.]

## Assumptions

- [Assumption] - Validation needed:

## Happy Path

### AC-1: [Happy Path Title]

**Given** [initial context or precondition]

**When** [user action or trigger]

**Then** [expected observable outcome]

### AC-2: [Happy Path Title]

**Given** [initial context or precondition]

**When** [user action or trigger]

**Then** [expected observable outcome]

## Edge Cases

### AC-3: [Edge Case Title]

**Given** [boundary condition or alternate state]

**When** [user action or trigger]

**Then** [expected observable outcome]

## Error States

### AC-4: [Error State Title]

**Given** [failure condition]

**When** [user action or trigger]

**Then** [expected observable outcome and recovery path]

## Non-Functional Criteria

### AC-5: [Non-Functional Title]

**Given** [relevant system or user context]

**When** [measurement or action]

**Then** [expected measurable constraint or guarantee]

## Open Questions

- [ ] [Question] - Owner: [Name / role]

## Engineering Evidence Handoff

| Acceptance ID | Observable Evidence Surface | Suggested Level | Notes |
|---|---|---|---|
| AC-1 | [What an engineer or QA must observe] | Unit / Integration / Contract / E2E / UI / Performance | [No file names or implementation prescription] |

## Handoff

| Recipient | Ready? | Notes / Missing Inputs |
|---|---|---|
| QA | Yes / No | |
| Engineering | Yes / No | |
| Product | Yes / No | |
