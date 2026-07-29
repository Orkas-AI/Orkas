# Audit and delivery

Use this reference for deterministic preflight, publication decisions, audit
reports, and handoff formatting. Load the separately routed editorial-quality
reference when substantive revision or humanization is also required.

## Contents

1. Deterministic preflight
2. Finding classifications
3. Publication decision
4. Delivery contracts
5. Audit template

## Run deterministic preflight

Exception for a plainly unsafe high-stakes input: when an unsupported universal
dosage, cure, professional-bypass, legal, financial, regulatory, or safety
claim makes the correct decision immediately `HOLD`, do not persist the blocked
input as `ARTICLE.md` or any other deliverable merely to run preflight. The
script cannot validate truth and the input file would itself be an unsafe
artifact. Skip the runner, label the audit
`MANUAL PREFLIGHT — SCRIPT NOT RUN`, and return the `HOLD` decision, specific
risks, a safe replacement, and the qualified-review requirement.

When local execution is available, request `ARTICLE.md` through `write_file`.
Treat the successful tool result as the path authority: when it emits
`<file-renamed>`, use the exact `Saved as:` path as a quoted literal in the
audit command. Never run, read, edit, or delete the originally requested name
after that collision. Then run exactly once:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" content-writer audit_content -- ARTICLE.md --format markdown
```

For source comparison, request `REWRITE.md` and `SOURCE.md` through separate
`write_file` calls. Apply the same collision rule independently and pass each
reported final path to the command:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" content-writer audit_content -- REWRITE.md --source SOURCE.md --format markdown
```

A path reported by `write_file` is safe to quote directly. Do not reconstruct
paths with shell variables, command substitution, globs, or dynamic
redirection. Do not invoke the script through a relative Python path.

The script identifies editorial leads: placeholders, numeric/date claims,
weak attribution, links, citation-marker presence, and style-pattern clusters.
It cannot determine truth, source entailment, plagiarism, or authorship.
Verify those separately. The source comparison is lexical and does not replace
a semantic evidence edit.

Resolve added or missing numbers, citation markers, disclosures, changed
sponsor/funder identities, and new bridge-claim candidates before delivery.
When execution is unavailable, put `MANUAL PREFLIGHT — SCRIPT NOT RUN` above
manual audit-shaped findings.

## Classify findings

- `BLOCK`: material falsehood, unsupported high-risk claim, fabricated
  citation/quote, broken required disclosure, or critical contradiction.
- `FIX`: unsupported material claim, source mismatch, stale fact, broken link,
  misleading certainty, or unresolved placeholder.
- `REVIEW`: subjective voice, owner decision, access-limited source, or
  noncritical ambiguity.
- `PASS`: checked and supported within the stated evidence policy.

Use `BROKEN`, `FETCH_FAILED`, or `ACCESS_BLOCKED` as link sub-statuses. Never
turn an unverifiable claim into confident prose to make the draft read cleanly.

## Decide publication readiness

Judge the delivered artifact after applied edits:

- `READY`: every blocking and fixable issue is resolved.
- `READY AFTER FIXES`: named fixes still remain but require no new owner or
  expert judgment.
- `HOLD`: any blocking issue, required disclosure failure, unresolved material
  evidence gap, contradiction, or qualified-review requirement remains.

Emit exactly one decision token—`READY`, `READY AFTER FIXES`, or `HOLD`—alone
or after `Publication decision:` / `发布决定:` with nothing else on that line.
Put explanation later. Do not use `READY AFTER FIXES` when the delivered
artifact already includes all fixes.

Before delivery, check for malformed or duplicate decision tokens, dropped
source clauses/citations/disclosures, unsupported bridge claims, and duplicate
primary CTA destinations.

## Apply delivery contracts

Put the requested artifact first. For an artifact-first rewrite, `humanize`, or
`adapt` request that does not request an audit or handoff, return only the
finished artifact: no process narration, evidence labels, change notes, offers,
or publication decision.

For every newsletter adaptation, make the first non-empty line a distinct
subject, then body, then the requested CTA. A body lead is not a subject. If a
source sentence only supplies the CTA destination, merge it into the CTA and
count the literal destination exactly once.

Append this handoff only when useful:

```markdown
## Editorial handoff
- Evidence policy:
- Material assumptions:
- Must-fix claims:
- Owner-review items:
- Publication decision: READY / READY AFTER FIXES / HOLD
```

For plan or research packs, return the brief, thesis, reader promise, outline,
source ledger, claim ledger, and unresolved gaps. Omit empty sections.

## Use the standalone audit template

```markdown
# Content audit

## Original finding
BLOCK / FIX / REVIEW / PASS

## Safe replacement
...

## Evidence required for the stronger claim
- Population/scope:
- Exposure/intervention and comparator:
- Measured outcome and method:
- Time window:

## Decision for the delivered replacement
READY / READY AFTER FIXES / HOLD

## Must fix
| Location/claim | Status | Evidence | Required action |
|---|---|---|---|

## Review
| Location/claim | Why review | Recommendation |
|---|---|---|

## Passed and limits
- ...
```
