---
ownerAgent: 1040b336306f
name: security-research
description_zh: 对 A 股、港股、美股做可追溯的个股研究与横截面筛选，整合价格技术面、基本面、估值、事件、催化剂和反证，不把缺失数据包装成结论。
description_en: Perform traceable A/HK/US security research and cross-sectional screening across technicals, fundamentals, valuation, events, catalysts, and contrary evidence without masking missing data.
---

# Security Research

Read with `market-data` for a company thesis, comparison, factor screen, or
watchlist. The goal is a decision-ready evidence map, not a forced rating.

## Research contract

- Lock security, listing, market, horizon, currency, and comparison set.
- Prefer filings, exchange notices, and issuer releases for current business
  facts. Distinguish filing period from retrieval date.
- Separate business quality, growth, balance sheet, cash generation, valuation,
  price/volume behavior, ownership/liquidity, and event risk.
- Reconcile conflicts rather than averaging them away. Missing a field lowers
  coverage; it is not neutral or zero.
- End with base/bull/bear cases, catalysts, invalidation conditions, and the
  next evidence that would change the view.

Run deterministic time-series and supplied-fundamental analysis:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" market-data stock -- analyze --input history.json --symbol 600519.SH --source user-file
```

Run a cross-sectional screen:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" market-data stock -- screen --input universe.json
```

For a requested historical price cutoff, use `--cutoff YYYY-MM-DD` on `analyze`
or `screen`. The core selects bars in memory, preserves the source file and
reports excluded-bar counts. `--as-of` alone remains strict validation and
rejects later bars. Neither option proves point-in-time availability of
fundamentals or universe membership; keep those evidence gaps explicit.

The screen uses only covered factors, reports eligibility and coverage, and
produces a relative research priority—not a buy/sell instruction. Explain each
rank through its factor components and name survivorship, point-in-time, FX,
and sector-comparability limits when applicable.

For event/news questions, retrieve fresh evidence; do not infer today's event
state from historical bars. Rumors remain labeled and never override filings.
