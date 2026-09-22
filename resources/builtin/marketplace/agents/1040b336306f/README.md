# StockAnalyser — repository source

`StockAnalyser` is a platform built-in Agent under
`PC/resources/builtin/marketplace/agents/1040b336306f`. PC startup seeds this
package through the same built-in marketplace path as the other shipped
Agents. Its six private Skills remain owned by StockAnalyser, and its model
regressions continue to participate in the default production-runtime cohort.
This built-in placement is independent of marketplace production publication.

## Lean package

- `market-data`: A/HK/US identifiers, free current-quote APIs, pinned AKShare
  history, provenance, CSV/JSON contracts, and the shared deterministic core.
- `security-research`: evidence-led company research and cross-market screens.
- `quant-lab`: cost-aware, look-ahead-safe strategy experiments.
- `portfolio-risk`: concentration, drawdown, tail-risk, and scenario analysis.
- `trade-control`: order drafts, paper mode, and live pre-trade safety.
- `investment-report`: concise dashboard and durable report contracts.

The six Skills are user-task boundaries, not workflow stages. Only the relevant
Skill plus `market-data` should be loaded for a request. All numeric operations
share `market-data/scripts/stock.py`, which uses the Python standard library.
Current quotes use free Tencent/Sina HTTP APIs. The history adapter pins AKShare
inside the Skill runner's isolated dependency cache, never as an Orkas-wide
dependency. Connected broker data stays behind the connector boundary.

## Open-source design lineage

The package adopts provider normalization from OpenBB, A/HK/US coverage from
AKShare and Longbridge, factor/research discipline from Qlib, backtest semantics
from backtrader/vectorbt/Zipline, risk decomposition from Riskfolio-Lib, and
paper/live execution separation from LEAN and Freqtrade. It intentionally does
not copy those projects' application shells or introduce their workflow engines.

## Local verification

```bash
cd PC
node scripts/run-python-tests.mjs resources/test/test_stock_analyser_core_unit.py resources/test/test_stock_analyser_market_unit.py resources/test/test_stock_analyser_history_unit.py -q
```

Network-provider canaries are intentionally separate: deterministic tests do
not require credentials, a live market, or optional packages. Run the explicit
live A/HK/US check with `npm run test:stock-data:live`.
