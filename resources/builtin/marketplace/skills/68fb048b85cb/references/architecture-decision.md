# ADR Reference

Use this reference when the user needs an Architecture Decision Record.

An ADR documents a significant technical decision along with its context and consequences. It captures the "why" behind an architectural choice so future readers understand the reasoning and trade-offs.

## When To Use

- Making significant technical decisions that affect system architecture.
- Choosing between frameworks, databases, services, vendors, hosting models, or integration approaches.
- Establishing patterns future development should follow.
- Documenting rationale for constraints or non-obvious approaches.
- Preserving institutional knowledge about past decisions.

## ADR Steps

1. **Assign number and title**: use `ADR-001`, `ADR-002`, etc. when the project already has a sequence. Use a short noun phrase.
2. **Set status**: start with `Proposed` unless the user says the decision is accepted. Track `Accepted`, `Deprecated`, or `Superseded by ADR-XXX` when relevant.
3. **Describe context**: explain the problem, forces, constraints, timeline, cost, team expertise, scale, reliability, compliance, and product needs.
4. **State decision**: use active voice: "We will..." Be specific about what is included and excluded.
5. **Document consequences**: include positive, negative, and neutral outcomes.
6. **List alternatives**: include options considered and why they were not chosen.
7. **Add references**: link related ADRs, spike summaries, docs, tickets, benchmarks, external docs, or source material.

## Template

```markdown
---
artifact: adr
version: "1.0"
created: <YYYY-MM-DD>
status: draft
---

# ADR-[NNN]: [Decision Title]

## Status

[Proposed | Accepted | Deprecated | Superseded by ADR-XXX]

**Date:** [YYYY-MM-DD]
**Deciders:** [List of people involved in the decision]

## Context

[Describe the context and problem statement. Include forces, constraints, timeline, team expertise, cost, scale, reliability, compliance, and product needs.]

## Decision

[State the decision clearly. Use active voice: "We will..."]

## Consequences

### Positive

- [Positive consequence]

### Negative

- [Negative consequence]

### Neutral

- [Neutral implication]

## Alternatives Considered

### [Alternative 1]

[Brief description and why it was not chosen]

### [Alternative 2]

[Brief description and why it was not chosen]

## References

- [Related ADR or document]
- [Research or spike summary]
- [External reference]
```

## Quality Checklist

- Title is short and descriptive.
- Status is clearly indicated.
- Context explains why this decision was needed.
- Decision is stated clearly in active voice.
- Consequences include both positive and negative outcomes.
- ADR can stand alone without requiring meeting memory.
