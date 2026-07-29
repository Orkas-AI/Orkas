# Editorial quality system

Use this reference for revision, humanization, and publication review. Preserve meaning and evidence before improving elegance.

## Contents

1. Preservation contract
2. Voice fingerprint
3. Four editing passes
4. Humanization diagnostics
5. Quality gate

## Establish the preservation contract

Before rewriting, identify what must remain unchanged:

- factual meaning, scope, certainty, and chronology.
- thesis, reader promise, argument, and required call to action.
- citations and the claim each citation supports.
- quoted wording, names, numbers, technical terms, disclosures, and compliance language.
- intentional brand vocabulary and author-specific quirks.
- requested length tolerance and formatting constraints.

List allowed transformations separately: reorder sections, tighten repetition, simplify language, alter point of view, change headline, or reduce length. When the user asks only to humanize, do not silently perform a substantive argument rewrite.

For a `supplied-only` revision, freeze the complete supported claim set, not just names and numbers. Preserve every source clause that carries a limitation or boundary; brevity is not permission to delete it. Treat “supports X; does not support Y” and equivalent paired boundaries as one atomic claim: the artifact must retain both the positive scope and the exclusion. User requests such as “one sentence,” “be concise,” or “do not explain the process” control presentation, not the claim set; write the limitation inside the artifact. Avoid unsupported bridge language such as "provides a foundation," "shows potential," "offers an initial signal," or generic next-step recommendations. A limitation may narrow a supplied claim; it must not smuggle in a new implication.

Compare the final artifact against the source, not against memory. Use a clause-coverage pass: map every frozen fact, scope, limitation, citation, and disclosure to explicit final wording, then separately search for additions. Check exact numbers/dates, citation markers, disclosures, named entities, certainty, and source status. Treat a new transition or recommendation as a claim delta even when it sounds cautious.

## Build a voice fingerprint

Use 2-5 representative samples when available. Prefer samples from the same author, audience, and channel. Do not infer a stable voice from a single short sentence.

```markdown
| Dimension | Observed pattern | Confidence | Apply |
|---|---|---|---|
| sentence rhythm | short openings, longer explanatory follow-up | high | preserve contrast |
| stance | direct, mildly skeptical | medium | avoid sales certainty |
| diction | plain technical language | high | keep domain terms; cut buzzwords |
| transitions | implicit between short sections | medium | avoid formulaic connectors |
| punctuation | parentheses, few dashes | high | match frequency, not a blanket ban |
| paragraph shape | 2-4 sentences | medium | vary only when the argument needs it |
| taboo patterns | emojis, motivational closers | high | exclude |
```

Capture point of view, formality, sentence-length distribution, preferred verbs/nouns, paragraph openings, transition style, punctuation habits, humor or edge, use of questions, heading style, examples, and recurring phrases. Match the author's choices without introducing opinions or experiences absent from the source.

When no sample exists, default to clear, concrete, reader-aware prose. Use neutral plain language for reference, technical, legal, medical, and policy content. Do not inject personality merely to appear human.

## Run four distinct passes

### Developmental edit

- Restate the reader promise and thesis from the draft; flag drift.
- Give every section one necessary job. Merge duplicate sections and remove throat-clearing.
- Check that each section answers the question established by its heading or transition.
- Move context before conclusions only when the reader needs it; otherwise lead with the useful point.
- Test counterarguments, missing steps, examples, and boundary cases.
- Make the conclusion resolve the reader promise or give a specific next action. Do not merely recap headings.

### Evidence edit

- Match each material claim to its ledger entry and source.
- Confirm citation entailment, not just topical relevance.
- Check names, dates, quantities, units, denominators, product tiers, geographies, and time ranges.
- Compare headline, summary, charts/tables, body, and conclusion for contradictions.
- Preserve uncertainty and source limitations.
- Test every new transition, implication, recommendation, and forward-looking sentence as a claim. Delete it when the supplied evidence does not support it.
- Remove draft scaffolding from the final artifact. Labels such as `结尾:`, `Introduction:`, TODOs, and revision instructions belong in notes or disappear.
- Flag causal language, superlatives, universals, forecasts, and competitive comparisons for stronger review.
- When handing off a contradiction repair, make the correction auditable: record `old value/claim → accepted value/claim` and cite the source or evidence boundary that wins. “Preserved the supported fact” alone does not document what changed.

### Line edit

- Prefer concrete subjects and verbs over abstract noun chains.
- Put actors in sentences when agency matters.
- Keep terminology stable; repeat the clearest term instead of cycling synonyms.
- Vary sentence and paragraph length in service of emphasis, not random burstiness.
- Replace generic transitions with the actual logical connection or remove them.
- Cut filler that delays the point, but preserve necessary nuance.
- Read transitions across paragraphs, not just sentence grammar in isolation.

### Copy edit

- Standardize names, capitalization, heading case, dates, numbers, units, quotations, and link style.
- Check every link target and anchor description.
- Resolve placeholders, comments, duplicated words, unmatched brackets, and stale instructions.
- Preserve required disclaimers and disclosure placement.
- Keep manual findings visibly separate from automated output. Use `MANUAL PREFLIGHT — SCRIPT NOT RUN` when the deterministic script was unavailable.
- Verify that tables render and that headings form a coherent hierarchy.

## Diagnose model-like prose contextually

Treat these as review signals, not proof of AI authorship and not automatic deletion rules:

| Signal | Typical problem | Better response |
|---|---|---|
| significance inflation | ordinary fact is framed as pivotal or transformative | state the concrete consequence or remove the claim |
| promotional filler | praise substitutes for evidence | add a specific supported attribute or use neutral wording |
| vague attribution | "experts" or "studies" have no traceable source | name and cite the source or remove the authority claim |
| superficial analysis | trailing participle or abstract sentence claims meaning without evidence | explain the mechanism with evidence or cut it |
| forced symmetry | repeated triads, not-only/but-also frames, or identical paragraph shapes | use the number and structure the idea actually needs |
| synonym cycling | one entity receives many ornamental names | repeat the clearest term |
| generic signposting | "let's dive in" or "here's what you need to know" delays the content | begin with the useful point |
| uniform cadence | every sentence has similar length and syntax | vary rhythm around meaning and emphasis |
| generic conclusion | "the future is bright" or a heading recap adds no decision | resolve the thesis, name uncertainty, or give a next step |
| chatbot residue | greetings, praise, offers to continue, or process commentary leak into the artifact | remove correspondence that is not part of the piece |

Removal means deletion from the entire response, not repetition inside “do not say,” a rebuttal, a joke, change notes, or editorial commentary. If the unsupported sentence has no supported payload, delete it without a replacement. Before delivery, use the removed claims as a semantic blacklist: neither the phrase nor a synonym/paraphrase may survive. A negated unsupported slogan is still unnecessary slogan text.

For a narrowly scoped artifact-first rewrite or humanization, the artifact is the whole response unless the user asks for notes. Do not append a change log, process explanation, audit label, or publication decision merely because the broader workflow supports those outputs.

Also inspect overuse of abstract buzzwords, em/en dashes, title-case headings, bold labels, emojis, passive constructions, rhetorical questions, parenthetical asides, and listicles. Retain them when they fit the author and improve comprehension. A rigid ban often replaces one synthetic pattern with another.

After the first rewrite, perform a cold second pass:

1. Compare against the preservation contract.
2. Search for remaining pattern clusters, not isolated words.
3. Read several paragraphs aloud or simulate the pauses.
4. Check whether added specificity came from sources or was invented.
5. Confirm the piece still sounds like its intended author and channel.

## Apply the quality gate

Rate each dimension `PASS`, `FIX`, or `BLOCK` and cite a concrete location for every non-pass result.

| Dimension | Pass condition |
|---|---|
| brief alignment | serves the stated reader, promise, channel, and action |
| argument and structure | thesis is coherent; sections are necessary and ordered |
| evidence integrity | material claims are supported and accurately scoped |
| usefulness | includes sufficient specificity, examples, or decisions for the reader |
| voice and readability | matches the intended voice without formulaic clusters or loss of nuance |
| copy integrity | names, numbers, links, formatting, disclosures, and placeholders are clean |

Set the publication decision:

- `READY`: all dimensions pass; only optional preference edits remain.
- `READY AFTER FIXES`: no blocking issue; named fixes can be completed without new owner or expert judgment.
- `HOLD`: any fabricated/unsupported high-risk claim, critical source mismatch, unresolved material contradiction, required disclosure failure, or qualified-review requirement remains.

Render exactly one decision token and validate it before delivery. A bare token or `Publication decision: TOKEN` / `发布决定：TOKEN` is valid; do not append other prose or stray characters on that line, combine two statuses, or use `READY AFTER FIXES` when the delivered artifact already contains all fixes.

For citation mismatch, distinguish three objects: the rejected original claim, the safe replacement, and the evidence required to restore the stronger version. State whether the final decision applies to the delivered replacement.

Do not average away a blocking issue with strong prose scores.
