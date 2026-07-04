---
name: deep-research
description_zh: "深度研究引擎的确定性脚本组（四个）：caps 计算并强制抓取/成本预算上限；academic 免密钥检索 arXiv/Crossref/OpenAlex/PubMed；compress 按词面重叠去重压缩候选段落；citations 对模型起草的\"论断+引用\"逐条核验——引用原句是否真在被引来源里、DOI 是否规范对得上、来源是否真的抓取过，无来源时 abstain，并产出去重稳定编号的引用列表。不调用模型，同样输入永远同样结果。适合\"跑一轮深度研究检索/压缩\"\"核验这份研究报告的引用有没有编造\"；触发词：深度研究、学术检索、引用核验、防幻觉、anti-fabrication、参考文献、DOI 核验"
description_en: "The deep-research engine's deterministic script suite (four ops): caps computes and enforces fetch/cost budget ceilings; academic searches arXiv/Crossref/OpenAlex/PubMed keylessly; compress de-duplicates and narrows candidate passages by lexical overlap; citations verifies a model's drafted claims-with-citations one by one — does the quote actually appear in the CITED source, is the DOI well-formed and matched, was the source really fetched — abstaining when there are no sources and emitting a de-duplicated, stably-numbered reference list. Calls no model, so the same input always yields the same output. For: 'run a deep-research search/compress pass', 'check this report's citations for fabrication'; Triggers: deep research, academic search, citation check, anti-fabrication, references, DOI verification"
category: data
---

# deep-research

The deterministic half of the research engine. A Python skill cannot reach the
model or the web tools, so the AGENT gathers sources (`web_search` / `web_fetch`)
and drafts the claims-with-citations; this skill does the deterministic steps the
model must not be trusted to perform on its own output. It bounds, retrieves,
compresses, and verifies facts — it does not write the report. Four scripts:

- `caps` — before/during the loop: bound the sub-questions and per-source fetch
  budget, refuse to recurse past a depth limit, and account step cost so the run
  stops at a hard ceiling instead of the GPT-R-style exponential blow-up.
- `academic` — the one retriever that fits a stdlib skill: query public scholarly
  APIs (arxiv / OpenAlex / Crossref / Semantic Scholar) over an https host
  allow-list; each source fails independently, results are normalized to the same
  record shape the other scripts consume.
- `compress` — before synthesis: chunk the fetched sources, drop duplicate/noise
  passages, and keep the most query-relevant text within a char budget, so a long
  page does not blow the context window.
- `citations` — after a draft: verify every quote/DOI/source and build the
  numbered reference list, catching fabrication before the report is shown.

For the broader research method, use `references/research-workflow.md`,
`references/source-quality.md`, `references/evidence-standards.md`,
`references/scholarly-evidence.md`, `references/report-structure.md`, and
`references/citation-style.md`. The references define the research workflow and
reporting standard; the scripts provide deterministic checks inside that
workflow.

## When to use

- `caps`: right after decomposing (op `plan`) to trim/allocate the plan, and
  periodically during gathering (op `account`) to check whether a hard ceiling
  (fetches / model-calls / cost) has been hit.
- `academic`: for scholarly / peer-reviewed questions, to pull papers with DOIs,
  abstracts, and authors from the academic APIs (complements the agent's own
  `web_search` for general web sources).
- `compress`: after fetching sources for a sub-question and before feeding them to
  the model, when the fetched text is large and needs de-noising to fit context.
- `citations`: after the agent has drafted claims-with-citations, to catch
  invented quotes, invented DOIs, and citations to sources that were never
  fetched, and to build the reference list.

## When NOT to use

- Deciding what to research or writing prose — that is the agent's job (model).
- Fetching sources — the agent calls `web_search` / `web_fetch` and passes the
  fetched text in; this skill never touches the network.
- Semantic/embedding relevance ranking — that needs the vector store and is a
  separate core-agent tool, not this stdlib skill. `compress` uses lexical
  (keyword-overlap) relevance only.

## Preconditions

- Python 3.9+ (stdlib only — no third-party packages).
- The agent must pass each source's actually-fetched `text`; a quote can only be
  verified, and a passage only ranked, against text the skill can see.

## How to call

### academic

```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" deep-research academic -- --op search --query "<q>" [--sources arxiv,openalex,crossref,semanticscholar] [--limit 5] [--timeout 30]
```

`data` has `results` (normalized `{id, source, title, text, authors, date, doi, url}`,
de-duplicated across sources by DOI/title), `sources_queried`, and `errors`
(per-source; a rate-limited or slow source is reported here, not fatal — check it
and proceed with what returned). Feed `results` straight into `compress` (as
`sources`) or cite them in `citations`. Talks only to a fixed https host
allow-list and honors `HTTP(S)_PROXY`.

### caps

```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" deep-research caps -- --op plan --input <payload.json>
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" deep-research caps -- --op account --input <payload.json>
```

- `plan` input `{ "subquestions": [".."], "depth"?: 0, "caps"?: {..overrides..} }` →
  `data` with the de-duplicated/trimmed `subquestions`, `fetch_budget_per_subquestion`,
  `allowed` (false + `reason: "max_depth_exceeded"` past the depth limit), and
  `dropped` (`duplicates` + `over_cap`, never silent). Overrides are clamped to
  absolute ceilings so a cap can be lowered but never raised past the safe max.
- `account` input `{ "steps": [ {"step","fetches","model_calls","cost_usd"} ], "caps"? }`
  → `data` with `by_step` + `totals` aggregation, `remaining`, `exceeded`, and
  `stop: true` once any hard ceiling is crossed. `max_cost_usd` is enforced only
  when the agent sets it.

### compress

```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" deep-research compress -- --input <payload.json> [--max-chars 12000]
```

Input `{ "query": "the sub-question", "sources": [ { "id", "url", "title", "text" } ],
"max_chars"?, "max_per_source"?, "min_score"? }`. Output `data.kept` is the ranked
list of `{source, url, title, chunk, chunk_index, score}` within budget, plus
`data.stats` (`chars_in`/`chars_out`/`deduped`/`chunks_kept`/`skipped_compression`).
When the total fetched text already fits the budget, compression is skipped and
whole sources pass through de-duplicated (`score: null`).

### citations

```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" deep-research citations -- --op verify --input <payload.json>
```

- `--op verify` (default): full per-citation verification + supported/unsupported
  per claim + reference list + flags.
- `--op references`: just the de-duplicated numbered reference list.
- `--input <path>`: payload JSON (default stdin). `--out <path>`: also write the
  envelope to a file.

Input payload:

```json
{ "sources": [
    { "id": "s1", "url": "https://…", "title": "…", "date": "2024-05-01",
      "doi": "10.1234/abcd.5678", "text": "the full fetched text …" } ],
  "claims": [
    { "text": "The claim sentence.",
      "citations": [ { "source": "s1", "quote": "exact span from the source",
                       "doi": "10.1234/abcd.5678" } ] } ] }
```

A citation may reference its source by `source` (id) or by `url`. `quote` and
`doi` are optional; a citation with neither is `weak` (the source is real but the
claim is unproven), not flagged.

## Expected output

JSON on stdout. Success:

```json
{ "ok": true, "data": {
  "abstain": false, "abstain_reason": null,
  "summary": { "claims": 2, "supported": 1, "unsupported": 1,
               "citations": 2, "verified": 1, "weak": 0, "flagged": 1 },
  "claims": [ { "text": "…", "supported": true, "citations": [
    { "source": "s1", "url": null, "resolved_by": "id", "url_status": "known",
      "quote_status": "verified", "doi_status": "verified",
      "verdict": "verified", "ref": 1 } ] } ],
  "references": [ { "ref": 1, "title": "…", "url": "…", "date": "…" } ],
  "flags": [ { "claim": 1, "citation": 0, "issue": "quote_not_found_in_source",
               "detail": "…" } ] } }
```

Failure: `{"ok": false, "error": "<reason>"}` on stderr with a non-zero exit
(invalid JSON, or a payload that is not an object).

## Notes

- Quote match is formatting-insensitive (unicode form, smart quotes/dashes, case,
  whitespace) but NOT paraphrase-tolerant: a reworded quote is `not_found`, which
  is the whole point of the guardrail.
- A quote shorter than 12 normalized characters is `too_short` (unprovable), not
  `verified` — reported as `weak`, never as fabrication.
- A DOI must be well-formed AND resolve to the cited source (its `doi` field or a
  match in its fetched text); a well-formed but unresolvable DOI is flagged as a
  likely invention.
- References are de-duplicated by normalized URL and numbered in first-cited
  order; only `verified`/`weak` citations earn a reference.
