---
ownerAgent: 1040b336306f
name: portfolio-risk
description_zh: 评估持仓权重、集中度、波动、回撤、历史 VaR/CVaR、行业与币种暴露及情景冲击，并把风险来源转化为可审查的约束与再平衡建议。
description_en: Assess weights, concentration, volatility, drawdown, historical VaR/CVaR, sector and currency exposure, and scenario shocks, then turn risk sources into reviewable constraints and rebalance options.
---

# Portfolio Risk

Read with `market-data` for a portfolio review, stress test, or rebalance
question. Keep account values and holdings private and use only what is needed.

Choose the calculation from the supplied data: `--mode historical` (default)
requires aligned daily decimal returns; `--mode scenario` uses weights and
declared shocks, returns no historical statistics, and needs no return series.
Do not manufacture a series to make a scenario request fit historical mode.

Historical input uses weights that sum to one and aligned daily decimal returns:

```json
{"positions":[{"symbol":"700.HK","weight":0.4,"currency":"HKD","sector":"Technology","returns":[0.01,-0.02]}],"scenarios":{"tech_down":{"Technology":-0.15}}}
```

Run:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" market-data stock -- portfolio-risk --input portfolio.json --confidence 0.95
```

The core calculates portfolio return series from aligned observations, annual
volatility, max drawdown, historical VaR/CVaR, HHI and top-name concentration,
sector/currency exposure, and declared linear scenario losses. VaR is a sample
statistic, not a loss ceiling.

For weight-only concentration or declared stress, use the same command with
`--mode scenario`. For simultaneous local-price and FX shocks, supply weights
already measured in `base_currency` NAV and a compound scenario:

```json
{"base_currency":"USD","positions":[{"symbol":"700.HK","weight":1,"currency":"HKD"}],"scenarios":{"stress":{"local":{"700.HK":-0.1},"fx":{"HKD":-0.05}}}}
```

The core multiplies local and FX returns and also reports their separate
contributions. Unspecified shocks are zero assumptions; the base currency
cannot move against itself. Prepare this structured input from supplied facts
without changing the source or inventing currency conversions. If the weight
basis is unknown, resolve it before a cross-currency calculation.

Review missing positions, stale prices, derivatives, leverage, FX translation,
liquidity, tax lots, and correlation regime change before recommending action.
Frame rebalance ideas as constraint-aware options with trade-offs. Do not
silently normalize invalid weights, fabricate correlations, or assume an
investor's suitability, tax status, or loss capacity.
