# Spike Summary Reference

Use this reference when the user needs to summarize a technical spike, POC, vendor evaluation, feasibility study, or design exploration.

A spike summary documents a time-boxed investigation that reduces uncertainty before committing to implementation. It should answer a specific question with evidence and make the next step clear.

## When To Use

- After completing a time-boxed technical exploration.
- When evaluating technology choices or vendor options.
- After proof-of-concept work that needs to inform a decision.
- When investigating feasibility of a proposed solution.
- Before committing engineering resources to a new approach.

## Spike Steps

1. **State the question clearly**: identify the original and final question if it changed.
2. **Define the time-box**: document allocated time and actual time spent.
3. **Describe the approach**: explain what was tried, in what order, and why.
4. **Present findings with evidence**: support findings with code, benchmarks, logs, screenshots, API responses, docs, or observed behavior.
5. **Make a clear recommendation**: answer proceed, do not proceed, or proceed with conditions.
6. **Document artifacts**: link code, prototypes, diagrams, notes, docs, or benchmark outputs.
7. **Capture open questions**: identify what remains unknown and what needs more investigation.

## Template

```markdown
---
artifact: spike-summary
version: "1.0"
created: <YYYY-MM-DD>
status: draft
---

# Spike Summary: [Spike Title]

## Overview

| Field | Value |
|---|---|
| Question To Answer | [Specific question investigated] |
| Time-Box | [Allocated time] |
| Actual Time Spent | [Actual time] |
| Spike Lead | [Name/role] |
| Date Completed | [YYYY-MM-DD] |

## Background

[Brief context explaining why this question needed investigation.]

## Approach

### What We Tried

1. [Approach and rationale]
2. [Approach and rationale]

### Technologies / Tools Evaluated

- [Technology or tool]

## Findings

### Finding 1: [Title]

[Description]

**Evidence:**

- [Specific data point, benchmark, observation, code sample, API response, or screenshot reference]

## Recommendation

**Decision:** [Proceed / Do Not Proceed / Proceed With Conditions]

[Clear rationale referencing findings.]

### Conditions Or Next Steps

- [Condition]
- [Estimated implementation effort]

## Artifacts

| Artifact | Location | Description |
|---|---|---|
| [POC Code] | [Link/path] | [Description] |

## Open Questions

- [ ] [Open question]

## Follow-up Items

| Action | Owner | Timeline |
|---|---|---|
| [Next step] | [Owner] | [When] |
```

## Quality Checklist

- Original question is clearly stated.
- Time-box is documented.
- Findings are evidence-backed, not just opinions.
- Recommendation directly answers the question.
- Artifacts are linked or described.
- Open questions identify remaining unknowns.
