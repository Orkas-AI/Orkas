---
ownerAgent: e064dca9e1bd
name: seo-content
description_zh: "检查 seo-crawl 正文的内容质量与 GEO 就绪度，包括 AI 腔或填充词、统计声明缺少引用、答案前置、长句和标题正文不一致；用于内容质量、E-E-A-T、引用缺口和可读性诊断。"
description_en: "Assess seo-crawl text for content quality and GEO readiness, including filler or AI tone, unsupported statistics, answer-first placement, sentence length, and title/body mismatch. Use for content-quality, E-E-A-T, citation-gap, and readability diagnosis."
---

# seo-content

Heuristic content/GEO-readiness analysis of the visible text from `seo-crawl`. No network. Judgments are heuristic (marked Estimated); raw counts are Measured.

## When to use

- The diagnose flow wants content-quality + GEO-readiness findings alongside the technical audit.
- Pre-publish check for AI tone / uncited claims / answer-first before writing or shipping content.

## When NOT to use

- Technical SEO (indexability/meta/headings) — that is `seo-tech-audit`.
- Rewriting content — the agent's LLM does that in content mode; this only scores/flags.
- Anything needing the full DOM or JS-rendered text (works on the crawl's `text_sample`).

## Preconditions

- A `seo-crawl` JSON whose page includes `text_sample` (the crawler provides it). Python 3.9+ stdlib only.

## How to call

```
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" seo-content content -- --input <crawl.json> [--out <content.json>]
```

`--input` seo-crawl JSON (omit/`-` for stdin); `--out` optional file.

## Expected output

```json
{ "ok": true, "data": {
  "content_score": 88,
  "findings": [ { "id": "ai_tone", "dimension": "content", "severity": "medium",
                  "evidence": "...", "recommendation": "...", "leading_indicator": "...",
                  "failure_criterion": "...", "data_tier": "Estimated" } ],
  "summary": { "total": 1 },
  "meta": { "url": "...", "claims_detected": 0, "ai_phrase_hits": 0, "avg_sentence_words": 0.0, "word_count": 0 } } }
```

Findings use `dimension: "content"` and feed `seo-report --add`. Failure: `{"ok": false, "error": "..."}` on stderr, non-zero exit.

## Heuristics (deterministic)

- **ai_tone**: ≥3 filler/cliché phrases (delve, leverage the power, cutting-edge, …).
- **uncited_claims**: ≥3 statistic/quantity/authority/year claims with 0 outbound links.
- **no_answer_first**: ≥150 words but the opening paragraph is <60 chars (answer not front-loaded — GEO).
- **long_sentences**: average >30 words/sentence.
- **title_body_mismatch**: no significant title term appears in the H1/opening.
