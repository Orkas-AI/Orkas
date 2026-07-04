# Knowledge Flow

Use this reference when provided materials need to become reusable personal or team knowledge rather than only a classified reading list.

## Inputs

Accept only materials provided by the user or explicitly pointed to by the user:

- Webpage text, article excerpts, newsletters, or saved links.
- Meeting notes, call summaries, email summaries, chat logs, or decision notes.
- Research fragments, pasted observations, screenshots, Markdown notes, or local files.

Do not read private files, mailboxes, contacts, browser history, note vaults, or workspace content unless the user gives an explicit path, connector, or authorization boundary.

## Extraction

Separate each item into:

- `fact`: directly stated and source-traceable.
- `opinion`: interpretation, preference, recommendation, or subjective evaluation.
- `decision`: accepted choice, rejected option, owner, date, and rationale.
- `action`: task, owner, due date, dependency, and status when present.
- `question`: unresolved issue or missing information.
- `claim_to_verify`: important claim without enough evidence, outdated context, or unclear source.

If the source does not provide a date, author, owner, metric, or link, write `not provided`.

## Knowledge Card

Each card should be short enough to reuse later:

```markdown
### [Card Title]

- Summary:
- Why it matters:
- Key points:
  1. ...
  2. ...
- Entities:
- Relationships:
- Tags:
- Source:
- Date:
- Confidence:
- Applies when:
- Does not apply when:
- Verification gaps:
- Review prompt:
```

Guidelines:

- Prefer one card per reusable concept, decision, process, tool, product, person, organization, or question.
- Keep source references in every card. Use filenames, URLs, page titles, timestamps, or user-provided source labels.
- Use tags that are durable and easy to retrieve, not one-off decorative tags.
- Mark high-recency topics for recheck when they involve prices, policies, product features, laws, schedules, or company facts.

## Entity Links

Return a compact relationship list when useful:

```markdown
| Entity A | Relationship | Entity B | Source | Confidence |
|---|---|---|---|---|
| ... | supports / competes with / owns / depends on / caused by / used for | ... | ... | High |
```

Only include relationships supported by the source material. Do not infer hidden relationships from similar names.

## Source Records

Keep a source ledger:

```markdown
| ID | Source | Type | Date | Author / Owner | Access / Quality |
|---|---|---|---|---|---|
| S1 | ... | webpage / meeting / email / note / file | ... | ... | readable / partial / inaccessible |
```

Use source IDs inside knowledge cards when the report has many sources.

## Review Prompts

Create review prompts that help the user remember or reuse the material:

- A recall question for the main concept.
- A transfer question for applying the idea to the user's work.
- A verification reminder for claims that may become stale.
- A follow-up reading or action when it is explicit in the source.

Avoid generic prompts such as "review this later" unless no better prompt is available.
