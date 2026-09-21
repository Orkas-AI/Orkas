---
ownerAgent: 1040b336306f
name: investment-report
description_zh: 把研究、筛选、回测、组合或订单校验结果压缩为带来源、时点、质量标记、情景、风险和失效条件的看板；按需生成可归档的 Markdown 报告。
description_en: Compress research, screen, backtest, portfolio, or order-validation results into a dashboard with provenance, as-of, quality, scenarios, risks, and invalidation conditions, with optional archival Markdown.
---

# Investment Report

Read when the user requests a synthesis, comparison, handoff, or durable report.
Do not rerun unrelated analysis merely to fill a template.

## Chat dashboard

Lead with the decision question and evidence time. Then show:

1. scope: symbol/listing, market, horizon, currency, and adjustment;
2. evidence: sources, as-of times, quality flags, and missing coverage;
3. result: the smallest useful metric table and plain-language interpretation;
4. scenarios: connect each base/bull/bear or declared stress case to its
   supporting evidence, catalysts, and evidence that would weaken or reverse it;
   a shared condition may cover several cases when its scope is clear;
5. downside: risks and conflicting evidence;
6. method: calculation/backtest assumptions and limitations;
7. action: identify the next verification priority and how it could change the
   interpretation; several ordered or jointly necessary sources are valid. For
   trading, retain the constraint-aware option or validated order draft.

Keep calculated, provider-reported, user-provided, estimated, and model-inferred
items visibly distinct. If evidence is missing, state what cannot yet be
determined and what would resolve it; do not invent facts or numerical
thresholds to complete a scenario. Preserve units and never compare currencies
without an explicit FX basis.

## Durable report

Only when requested, assemble a JSON dossier and render stable Markdown:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" market-data stock -- render-report --input dossier.json --evidence-input source.json --output STOCK-ANALYSIS.md
```

Pass each original source or core-result file with repeated `--evidence-input`.
The renderer carries its declared source, observation/export and retrieval
times into a snapshot section with a content digest; it does not rely on copied
dates in the dossier. This applies equally to quotes, histories, calculations
and exported order receipts. Qualify status and cash claims at the record's
time, and leave later state unknown without a fresh read. Missing dates stay
unknown. Keep source/core files separate from the interpretive dossier.

The dossier may contain `title`, `scope`, `evidence`, `summary`, `metrics`,
`scenarios`, `risks`, `limitations`, and `next_steps`. The renderer escapes
tables and preserves source/as-of labels; it does not invent content. Preserve
the scenario-to-evidence links and verification priorities above in the dossier,
so they reach the report rather than appearing only in the chat handoff.

Name the created artifact and checks run. For an order, keep the exact visible
draft and validation decision in chat even when a report is also written.
