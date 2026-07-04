# Dedup Strategy

## Dedup Triggers

Any of the following conditions triggers deduplication review:

- The source URL or file path is exactly the same.
- Titles are identical or highly similar.
- Core points overlap by more than 70%.
- The filename indicates a duplicate copy, such as `copy`, ` 2`, ` 3`, `(1)`, `(2)`, or `duplicate`.

## Merge Rules

Cross-source content may be merged into one entry, but all sources must be preserved:

```markdown
### Merged Title

- **Primary source**:
- **Merged sources**:
- **Core points**:
- **Reason for keeping**:
- **Merge note**: merged with entry #N; similarity is ...
```

## Do Not Merge

Do not force a merge in the following cases:

- Sources hold opposing views or key data conflicts.
- The time span exceeds 2 years and may reflect how views changed over time.
- Official sources are mixed with personal commentary and credibility differs significantly.
- The user explicitly asks to keep all entries.
- Only the titles are similar, while the body topics are different.

## Contradiction Log

When conflict appears under the same topic, show claims side by side and do not judge prematurely:

```markdown
| Claim A | Source | Claim B | Source | Point to verify |
|---|---|---|---|---|
| ... | Entry #1 | ... | Entry #4 | ... |
```

## Dedup Statistics

Output in the overview:

- Original entry count.
- Deduplicated/merged count.
- Final entry count.
- Conflict entries kept.
