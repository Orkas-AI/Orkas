---
ownerAgent: 1040b336306f
name: quant-lab
description_zh: 把投资想法变成可复现的策略实验，执行带基准、手续费、滑点、信号延迟和样本边界的回测，并审查未来函数、过拟合与稳健性。
description_en: Turn an investment idea into a reproducible strategy experiment with benchmark, fees, slippage, signal delay, sample boundaries, and explicit leakage, overfitting, and robustness review.
---

# Quant Lab

Read with `market-data` for strategy design, backtesting, or experiment review.

## Experiment card

Before calculation, state universe, data/adjustment, signal, rebalance timing,
execution price assumption, sizing, cash treatment, costs, benchmark, sample,
and invalidation rule. A close-derived signal may affect only the next return.

The compact core supports `sma_cross`, `momentum`, and `rsi_reversion` as
transparent baselines:

```bash
"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" market-data stock -- backtest --input history.json --strategy sma_cross --fast 20 --slow 60 --cost-bps 8 --slippage-bps 5 --include-series --output result.json
```

Use the baselines to test a claim, not to stretch the engine into an unsupported
strategy. For a custom strategy, produce a precise experiment specification and
use a user-authorized project framework when available.

## Review gate

- Confirm point-in-time membership and fundamentals; disclose survivorship or
  restatement exposure when they cannot be reconstructed.
- Include transaction costs and a relevant passive benchmark. State whether
  dividends, borrow, market impact, taxes, and FX are absent.
- Prefer chronological train/validation/test or walk-forward evidence. Keep the
  final test untouched while tuning.
- Inspect sensitivity to neighboring parameters, later entry, higher cost, and
  subperiods. A fragile result is a finding, not something to optimize away.
- Report CAGR/return, volatility, Sharpe convention, max drawdown, turnover,
  exposure, trade count, and the exact signal-delay guard.

Never describe a backtest as expected future performance. Preserve the core's
result JSON; put supplementary interpretation in a separate dossier or file.
`--include-series` supplies signal date, applied position, turnover and gross,
cost and net returns from the same calculation as the summary. Use that ledger
for trade explanations rather than rebuilding it with another timing model.
`--cutoff YYYY-MM-DD` selects a requested historical price window in memory;
the result records exclusions without changing the input.
