---
ownerAgent: e064dca9e1bd
name: geo-probe
description_zh: "生成品牌/主题的代表性提问，或分析模型回答中的品牌提及率、带来源引用率（SoV）和竞品份额；用于检查 AI 回答是否呈现或引用某品牌，并区分参数记忆提及与真实来源引用。"
description_en: "Generate representative brand/topic questions or score supplied model answers for brand mentions, sourced-citation share (SoV), and competitor share. Use to test whether AI answers surface or cite a brand while distinguishing parametric mentions from sourced citations."
---

# geo-probe

Measure whether AI answer engines surface a brand. Split because a skill can't reach the model providers: this skill generates the queries and scores the answers; **the agent calls the model / `web_search` for each query** and feeds the answers back.

## When to use

- A GEO/visibility pass: "do AI engines mention or cite us, and how do we compare to competitors?"
- After GEO fixes, re-probe to see if mention/citation rates moved.

## When NOT to use

- On-page GEO readiness (citability/structure/entity) — that is `geo-score`, which needs no model calls.
- When you can't make model calls — without answers, `score` has nothing to measure.

## Preconditions

- `queries`: a `seo-crawl` JSON. `score`: an answers payload (below). Python 3.9+ stdlib only. The agent provides model answers between the two ops.

## How to call

1) Generate queries:
```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" geo-probe geo_probe -- --op queries --input <crawl.json> [--brand X] [--domain x.com] [--competitors "A,B"]
```
→ `{ ok, data: { brand, domain, competitors, context_terms, queries:[{query, kind, intent}] } }`

`kind` is `unbranded` (the measurement set) or `branded` (control). **A branded
query cannot measure visibility** — asked "What is <brand>?" a model names the
brand by construction, so counting those rows reports a share of voice the probe
never tested. Branded rows are kept only to separate "nobody recommends us" from
"the model does not know we exist"; keep their `kind` when you feed answers back.

1b) Validate agent- or user-supplied candidates before probing with them:
```
echo '{"brand":"Orkas","domain":"orkas.ai","candidates":["best ai agent tools for teams","..."]}' | "$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" geo-probe geo_probe -- --op filter
```
→ `{ ok, data: { kept:[...], rejected:[{query, reason}] } }`. Rejects a query that
carries the brand or domain core, duplicates, is under 3 or over 12 words, uses a
bare ambiguous acronym (`GEO`, `AEO`, `CRM`… without its expansion — an answer
engine will answer for the wrong industry), or compares AI answer engines rather
than vendors. Every drop names its reason; never discard one silently.

2) The agent asks each query to one or more models / `web_search`, recording `{query, model, mode:"param"|"retrieval", text}` (mode = whether the model retrieved sources or answered from memory).

The `queries` op also returns `context_terms` (distinctive page-vocabulary words). **Pass them through into the score payload** so the brand can be disambiguated from a homonym.

3) Score the answers (pass the payload on stdin or `--input`):
```
echo '{"brand":"Orkas","domain":"orkas.ai","competitors":["Cursor"],"context_terms":["ai","agent","desktop"],"answers":[{"query":"...","model":"...","mode":"retrieval","text":"..."}]}' | "$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" geo-probe geo_probe -- --op score
```
→ `{ ok, data: { share_of_voice, share_of_voice_basis, unbranded, branded_control, share_of_voice_all_answers, citation_rate, brand_mentions, domain_citations, ambiguous_mentions, competitor_share, context_terms, per_answer:[...], data_tier, note } }`

4) Gate off-site references before naming them as the brand's:
```
echo '{"brand":"Floatboat","domain":"floatboat.ai","context_terms":["calendar","agent"],"references":[{"url":"https://www.g2.com/products/floatbot/reviews","title":"Floatbot Reviews 2026"}]}' | "$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" geo-probe geo_probe -- --op disambiguate
```
→ `{ ok, data: { references_checked, citable, verdict_counts, references:[{url, verdict, data_tier, near_miss_tokens, context_hits}], data_tier, note } }`

**Run this on every third-party page, directory, or review listing before the
report calls it the brand's.** `score` gates model *answer* text; this gates the
other channel — pages the agent found itself with `web_search`. Verdicts:
`cited` (domain present) · `corroborated` (brand token + context term) ·
`ambiguous` (brand token alone) · `near_miss` (a token 1–2 edits from the brand)
· `absent`. Only `cited`/`corroborated` may be named as the brand's.

`near_miss` is the trap this op exists for: a listing for a same-sounding
company shares no exact token with the brand, so every equality test reports it
merely `absent` and it reads as irrelevant rather than *wrong*. Report the near
tie as a different entity — do not drop it silently.

## Honesty

- **`share_of_voice` is measured over `unbranded` rows only.** Report it against
  `branded_control`: unbranded 0 with control 1.0 means the brand is recognised
  but never recommended; both near 0 means the answer engines do not know the
  entity at all — a different problem with a different fix. `share_of_voice_all_answers`
  is the un-split number, kept for comparison only; do not headline it. When a
  probe set carried no unbranded row, `share_of_voice_basis` says so instead of
  presenting the branded average as a clean score.
- `share_of_voice` counts only **corroborated product mentions**: the answer cites the domain, OR the brand token appears together with a page-context term. A brand-token hit with no context term and no domain is **`ambiguous`** (likely a homonym, e.g. "Orkas" → orcas/whales) and is excluded from share_of_voice (surfaced as `ambiguous_mentions`). Without `context_terms`, it falls back to counting any brand-token hit.
- `citation_rate` counts sourced domain citations and is the most reliable signal.
- `disambiguate` **cannot return `Measured`**, at any verdict. A page the target site does not control is someone else's statement about it, so an off-site reference is `Estimated` at best and `unverified` when uncorroborated.
- `data_tier` is `Measured` only when every answer came from a retrieval-capable model, otherwise `Estimated`. Always report which it is — never present a parametric-memory mention as a real citation.
