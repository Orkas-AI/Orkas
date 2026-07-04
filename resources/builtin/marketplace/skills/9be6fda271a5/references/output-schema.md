# Output Schema

## Content Organizing Report

```markdown
# Material Organizing Report: [Topic]

> Generated at: YYYY-MM-DD HH:MM
> Total materials: N
> Successfully processed: M
> Processing basis: user-provided materials

## Extraction Overview

| Item | Value |
|---|---:|
| Original materials | N |
| Successfully processed | M |
| Deduplicated/merged | K |
| Final entries | M-K |
| Topic categories | X |

## Topic Directory

| # | Category | Entry count |
|---|---|---:|
| 1 | Topic A | N |
| 2 | Topic B | N |

## Action Items Summary

- [ ] `TODO` [Entry #N] ...
- [ ] `Question` [Entry #N] ...
- [ ] `Idea` [Entry #N] ...

## Topic A

> Topic summary: ...

### 1. Entry Title

| Field | Content |
|---|---|
| Source | URL / filename |
| Author/organization | ... |
| Date | ... |

**Core Points**

1. ... `High`
2. ... `Medium`

**Key Excerpt**

> Original excerpt

**Tags**: `#tag-1` `#tag-2`

## Inbox

Entries that cannot be classified or have insufficient information.

## Cross-Topic Key Insights

1. ...

## Contradiction Log

| Claim A | Source | Claim B | Source | Point to verify |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

## Processing Exception Log

| Entry | Original input | Exception type | Handling |
|---:|---|---|---|
| #N | ... | Cannot access | Skipped and source retained |

## Keyword Index

| Keyword | Entries | Frequency |
|---|---|---:|
| `#tag` | #1, #3 | 2 |
```

Omit empty sections: if there are no action items, inbox entries, contradictions, or exceptions, omit the corresponding section.

## Knowledge Flow Report

```markdown
# Knowledge Flow Report: [Topic]

> Generated at: YYYY-MM-DD HH:MM
> Total materials: N
> Processing basis: user-provided materials
> Intended destination: conversation / Markdown / Notion / Obsidian / other

## Knowledge Cards

### 1. [Card Title]

| Field | Content |
|---|---|
| Source | S1 / filename / URL |
| Date | ... |
| Confidence | High / Medium / Low |
| Tags | `#tag` `#tag` |

**Summary**

...

**Key Points**

1. ...
2. ...

**Applies When**

- ...

**Does Not Apply When**

- ...

**Verification Gaps**

- ...

**Review Prompt**

- ...

## Entity Links

| Entity A | Relationship | Entity B | Source | Confidence |
|---|---|---|---|---|
| ... | ... | ... | S1 | Medium |

## Source Records

| ID | Source | Type | Date | Author / Owner | Access / Quality |
|---|---|---|---|---|---|
| S1 | ... | ... | ... | ... | ... |

## Action Items / Follow-Up Reading

- [ ] ...
```

Omit entity links, action items, or follow-up reading when they are not present in the source material.

## Directory Organizing Report

```markdown
# Directory Organizing Report: [Path]

> Generated at: YYYY-MM-DD HH:MM
> Organizing method: report only / generate script / pending confirmed execution

## Directory Overview

| Item | Value |
|---|---:|
| File count | N |
| Subdirectory count | N |
| Total size | ... |
| File types | ... |

## Type Distribution

| Type | Count | Examples |
|---|---:|---|
| PDF | ... | ... |
| Images | ... | ... |

## Suggested Classification

### Documents
- Representative files:
- Suggested handling:

### Projects
- Representative files:
- Suggested handling:

## Cleanup Suggestions

| Priority | File/pattern | Reason | Suggestion |
|---|---|---|---|
| High | ... | ... | Requires confirmation |

## Important Files Requiring Confirmation

| File | Reason | Suggestion |
|---|---|---|
| ... | Potentially sensitive/important | Move only after user confirmation |

## Suggested Directory Structure

Target/
  Documents/
  Images/
  Projects/
  Archives/
  Review/

## Next Step

1. Save the report.
2. Generate an organizing script.
3. Continue refining a specific category.
```
