---
ownerAgent: 1040b336306f
name: market-data
description_zh: 统一 A 股、港股、美股的证券代码、实时报价、OHLCV、币种、时区、复权口径、来源和时效；优先调用免费行情 API，也可读取 CSV/JSON 或已连接的券商数据。
description_en: Normalize A/HK/US symbols, current quotes, OHLCV, currency, timezone, adjustment, provenance, and freshness; prefer free market APIs, while also supporting CSV/JSON and connected broker data.
---

# Market Data

Read for every substantive StockAnalyser route. It owns the shared input and
evidence contract; the other Skills own interpretation.

## API-first source order

1. Use supplied CSV/JSON when the user explicitly asks to analyze it.
2. Any question about the current/latest price, whether a stock is worth buying,
   or an entry range must call `market quote` before any web search. Tencent is
   the free primary quote API and Sina is the automatic fallback.
3. Use `history fetch` for free A/HK/US daily bars. Its pinned AKShare dependency
   is installed automatically in the Skill runner's isolated cache; never run a
   manual package install or package-presence preflight.
4. Use a connected broker only for broker-grade corroboration, account state,
   security rules, or orders. Keep credentials inside the connector boundary.
5. Use targeted exchange, filing, and issuer pages for company facts or events
   missing from providers. Web search snippets never substitute for a quote or
   history API response.

Do not begin web research while a required quote call is still pending. If all
quote providers fail, say that the current price is unverified and do not issue
an exact valuation, entry band, stop, or buy/sell conclusion. A prior close or
auction indication must retain its `quote_kind`, provider time, session, age,
and quality flags.

Never silently mix vendors, currencies, raw and adjusted prices, intraday and
daily bars, or price and total returns.

## Canonical contract

CSV columns: `date,open,high,low,close,volume`; `amount` and `adjusted_close`
are optional. JSON may be the same row array or `{ "bars": [...], "meta": {} }`.
Dates use ISO-8601. Numbers are raw numeric values, not comma/percent strings.
Attach `symbol`, `market`, `currency`, `timezone`, `adjustment`, `source`, and
`as_of` when known. The core sorts dates, rejects duplicates or impossible OHLC,
and emits freshness and coverage flags.

For a screen, use:

```json
{"securities":[{"symbol":"600519.SH","bars":[...],"fundamentals":{"roe":0.31,"pe":24.2}}],"filters":{},"weights":{}}
```

`analyze --symbol <code>` also accepts this universe and selects exactly one
matching security, retaining its `meta` and `fundamentals`. Analysis uses the
record's `source` (or `meta.source`) and `meta.as_of` unless explicitly overridden
by `--source` or `--as-of`; absent sources default to `user-file`.

## Shared core

Run only through the private Skill runner, with one runner command per tool
call:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" market-data market -- quote --symbol 600519.SH
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" market-data history -- fetch --symbol 600519.SH --start 2025-01-01 --end 2026-08-28 --adjust qfq --output history.json
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" market-data stock -- normalize-symbol --symbol 600519
```

`market quote` returns normalized price fields plus source, provider symbol,
provider observation time, retrieval time, market session, quote kind, age, and
quality flags. `history fetch` reports the selected upstream and every fallback
attempt. These free endpoints are best-effort and not exchange-certified feeds;
retain their delay and calendar limitations.

In the final answer, explicitly name the quote source and the selected history
upstream (for example, Tencent and AKShare/Sina), including the history provider
version and adjustment mode. Do not collapse them into a generic “API data”
label: this provenance is part of the result, even when no web research is
needed.

Use absolute input/output paths. A command writes only when `--output` is
explicit. Never join runner commands with `;`, `||`, or an unrelated command
that could mask a nonzero exit. On any validation or provider error, stop that
numeric conclusion and surface the error instead of repairing financial data by
guessing or ad hoc calculation.
