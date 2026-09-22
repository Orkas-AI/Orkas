---
name: ecommerce-analytics
description_zh: "分析跨平台销售、费用、退款、广告和库存导出，交付可复算的经营指标、变化原因与行动优先级；用于店铺经营复盘、利润和渠道分析，不负责选品或在线修改。"
description_en: "Analyze cross-platform sales, fees, refunds, ads and inventory exports to deliver reproducible operating metrics, drivers and priorities. Use for store performance, contribution profit and channel analysis, not product selection or live changes."
category: ecommerce
---

# Ecommerce Analytics

1. Identify the business decision, sources, period, currency, timezone and data freshness. Start from supplied exports; there is no mandatory data service.
2. Read [reconciliation and metrics](references/metrics.md). Establish row grain and source definitions before joining or calculating. Preserve missing values and unmatched records.
3. Use available local computation for multi-row arithmetic; keep a reproducible calculation or query with the source/field map. Inspect totals and counterexamples, not only a chart.
4. Compare like periods, products and channels. Separate volume, price, mix, acquisition, refund and cost effects where the data supports them. Describe causal explanations as hypotheses unless independently established.
5. Deliver the requested metrics and main drivers with formulas, reconciliation, sources, prioritized actions and the smallest missing inputs. A missing cost category limits profit interpretation rather than blocking all supported sales analysis.

For platform exports read [channel mapping](references/channel-mapping.md). This package provides analytical methods; it does not install a platform API, infer account access or execute store changes.
