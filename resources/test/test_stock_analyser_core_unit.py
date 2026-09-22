import argparse
import datetime as dt
import copy
import contextlib
import io
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "builtin/marketplace/agents/1040b336306f/skills/market-data/scripts/stock.py"
SPEC = importlib.util.spec_from_file_location("stock_analyser_core", SCRIPT)
assert SPEC and SPEC.loader
stock = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(stock)


def bars(closes, start="2026-01-01"):
    first = dt.date.fromisoformat(start)
    output = []
    for index, close in enumerate(closes):
        date = first + dt.timedelta(days=index)
        output.append({
            "date": date.isoformat(),
            "open": close,
            "high": close * 1.01,
            "low": close * 0.99,
            "close": close,
            "volume": 1_000 + index,
            "amount": close * (1_000 + index),
        })
    return output


def backtest_args(**overrides):
    values = {
        "strategy": "sma_cross",
        "fast": 2,
        "slow": 4,
        "lookback": 3,
        "threshold": 0.0,
        "rsi_entry": 30.0,
        "rsi_exit": 55.0,
        "cost_bps": 0.0,
        "slippage_bps": 0.0,
        "as_of": "2026-06-01",
        "include_series": False,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


class SymbolAndDataTests(unittest.TestCase):
    def test_normalizes_all_three_markets(self):
        self.assertEqual(stock.normalize_symbol("600519")["symbol"], "600519.SH")
        self.assertEqual(stock.normalize_symbol("00700", "HK")["symbol"], "700.HK")
        self.assertEqual(stock.normalize_symbol("MSFT")["symbol"], "MSFT.US")
        self.assertEqual(stock.normalize_symbol("430047")["symbol"], "430047.BJ")

    def test_rejects_market_suffix_conflict(self):
        with self.assertRaisesRegex(stock.StockError, "conflicts"):
            stock.normalize_symbol("700.HK", "US")

    def test_analysis_reports_provenance_quality_and_fundamental_coverage(self):
        history = bars([100 + index * 0.4 for index in range(90)])
        payload = {
            "bars": history,
            "meta": {"adjustment": "qfq"},
            "fundamentals": {"roe": 0.25, "net_margin": 0.18, "pe": 20, "pb": 4},
        }
        result = stock.analyze_payload(
            payload, symbol="600519", source="fixture", as_of=history[-1]["date"]
        )
        self.assertEqual(result["instrument"]["symbol"], "600519.SH")
        self.assertEqual(result["provenance"]["source"], "fixture")
        self.assertEqual(result["quality"]["flags"], [])
        self.assertIsNotNone(result["technical"]["return_60"])
        self.assertEqual(result["fundamental"]["coverage"], {"available": 4, "possible": 9})

    def test_stale_data_is_flagged_and_impossible_ohlc_is_rejected(self):
        history = bars([10, 11, 12])
        result = stock.normalize_bars(history, as_of="2026-02-01")
        self.assertIn("stale_daily_history", result["quality"]["flags"])
        broken = bars([10, 11])
        broken[1]["high"] = 9
        with self.assertRaisesRegex(stock.StockError, "high"):
            stock.normalize_bars(broken, as_of="2026-01-02")

    def test_analyze_universe_selects_canonical_symbol_without_losing_evidence(self):
        universe = {"securities": [
            {"symbol": "600519.SH", "bars": bars([900, 901])},
            {"symbol": "00700.HK", "source": "dated-export",
             "meta": {"adjustment": "qfq", "as_of": "2026-01-02", "currency": "HKD"},
             "bars": bars([100, 110]), "fundamentals": {"roe": 0.2}},
        ]}
        original = copy.deepcopy(universe)
        result = stock.analyze_payload(universe, symbol="HK700", source=None, as_of=None)
        self.assertEqual(result["instrument"]["symbol"], "700.HK")
        self.assertEqual(result["instrument"]["currency"], "HKD")
        self.assertEqual(result["technical"]["last_price"], 110)
        self.assertEqual(result["fundamental"]["values"]["roe"], 0.2)
        self.assertEqual(result["provenance"], {
            "source": "dated-export", "as_of": "2026-01-02", "adjustment": "qfq",
            "evidence_type": "calculated_from_price_history",
        })
        self.assertEqual(result["quality"]["age_days"], 0)
        self.assertEqual(universe, original)

    def test_analyze_cli_keeps_metadata_defaults_and_explicit_overrides(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "history.json"
            output = Path(directory) / "analysis.json"
            payload = {"bars": bars([100, 110]), "meta": {
                "symbol": "600519.SH", "source": "history-provider", "adjustment": "qfq",
                "as_of": "2026-01-02",
            }}
            source.write_text(json.dumps(payload), encoding="utf-8")
            command = ["analyze", "--input", str(source), "--output", str(output)]
            self.assertEqual(stock.main(command), 0)
            result = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result["provenance"]["source"], "history-provider")
            self.assertEqual(result["provenance"]["as_of"], "2026-01-02")
            self.assertEqual(result["instrument"]["symbol"], "600519.SH")
            self.assertEqual(stock.main(command + ["--source", "reviewed-export", "--as-of", "2026-02-01"]), 0)
            result = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(result["provenance"]["source"], "reviewed-export")
            self.assertEqual(result["provenance"]["as_of"], "2026-02-01")
            self.assertIn("stale_daily_history", result["quality"]["flags"])
            # Legacy row-array files still work without a declared instrument.
            source.write_text(json.dumps(payload["bars"]), encoding="utf-8")
            self.assertEqual(stock.main(command + ["--as-of", "2026-01-02"]), 0)
            result = json.loads(output.read_text(encoding="utf-8"))
            self.assertIsNone(result["instrument"])
            self.assertEqual(result["provenance"]["source"], "user-file")

    def test_analyze_rejects_ambiguous_or_invalid_selection_without_overwrite(self):
        security = {"symbol": "600519.SH", "bars": bars([100, 110]),
                    "meta": {"as_of": "2026-01-02", "adjustment": "qfq"}}
        future = copy.deepcopy(security)
        future["meta"]["as_of"] = "2026-01-01"
        conflicting = copy.deepcopy(security)
        conflicting["meta"]["symbol"] = "700.HK"
        for payload, symbol, error in [
            ({"securities": [security]}, None, "requires --symbol"),
            ({"securities": [security]}, "700.HK", "not found"),
            ({"securities": [security, {**security, "symbol": "SH600519"}]}, "600519", "ambiguous"),
            ({"securities": [future]}, "600519", "later than as_of"),
            ({"securities": [conflicting]}, "600519", "conflicts"),
            ({"securities": "invalid"}, "600519", "securities array"),
        ]:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as directory:
                source, output = Path(directory) / "input.json", Path(directory) / "saved.json"
                source.write_text(json.dumps(payload), encoding="utf-8")
                output.write_text("previous analysis", encoding="utf-8")
                command = ["analyze", "--input", str(source), "--output", str(output)]
                if symbol:
                    command += ["--symbol", symbol]
                stdout, stderr = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    self.assertEqual(stock.main(command), 2)
                self.assertEqual(stdout.getvalue(), "")
                self.assertIn(error, json.loads(stderr.getvalue())["error"])
                self.assertEqual(output.read_text(encoding="utf-8"), "previous analysis")

class ResearchAndQuantTests(unittest.TestCase):
    def test_screen_keeps_one_current_cutoff_when_records_have_historical_metadata(self):
        # A dated record must not make an old screen look fresh today.
        universe = {"securities": [{"symbol": "600519.SH",
            "bars": bars([100, 110], start="2020-01-01"),
            "meta": {"as_of": "2020-01-02"}}]}
        today = dt.datetime.now(dt.timezone.utc).date().isoformat()
        result = stock.screen_payload(universe, as_of=None)
        self.assertEqual(result["as_of"], today)
        self.assertIn("stale_daily_history", result["ranking"][0]["quality_flags"])

    def test_screen_ranks_eligible_names_and_exposes_factor_coverage(self):
        universe = {"securities": []}
        for symbol, slope, roe, pe in [
            ("600519", 0.5, 0.30, 20),
            ("700.HK", 0.25, 0.22, 26),
            ("MSFT", 0.35, 0.28, 32),
        ]:
            universe["securities"].append({
                "symbol": symbol,
                "bars": bars([100 + index * slope for index in range(75)]),
                "fundamentals": {"roe": roe, "net_margin": roe / 2, "pe": pe, "pb": 5},
            })
        result = stock.screen_payload(universe, as_of="2026-03-16")
        self.assertEqual(result["eligible_count"], 3)
        self.assertEqual([row["rank"] for row in result["ranking"]], [1, 2, 3])
        self.assertTrue(all(row["score_weight_coverage"] > 0 for row in result["ranking"]))

    def test_screen_missing_fundamentals_reduce_coverage_and_fail_required_filter(self):
        # Independent ranks: monotone 60%, 30%, 0% returns rank 100, 50, 0.
        universe = {"weights": {"momentum": 0.5, "quality": 0.5}, "securities": [
            {"symbol": symbol, "bars": bars([100 + i * slope for i in range(61)])}
            for symbol, slope in [("600519", 1), ("700.HK", 0.5), ("AAPL", 0)]
        ]}
        original = copy.deepcopy(universe)
        result = stock.screen_payload(universe, as_of="2026-03-02")
        self.assertEqual([(r["symbol"], r["score"], r["score_weight_coverage"])
                          for r in result["ranking"]],
                         [("600519.SH", 100, 0.5), ("700.HK", 50, 0.5), ("AAPL.US", 0, 0.5)])
        self.assertTrue(all(r["factor_raw"]["quality"] is None for r in result["ranking"]))
        self.assertEqual(universe, original)
        universe["filters"] = {"min_roe": 0.1}
        excluded = stock.screen_payload(universe, as_of="2026-03-02")
        self.assertEqual(excluded["ranking"], [])
        self.assertEqual(excluded["excluded_count"], 3)
        self.assertTrue(all(r["exclusion_reasons"] == ["missing:min_roe"] for r in excluded["excluded"]))

    def test_future_prices_cannot_change_prior_positions_or_equity(self):
        prefix = [100, 100, 110, 100, 90, 100, 120, 120, 110, 100, 110, 120]
        args = backtest_args(include_series=True, cost_bps=8, slippage_bps=5)
        before = stock.backtest_payload({"bars": bars(prefix)}, args)
        after = stock.backtest_payload({"bars": bars(prefix + [1, 1000, 1, 1000])}, args)
        self.assertEqual(after["series"][:len(before["series"])], before["series"])

    def test_single_delayed_entry_charges_fee_and_slippage_exactly_once(self):
        # The jump creates a signal; the next flat bar earns no gain and pays
        # 13bp once. Charging on the signal bar or every held bar is incorrect.
        result = stock.backtest_payload({"bars": bars([100] * 10 + [150, 150, 150])},
            backtest_args(strategy="momentum", lookback=2, cost_bps=8, slippage_bps=5, include_series=True))
        self.assertAlmostEqual(result["performance"]["total_return"], -0.0013)
        self.assertEqual(result["performance"]["trade_entries"], 1)
        self.assertEqual(result["benchmark"]["total_return"], 0.5)
        self.assertEqual(result["series"][9]["position"], 0)
        self.assertEqual(result["series"][10]["position"], 1)

    def test_transaction_cost_cannot_improve_same_backtest(self):
        closes = [100 + (index % 6) * 3 + index * 0.1 for index in range(80)]
        payload = {"bars": bars(closes)}
        free = stock.backtest_payload(payload, backtest_args())
        costly = stock.backtest_payload(payload, backtest_args(cost_bps=20, slippage_bps=10))
        self.assertLess(costly["performance"]["total_return"], free["performance"]["total_return"])
        self.assertEqual(
            costly["execution"]["lookahead_guard"],
            "signal_at_close_t_is_applied_to_return_t_plus_1",
        )

    def test_last_bar_jump_is_not_captured_by_close_derived_signal(self):
        payload = {"bars": bars([100] * 11 + [150])}
        result = stock.backtest_payload(
            payload,
            backtest_args(strategy="momentum", lookback=2, threshold=0.0),
        )
        self.assertEqual(result["performance"]["total_return"], 0.0)
        self.assertGreater(result["benchmark"]["total_return"], 0)


class PortfolioAndTradeTests(unittest.TestCase):
    def test_portfolio_risk_calculates_concentration_tail_and_scenario(self):
        payload = {
            "positions": [
                {"symbol": "600519", "weight": 0.6, "currency": "CNY", "sector": "Consumer", "returns": [0.01, -0.02, 0.01, -0.03]},
                {"symbol": "700.HK", "weight": 0.4, "currency": "HKD", "sector": "Technology", "returns": [0.02, -0.01, 0.00, -0.04]},
            ],
            "scenarios": {"risk_off": {"Consumer": -0.10, "Technology": -0.20}},
        }
        result = stock.portfolio_payload(payload, 0.95)
        self.assertAlmostEqual(result["concentration"]["hhi"], 0.52)
        self.assertEqual(result["scenarios"]["risk_off"]["portfolio_return"], -0.14)
        self.assertGreaterEqual(result["tail_risk"]["cvar"], result["tail_risk"]["var"])

    def test_multimarket_exposure_and_declared_currency_stress_preserve_units(self):
        payload = {"positions": [
            {"symbol": s, "weight": w, "currency": c, "returns": [0, 0]}
            for s, w, c in [("600519", 0.4, "CNY"), ("700.HK", 0.35, "HKD"), ("AAPL", 0.25, "USD")]
        ], "scenarios": {"usd_down": {"currency": {"USD": -0.1}}}}
        result = stock.portfolio_payload(payload, 0.95)
        self.assertEqual(result["exposure"]["currency"], {"CNY": 0.4, "HKD": 0.35, "USD": 0.25})
        self.assertEqual(result["concentration"]["hhi"], 0.345)
        self.assertEqual(result["scenarios"]["usd_down"]["portfolio_return"], -0.025)
        self.assertEqual(result["scenarios"]["usd_down"]["contributions"],
                         {"600519.SH": 0, "700.HK": 0, "AAPL.US": -0.025})
        # No dates or FX series are invented to align incomplete observations.
        payload["positions"][1]["returns"] = [0]
        with self.assertRaisesRegex(stock.StockError, "at least two returns"):
            stock.portfolio_payload(payload, 0.95)

    def test_live_authorization_and_policy_are_independent_and_never_submit(self):
        base = {"order": {"symbol": "700.HK", "side": "BUY", "quantity": 100, "mode": "live", "time_in_force": "DAY"},
                "instrument": {"lot_size": 100},
                "quote": {"last": 10, "as_of": "2026-08-28T09:30:00+08:00", "market_session": "open"},
                "account": {"cash": 2000}, "policy": {}}
        for allow, authorize in [(False, False), (True, False), (False, True), (True, True)]:
            with self.subTest(allow=allow, authorize=authorize):
                payload = copy.deepcopy(base)
                payload["policy"]["allow_live"] = allow
                payload["explicit_user_authorization"] = authorize
                before = copy.deepcopy(payload)
                result = stock.validate_order_payload(payload, as_of="2026-08-28T09:30:30+08:00")
                self.assertEqual(result["allowed"], allow and authorize)
                self.assertEqual(result["execution"], "validation_only_no_order_was_submitted")
                self.assertEqual(payload, before)
        # Exact authorization never overrides stale quotes or instrument rules.
        payload["order"]["quantity"] = 150
        result = stock.validate_order_payload(payload, as_of="2026-08-28T10:30:00+08:00")
        self.assertFalse(result["allowed"])
        self.assertIn("stale_quote", result["violations"])
        self.assertIn("quantity_not_multiple_of_lot_size", result["violations"])
        self.assertEqual(result["normalized_order"]["quantity"], 150)

    def test_a_share_t_plus_one_does_not_treat_held_shares_as_sellable(self):
        base = {"order": {"symbol": "600519", "side": "SELL", "quantity": 100},
                "quote": {"last": 10, "as_of": "2026-08-28T09:30:00+08:00"},
                "account": {"positions": [{"symbol": "600519", "quantity": 100}]}}
        blocked = stock.validate_order_payload(base, as_of="2026-08-28T09:30:30+08:00")
        self.assertIn("a_share_sell_requires_sellable_quantity_for_t_plus_1", blocked["violations"])
        base["account"]["positions"][0]["sellable_quantity"] = 100
        allowed = stock.validate_order_payload(base, as_of="2026-08-28T09:30:30+08:00")
        self.assertTrue(allowed["allowed"])
        self.assertEqual(allowed["normalized_order"]["mode"], "paper")
        self.assertEqual(allowed["execution"], "validation_only_no_order_was_submitted")

    def test_invalid_portfolio_weights_are_not_silently_normalized(self):
        payload = {
            "positions": [
                {"symbol": "MSFT", "weight": 0.7, "returns": [0.01, 0.02]},
                {"symbol": "AAPL", "weight": 0.5, "returns": [0.00, 0.01]},
            ]
        }
        with self.assertRaisesRegex(stock.StockError, "sum to one"):
            stock.portfolio_payload(payload, 0.95)

    def test_order_validator_blocks_bad_lot_cash_and_unauthorized_live_mode(self):
        payload = {
            "order": {"symbol": "600519", "side": "BUY", "quantity": 150, "mode": "live"},
            "quote": {"last": 100, "as_of": "2026-08-28T09:30:00+08:00"},
            "account": {"cash": 5_000, "positions": []},
            "policy": {"allow_live": True, "stale_after_seconds": 120},
        }
        result = stock.validate_order_payload(payload, as_of="2026-08-28T09:30:30+08:00")
        self.assertFalse(result["allowed"])
        self.assertIn("quantity_not_multiple_of_lot_size", result["violations"])
        self.assertIn("insufficient_cash", result["violations"])
        self.assertIn("exact_live_order_not_explicitly_authorized", result["violations"])
        self.assertEqual(result["execution"], "validation_only_no_order_was_submitted")

    def test_valid_paper_order_and_hong_kong_unknown_lot(self):
        base = {
            "order": {"symbol": "600519", "side": "BUY", "quantity": 100, "mode": "paper", "time_in_force": "DAY"},
            "quote": {"last": 10, "as_of": "2026-08-28T09:30:00+08:00", "market_session": "open"},
            "account": {"cash": 2_000, "positions": []},
            "policy": {"stale_after_seconds": 120},
        }
        result = stock.validate_order_payload(base, as_of="2026-08-28T09:30:30+08:00")
        self.assertTrue(result["allowed"])
        hk = json.loads(json.dumps(base))
        hk["order"].update({"symbol": "700.HK", "quantity": 100})
        blocked = stock.validate_order_payload(hk, as_of="2026-08-28T09:30:30+08:00")
        self.assertIn("hong_kong_buy_requires_current_instrument_lot_size", blocked["violations"])

    def test_quote_observation_time_reaches_order_validation_without_becoming_retrieval_time(self):
        payload = {"order": {"symbol": "700.HK", "side": "BUY", "quantity": 100},
                   "instrument": {"lot_size": 100}, "account": {"cash": 2000},
                   "quote": {"symbol": "700.HK", "currency": "HKD", "last": 10,
                             "observed_at": "2026-08-28T09:30:00+08:00",
                             "retrieved_at": "2026-08-28T09:40:00+08:00"}}
        before = copy.deepcopy(payload)
        result = stock.validate_order_payload(payload, as_of="2026-08-28T09:40:30+08:00")
        self.assertEqual(result["evidence"]["quote_age_seconds"], 630)
        self.assertIn("stale_quote", result["violations"])
        self.assertNotIn("missing_quote.as_of", result["violations"])
        self.assertEqual(payload, before)
        payload["quote"]["as_of"] = "2026-08-28T01:30:00+00:00"
        self.assertEqual(stock.validate_order_payload(payload, as_of="2026-08-28T09:30:30+08:00")["evidence"]["quote_age_seconds"], 30)
        payload["quote"]["as_of"] = "2026-08-28T09:40:00+08:00"
        with self.assertRaisesRegex(stock.StockError, "conflicting quote timestamps"):
            stock.validate_order_payload(payload, as_of="2026-08-28T09:40:30+08:00")

    def test_misnamed_risk_policy_is_rejected_instead_of_silently_dropping_limits(self):
        base = {"order": {"symbol": "AAPL", "side": "BUY", "quantity": 1},
                "quote": {"last": 100, "as_of": "2026-08-28T09:30:00+08:00"},
                "account": {"cash": 200}, "policy": {"max_position_value": 50}}
        with self.assertRaisesRegex(stock.StockError, "unsupported policy fields: max_position_value"):
            stock.validate_order_payload(base, as_of="2026-08-28T09:30:30+08:00")

    def test_quote_listing_currency_and_misplaced_authorization_fail_closed(self):
        base = {"order": {"symbol": "AAPL", "side": "BUY", "quantity": 1, "mode": "live",
                          "explicit_user_authorization": True},
                "quote": {"symbol": "AAPL.US", "currency": "USD", "last": 100,
                          "observed_at": "2026-08-28T09:30:00+08:00"},
                "account": {"cash": 200}, "policy": {"allow_live": True}}
        result = stock.validate_order_payload(base, as_of="2026-08-28T09:30:30+08:00")
        self.assertIn("exact_live_order_not_explicitly_authorized", result["violations"])
        self.assertFalse(result["allowed"])
        self.assertEqual(result["execution"], "validation_only_no_order_was_submitted")
        for field, value in [("symbol", "MSFT.US"), ("currency", "HKD")]:
            with self.subTest(field=field):
                changed = copy.deepcopy(base)
                changed["quote"][field] = value
                with self.assertRaisesRegex(stock.StockError, "quote .* does not match order"):
                    stock.validate_order_payload(changed, as_of="2026-08-28T09:30:30+08:00")


class ReportingTests(unittest.TestCase):
    def test_report_preserves_metric_records_and_missing_values_in_the_delivered_table(self):
        dossier = {"metrics": [
            {"symbol": "600519.SH", "score": 100, "coverage": 0.5, "currency": "CNY", "note": "source|as-of\n2024-12-31"},
            {"symbol": "700.HK", "score": 50, "coverage": 0.5, "currency": "HKD"},
            {"symbol": "AAPL.US", "score": 0, "coverage": 0.5, "currency": "USD", "quality": None},
        ]}
        before = copy.deepcopy(dossier)
        report = stock.render_report(dossier)
        self.assertIn("## Metrics\n\n| symbol | score | coverage | currency | note | quality |", report)
        self.assertIn("| 600519.SH | 100 | 0.5 | CNY | source\\|as-of<br>2024-12-31 | — |", report)
        self.assertIn("| 700.HK | 50 | 0.5 | HKD | — | — |", report)
        self.assertIn("| AAPL.US | 0 | 0.5 | USD | — | — |", report)
        self.assertEqual(dossier, before)

    def test_invalid_report_metrics_fail_without_overwriting_the_previous_delivery(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "dossier.json", Path(directory) / "report.md"
            output.write_text("previous user report", encoding="utf-8")
            for metrics in [[{"score": 100}, "not a metric record"], "unsupported shape"]:
                with self.subTest(metrics=metrics):
                    source.write_text(json.dumps({"metrics": metrics}), encoding="utf-8")
                    stdout, stderr = io.StringIO(), io.StringIO()
                    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                        result = stock.main(["render-report", "--input", str(source), "--output", str(output)])
                    self.assertEqual(result, 2)
                    self.assertEqual(stdout.getvalue(), "")
                    self.assertEqual(json.loads(stderr.getvalue())["error"], "report metrics must be an object or an array of objects")
                    self.assertEqual(output.read_text(encoding="utf-8"), "previous user report")

    def test_historical_screen_cli_preserves_cutoff_and_rejects_future_bars_without_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "universe.json"
            output = Path(directory) / "screen-result.json"
            source.write_text(json.dumps({"weights": {"momentum": 0.5, "quality": 0.5}, "securities": [
                {"symbol": "600519.SH", "bars": bars(range(100, 161), start="2024-11-01")},
            ]}), encoding="utf-8")
            command = ["screen", "--input", str(source), "--output", str(output), "--as-of"]
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(stock.main(command + ["2024-12-31"]), 0)
            saved = output.read_text(encoding="utf-8")
            result = json.loads(saved)
            self.assertEqual(result["as_of"], "2024-12-31")
            self.assertEqual(result["ranking"][0]["quality_flags"], [])
            self.assertEqual(result["ranking"][0]["score_weight_coverage"], 0.5)
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                self.assertEqual(stock.main(command + ["2024-12-30"]), 2)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(json.loads(stderr.getvalue()), {"ok": False, "error": "last bar is later than as_of"})
            self.assertEqual(output.read_text(encoding="utf-8"), saved)

    def test_report_preserves_evidence_and_escapes_table_cells(self):
        dossier = {
            "title": "MSFT Review",
            "evidence": {"source": "filing|quote", "as_of": "2026-08-27"},
            "metrics": {"return": "12%"},
            "risks": ["valuation"],
        }
        report = stock.render_report(dossier)
        self.assertIn("# MSFT Review", report)
        self.assertIn("filing\\|quote", report)
        self.assertIn("## Risks", report)
        self.assertIn("absent fields were not inferred", report)

    def test_report_preserves_scenario_counterevidence_and_parallel_verification_priorities(self):
        dossier = {
            "scenarios": [{"case": "base", "support": "cash supports earnings",
                           "reverse_if": "cash gain is one-off", "catalyst": "audited release"},
                          {"case": "upside", "threshold": None, "gap": "no cash-flow evidence"}],
            "next_steps": [{"priority": 1, "source": "cash-flow notes", "changes": "earnings interpretation"},
                           {"priority": 1, "source": "inventory reconciliation", "changes": "channel pressure"}],
        }
        original = copy.deepcopy(dossier)
        report = stock.render_report(dossier)
        for value in ("cash supports earnings", "cash gain is one-off", "audited release",
                      "no cash-flow evidence", "cash-flow notes", "earnings interpretation",
                      "inventory reconciliation", "channel pressure"):
            self.assertIn(value, report)
        self.assertEqual(dossier, original)
        self.assertIn('"threshold": null', report)
        self.assertEqual(report.count('"priority": 1'), 2)

    def test_cli_failed_calculation_preserves_existing_report_and_has_no_success_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "invalid.json"
            output = Path(directory) / "report.json"
            source.write_text(json.dumps({"bars": bars([100, 101])}), encoding="utf-8")
            output.write_text("user-owned result", encoding="utf-8")
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                result = stock.main(["backtest", "--input", str(source), "--strategy", "sma_cross", "--output", str(output)])
            self.assertEqual(result, 2)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(json.loads(stderr.getvalue()), {"ok": False, "error": "backtest requires at least ten bars"})
            self.assertEqual(output.read_text(encoding="utf-8"), "user-owned result")

    def test_explicit_output_is_the_only_write_path(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "dossier.json"
            output = Path(directory) / "report.md"
            source.write_text(json.dumps({"title": "Fixture"}), encoding="utf-8")
            result = stock.main(["render-report", "--input", str(source), "--output", str(output)])
            self.assertEqual(result, 0)
            self.assertEqual(output.read_text(encoding="utf-8"), "# Fixture\n\n---\nGenerated from the supplied StockAnalyser dossier; absent fields were not inferred.\n")


class EvidenceFlowTests(unittest.TestCase):
    def test_explicit_cutoff_is_shared_without_changing_strict_as_of_or_source(self):
        history = {"bars": bars([100] * 10 + [110, 10000]),
                   "meta": {"symbol": "600519.SH", "source": "dated-export", "as_of": "2026-01-12"}}
        original = copy.deepcopy(history)
        selected, audit = stock.select_history_cutoff(history, "2026-01-11")
        self.assertEqual(history, original)
        self.assertEqual(selected["meta"], original["meta"])
        self.assertEqual(len(selected["bars"]), 11)
        self.assertEqual(audit[0]["excluded_bars"], 1)
        with self.assertRaisesRegex(stock.StockError, "later than as_of"):
            stock.normalize_bars(history, as_of="2026-01-11")
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / "input.json", Path(directory) / "result.json"
            for command in ("analyze", "screen", "backtest"):
                value = {"securities": [{"symbol": "600519.SH", **history}]} if command == "screen" else history
                source.write_text(json.dumps(value))
                before = source.read_bytes()
                args = [command, "--input", str(source), "--output", str(output), "--cutoff", "2026-01-11"]
                if command == "backtest": args += ["--strategy", "sma_cross", "--fast", "2", "--slow", "3"]
                self.assertEqual(stock.main(args), 0)
                result = json.loads(output.read_text())
                self.assertEqual(result["input_selection"]["histories"][0]["excluded_bars"], 1)
                self.assertEqual(source.read_bytes(), before)
                if command == "analyze": self.assertEqual(result["technical"]["last_price"], 110)
                if command == "backtest": self.assertEqual(result["performance"]["total_return"], 0)

    def test_cutoff_rejects_ambiguous_dates_or_insufficient_history(self):
        for rows in (bars([10, 11]) + [bars([12])[0]], [{"close": 1}], bars([10, 11], "2027-01-01")):
            with self.subTest(rows=rows), self.assertRaises(stock.StockError):
                stock.select_history_cutoff(rows, "2026-01-02")

    def test_conflicting_selection_and_broken_evidence_preserve_previous_delivery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source, evidence, output = [root / name for name in ("source.json", "evidence.json", "result.md")]
            source.write_text(json.dumps({"bars": bars([10, 11, 12])}))
            output.write_text("previous reviewed result")
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(stock.main(["analyze", "--input", str(source), "--cutoff", "2026-01-02", "--as-of", "2026-01-03", "--output", str(output)]), 2)
            self.assertEqual(output.read_text(), "previous reviewed result")
            evidence.write_text("{broken")
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(stock.main(["render-report", "--input", str(source), "--evidence-input", str(evidence), "--output", str(output)]), 2)
            self.assertEqual(output.read_text(), "previous reviewed result")

    def test_backtest_detail_uses_the_same_delayed_cost_ledger(self):
        args = backtest_args(slow=3, cost_bps=12, slippage_bps=8, include_series=True)
        result = stock.backtest_payload({"bars": bars([100] * 20 + [120] * 20)}, args)
        trades = [row for row in result["series"] if row["turnover_units"]]
        self.assertEqual([(row["signal_date"], row["date"]) for row in trades],
                         [("2026-01-21", "2026-01-22"), ("2026-01-23", "2026-01-24")])
        self.assertEqual([row["cost_return"] for row in trades], [0.002, 0.002])
        self.assertEqual(result["series"][19]["gross_return"], 0)
        self.assertAlmostEqual(result["series"][-1]["equity"], 0.996004)
        args.include_series = False
        plain = stock.backtest_payload({"bars": bars([100] * 20 + [120] * 20)}, args)
        self.assertEqual({k: v for k, v in result.items() if k != "series"}, plain)

    def test_scenario_mode_compounds_fx_without_fabricating_historical_risk(self):
        payload = {"base_currency": "CNY", "positions": [
            {"symbol": "601318.SH", "currency": "CNY", "weight": 0.3},
            {"symbol": "9988.HK", "currency": "HKD", "weight": 0.2},
            {"symbol": "MSFT.US", "currency": "USD", "weight": 0.5}],
            "scenarios": {"joint": {"local": {"601318.SH": -0.2, "9988.HK": -0.05, "MSFT.US": -0.1},
                                      "fx": {"HKD": -0.02, "USD": -0.03}}}}
        original = copy.deepcopy(payload)
        result = stock.portfolio_payload(payload, 0.95, mode="scenario")
        self.assertEqual(payload, original)
        self.assertEqual(result["concentration"]["hhi"], 0.38)
        self.assertEqual(result["scenarios"]["joint"]["portfolio_return"], -0.1373)
        self.assertEqual(result["scenarios"]["joint"]["local_only_return"], -0.12)
        self.assertEqual(result["scenarios"]["joint"]["fx_only_return"], -0.019)
        self.assertIsNone(result["tail_risk"])
        self.assertIsNone(result["performance"])
        self.assertEqual(result["observations"], 0)
        with self.assertRaisesRegex(stock.StockError, "requires at least two returns"):
            stock.portfolio_payload(payload, 0.95)
        # A different base currency and positive shock exercise composition,
        # rather than only the regression fixture's additive-loss near miss.
        payload = {"base_currency": "USD", "positions": [{"symbol": "700.HK", "currency": "HKD", "weight": 1}],
                   "scenarios": {"up": {"local": {"700.HK": 0.1}, "fx": {"HKD": 0.2}}}}
        self.assertEqual(stock.portfolio_payload(payload, 0.95, mode="scenario")["scenarios"]["up"]["portfolio_return"], 0.32)
        for mutation in ({"fx": {"EUR": 0.1}}, {"local": {"700.HK": -1.1}}, {"fx": []}):
            invalid = copy.deepcopy(payload); invalid["scenarios"]["up"].update(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(stock.StockError):
                stock.portfolio_payload(invalid, 0.95, mode="scenario")

    def test_render_report_carries_original_observation_and_retrieval_times(self):
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); dossier, receipt, quote, output = [root / name for name in ("dossier.json", "receipt.json", "quote.json", "review.md")]
            dossier.write_text(json.dumps({"summary": "Model interpretation without copied timestamps."}))
            receipt.write_text(json.dumps({"source": "export", "order_id": "PAPER-X", "timestamp": "2020-02-03T10:00:00+08:00", "mode": "paper"}))
            quote.write_text(json.dumps({"quote": {"observed_at": "2020-02-02T10:00:00+08:00", "retrieved_at": "2020-02-04T10:00:00+08:00"}}))
            before = receipt.read_bytes()
            self.assertEqual(stock.main(["render-report", "--input", str(dossier), "--evidence-input", str(receipt), "--evidence-input", str(quote), "--output", str(output)]), 0)
            text = output.read_text()
            for value in ("2020-02-03T10:00:00+08:00", "2020-02-02T10:00:00+08:00", "2020-02-04T10:00:00+08:00", hashlib.sha256(before).hexdigest(), "not a claim of current state"):
                self.assertIn(value, text)
            self.assertEqual(receipt.read_bytes(), before)
            # No timestamp is inferred for a genuinely undated export.
            receipt.write_text('{"source":"undated"}')
            self.assertEqual(stock.evidence_record(str(receipt))["declared_metadata"], {"source": "undated"})

    def test_duplicate_security_aliases_cannot_hide_contributions(self):
        payload = {"positions": [{"symbol": symbol, "weight": 0.5, "returns": [0, 0]} for symbol in ("00700.HK", "700.HK")]}
        for mode in ("historical", "scenario"):
            with self.subTest(mode=mode), self.assertRaisesRegex(stock.StockError, "duplicate securities"):
                stock.portfolio_payload(payload, 0.95, mode=mode)

    def test_all_cli_outputs_preserve_input_and_evidence_even_through_aliases(self):
        import os
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "input.json"; source.write_text('{"title":"keep"}')
            aliases = [source, root / "symlink.json", root / "hardlink.json"]
            aliases[1].symlink_to(source); os.link(source, aliases[2])
            for alias in aliases:
                for command in ("render-report", "screen", "portfolio-risk", "validate-order"):
                    with self.subTest(command=command, alias=alias.name), contextlib.redirect_stderr(io.StringIO()):
                        self.assertEqual(stock.main([command, "--input", str(source), "--output", str(alias)]), 2)
                    self.assertEqual(source.read_text(), '{"title":"keep"}')
            dossier = root / "dossier.json"; dossier.write_text('{}')
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(stock.main(["render-report", "--input", str(dossier), "--evidence-input", str(source), "--output", str(source)]), 2)
            self.assertEqual(source.read_text(), '{"title":"keep"}')


if __name__ == "__main__":
    unittest.main()
