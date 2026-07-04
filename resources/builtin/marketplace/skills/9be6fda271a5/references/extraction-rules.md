# Extraction Rules

## Anti-Hallucination Constraints

- All core points must come from the original text or file content. Do not add, infer, or fabricate.
- Key excerpts must quote the original text verbatim and be marked with quote blocks. Do not rewrite them into sentences that merely look like the original.
- Numbers, dates, percentages, prices, authors, organizations, and version numbers must match the source.
- When information is insufficient, mark `insufficient information`; do not fill it in.
- Every point must be traceable to a source entry number or filename.

## Material Types

### URL

Read the body text and ignore navigation, ads, and footers. Record title, author/organization, publication date, URL, and access exceptions.

Common routing:

- Articles/blogs: title, core argument, method, conclusion.
- Video pages: title, description, accessible subtitles/summary.
- GitHub repositories: README, purpose, language, maintenance status, installation or usage essentials.
- News/information: event, time, impact, views from different parties.
- Tools/products: features, target users, price, pros/cons, alternatives.

### PDF

Extract text and section structure. Prioritize abstract, preface/introduction, conclusion, figure/table captions, and appendix summary. Scanned files or low-confidence OCR content must be marked.

### Word / Markdown / Text

Preserve heading hierarchy and extract summaries, key paragraphs, bold/highlighted content, action items, and cited sources.

### Images

Identify the main text in screenshots or charts. If it is a chart, record chart type, readable values, trends, and anything that cannot be confirmed.

## Core Points

Extract at most 5 core points from each material item, in this priority order:

1. Core conclusion or claim.
2. Key data, dates, statistics, or experimental results.
3. Method, framework, steps, or mechanism.
4. Limits, counterexamples, risks, or applicable conditions.
5. Further reading, reusable resources, or action items.

## Evidence Levels

- `High`: multiple independent sources agree; official/original data; experimental results; reproducible evidence.
- `Medium`: single credible source; indirect evidence; author explanation without independent verification.
- `Low`: personal experience; speculation; marketing claims; unverified opinion.

## Annotation Tags

- `Question`: a question that needs verification or an unresolved doubt.
- `TODO`: a follow-up action the user can take.
- `Idea`: an idea that can be transferred to the user's project or workflow.
- `Disagreement`: a factual, data, or conclusion conflict with other entries.

## Excerpts

- At most 2 excerpts per material item.
- Excerpts should usually be 20-150 words.
- English original text may be preserved in English and accompanied by a brief Chinese explanation when useful.
- A sentence without a confirmable source must not be used as an excerpt.
