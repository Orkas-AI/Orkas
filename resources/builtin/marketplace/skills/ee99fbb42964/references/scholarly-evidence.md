# Scholarly Evidence Support

Use this reference when a broader research task depends on academic papers, preprints, datasets, or formal citations. Keep the goal tied to the research question: paper discovery and citation cleanup support the synthesis, but they do not replace reading and evaluating the evidence.

## When To Use

- The research plan includes a literature review, evidence map, systematic scan, or academic source comparison.
- The user provides DOI, PMID, PMCID, arXiv ID, paper titles, author names, bibliography text, BibTeX, RIS, or paper URLs as evidence inputs.
- The final report needs verified references, clean citation metadata, open-access clues, or a reproducible search trail.

Do not use this reference for a standalone single-paper reading task, a simple DOI-to-BibTeX conversion, or bibliography formatting without research synthesis.

## Query Strategy

1. Identify the query type:
   - Known identifier: DOI, PMID, PMCID, arXiv ID, OpenAlex ID, ORCID, ISSN.
   - Known work: exact title, author, venue, year.
   - Topic search: keywords, date range, discipline, source type, inclusion/exclusion criteria.
   - Bibliography cleanup: BibTeX, RIS, raw references, or mixed identifiers.

2. Choose sources:
   - DOI metadata: Crossref or DataCite.
   - Biomedical research: PubMed; use PMC when full text is needed and available.
   - Physics, math, computer science, statistics, and related preprints: arXiv.
   - Cross-disciplinary search: OpenAlex or Semantic Scholar.
   - Open-access status and PDF clues: Unpaywall or CORE.
   - Citation relationships and author graphs: OpenAlex or Semantic Scholar.

3. Record reproducibility details:
   - Database or API name.
   - Endpoint or search method.
   - Query string, filters, and date range.
   - Query date.
   - Result count and selection criteria.
   - Rate limits, failures, missing API keys, or access limits.

## Identifier Checks

- DOI: starts with `10.` and should resolve through a DOI resolver or metadata source.
- PMID: numeric PubMed identifier.
- PMCID: `PMC` followed by digits.
- arXiv ID: modern form like `YYMM.NNNNN`, with optional version suffix.
- ORCID: four hyphen-separated groups such as `0000-0002-1825-0097`.
- ISSN: two groups of four characters separated by a hyphen.

When title or author search finds a candidate, treat it as uncertain until a stable identifier, venue, year, and author list match. Flag suspected mismatches instead of silently accepting them.

## Evidence Handling

- Metadata is not evidence by itself. Use it to locate the work, then check the abstract, methods, findings, limitations, or relevant full-text passages before citing it as support.
- Prefer primary sources for claims about study results, methods, datasets, or official statistics.
- Prefer recent reviews, meta-analyses, guidelines, and consensus reports for field-level summaries, while still checking what they include and exclude.
- Distinguish peer-reviewed articles, preprints, conference papers, books, datasets, software, reports, and commentary.
- For medical, legal, financial, policy, and other high-stakes topics, state that the report is informational and identify where professional review is needed.

## Citation Cleanup

1. Generate or normalize citation metadata:
   - Authors, title, year, venue, volume/issue/pages, DOI, URL, access date, publisher, and source database.
   - Select the entry type: article, conference paper, book, chapter, preprint, dataset, software, report, or web page.

2. Deduplicate:
   - Prefer DOI, PMID, PMCID, or arXiv ID matching.
   - Without stable identifiers, compare normalized title, first author, year, and venue.
   - For preprint and published versions, preserve both when they support different claims or when the relationship is uncertain.

3. Validate:
   - Check identifier resolution.
   - Flag missing required fields.
   - Flag inconsistent years, venues, author order, preprint/published-version conflicts, and suspected title mismatches.
   - Keep old and new values visible for content-level fixes.

4. Output:
   - Provide the cleaned references in the requested style or file format when possible.
   - Include a short validation table with errors, warnings, and items needing human review.

## Report Insert

For research reports with scholarly evidence, include a compact search trail:

```markdown
## Scholarly Search Trail
| Source | Query / Identifier | Filters | Result Count | Used | Notes |
|---|---|---|---:|---:|---|
| PubMed | ... | 2021-2026 | 42 | 8 | ... |

## Citation Quality Notes
| Reference | Status | Issue | Action |
|---|---|---|---|
| ... | verified | DOI resolves | cited |
| ... | warning | title match only | needs confirmation |
```

When evidence is thin, say so plainly and recommend the next query or source needed.
