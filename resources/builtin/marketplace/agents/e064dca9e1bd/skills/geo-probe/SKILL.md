---
ownerAgent: e064dca9e1bd
name: geo-probe
description_zh: "GEO 可见性探针（两段式）：op=queries 从页面主题+品牌生成代表性提问；op=score 解析一组模型回答，统计品牌提及率、带来源引用率(SoV)与竞品份额，诚实区分参数记忆提及与来源引用；模型回答由 agent 用自己的模型/web_search 提供；适合\"测一下 AI 里能不能搜到这个品牌\"\"AI 引用份额\"；触发词：GEO 探针、AI 可见性、品牌提及、SoV、份额、AI 引用率"
description_en: "GEO visibility probe (two ops): op=queries generates representative prompts from the page topic+brand; op=score parses a set of model answers into brand-mention rate, sourced-citation rate (SoV) and competitor share, honestly separating parametric mentions from sourced citations; the agent supplies the model answers (its own model / web_search); For: 'check if AI engines surface this brand', 'AI citation share'; Triggers: GEO probe, AI visibility, brand mention, SoV, share of voice"
category: data
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
→ `{ ok, data: { brand, domain, competitors, queries:[...] } }`

2) The agent asks each query to one or more models / `web_search`, recording `{query, model, mode:"param"|"retrieval", text}` (mode = whether the model retrieved sources or answered from memory).

The `queries` op also returns `context_terms` (distinctive page-vocabulary words). **Pass them through into the score payload** so the brand can be disambiguated from a homonym.

3) Score the answers (pass the payload on stdin or `--input`):
```
echo '{"brand":"Orkas","domain":"orkas.ai","competitors":["Cursor"],"context_terms":["ai","agent","desktop"],"answers":[{"query":"...","model":"...","mode":"retrieval","text":"..."}]}' | "$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" geo-probe geo_probe -- --op score
```
→ `{ ok, data: { share_of_voice, citation_rate, brand_mentions, domain_citations, ambiguous_mentions, competitor_share, context_terms, per_answer:[...], data_tier, note } }`

## Honesty

- `share_of_voice` counts only **corroborated product mentions**: the answer cites the domain, OR the brand token appears together with a page-context term. A brand-token hit with no context term and no domain is **`ambiguous`** (likely a homonym, e.g. "Orkas" → orcas/whales) and is excluded from share_of_voice (surfaced as `ambiguous_mentions`). Without `context_terms`, it falls back to counting any brand-token hit.
- `citation_rate` counts sourced domain citations and is the most reliable signal.
- `data_tier` is `Measured` only when every answer came from a retrieval-capable model, otherwise `Estimated`. Always report which it is — never present a parametric-memory mention as a real citation.
