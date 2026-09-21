import datetime as dt
import importlib.util
import socket
import sys
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1] / "builtin/marketplace/agents/1040b336306f/skills/market-data"
SCRIPT_DIR = SKILL_DIR / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))
SPEC = importlib.util.spec_from_file_location("stock_analyser_history", SCRIPT_DIR / "history.py")
assert SPEC and SPEC.loader
history = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(history)


class Frame:
    def __init__(self, rows):
        self.rows = rows

    def to_dict(self, orient):
        if orient != "records":
            raise AssertionError(orient)
        return self.rows


def rows(*dates):
    return [
        {
            "date": date,
            "open": 10 + index,
            "high": 11 + index,
            "low": 9 + index,
            "close": 10.5 + index,
            "volume": 1_000 + index,
            "amount": 10_500 + index,
        }
        for index, date in enumerate(dates)
    ]


class FakeAk:
    __version__ = "1.18.94"

    def __init__(self):
        self.calls = []

    def stock_zh_a_daily(self, **kwargs):
        self.calls.append(("a-sina", kwargs))
        return Frame(rows("2026-08-25", "2026-08-26", "2026-08-27"))

    def stock_hk_daily(self, **kwargs):
        self.calls.append(("hk-sina", kwargs))
        return Frame(rows("2026-08-24", "2026-08-26", "2026-08-27"))

    def stock_us_daily(self, **kwargs):
        self.calls.append(("us-sina", kwargs))
        return Frame(rows("2026-08-25", "2026-08-26", "2026-08-27"))


class HistoryTests(unittest.TestCase):
    def test_primary_sina_history_covers_a_hk_and_us(self):
        cases = [
            ("601872.SH", "auto", "a-sina", "sh601872", 3),
            ("00700", "HK", "hk-sina", "00700", 2),
            ("AAPL", "auto", "us-sina", "AAPL", 3),
        ]
        for symbol, market_name, call_name, provider_symbol, expected_count in cases:
            with self.subTest(symbol=symbol):
                ak = FakeAk()
                result = history.fetch(
                    symbol, "2026-08-25", "2026-08-27", market=market_name,
                    ak_module=ak,
                    retrieved_at=dt.datetime(2026, 8, 28, tzinfo=dt.timezone.utc),
                )
                self.assertEqual(ak.calls[0][0], call_name)
                self.assertEqual(result["meta"]["source"], "akshare_sina")
                self.assertEqual(result["meta"]["provider_symbol"], provider_symbol)
                self.assertEqual(result["meta"]["provider_version"], "1.18.94")
                self.assertEqual(result["meta"]["adjustment"], "qfq")
                self.assertEqual(result["quality"]["bar_count"], expected_count)
                self.assertTrue(all(
                    "2026-08-25" <= bar["date"] <= "2026-08-27"
                    for bar in result["bars"]
                ))
                self.assertEqual(result["quality"]["last_date"], "2026-08-27")

    def test_auto_uses_eastmoney_fallback_after_sina_failure(self):
        class FallbackAk:
            __version__ = "1.18.94"

            def stock_zh_a_daily(self, **_kwargs):
                raise RuntimeError("sina unavailable")

            def stock_zh_a_hist(self, **kwargs):
                self.kwargs = kwargs
                return Frame([
                    {"日期": "2026-08-26", "开盘": 10, "最高": 11, "最低": 9, "收盘": 10.5, "成交量": 100},
                    {"日期": "2026-08-27", "开盘": 11, "最高": 12, "最低": 10, "收盘": 11.5, "成交量": 120},
                ])

        ak = FallbackAk()
        result = history.fetch("601872", "2026-08-26", "2026-08-27", ak_module=ak)
        self.assertEqual(result["meta"]["source"], "akshare_eastmoney")
        self.assertEqual(result["meta"]["attempts"][0]["status"], "error")
        self.assertEqual(result["meta"]["attempts"][1]["status"], "ok")
        self.assertEqual(ak.kwargs["symbol"], "601872")

    def test_eastmoney_fallback_maps_hk_and_us_provider_symbols(self):
        class FallbackAk:
            __version__ = "1.18.94"

            def __init__(self):
                self.kwargs = None

            def stock_hk_daily(self, **_kwargs):
                raise RuntimeError("sina unavailable")

            def stock_us_daily(self, **_kwargs):
                raise RuntimeError("sina unavailable")

            def stock_hk_hist(self, **kwargs):
                self.kwargs = kwargs
                return Frame(rows("2026-08-26", "2026-08-27"))

            def stock_us_hist(self, **kwargs):
                self.kwargs = kwargs
                return Frame(rows("2026-08-26", "2026-08-27"))

        cases = [
            ("00700.HK", None, "00700"),
            ("AAPL.US", "105.AAPL", "105.AAPL"),
        ]
        for symbol, explicit_provider_symbol, expected_provider_symbol in cases:
            with self.subTest(symbol=symbol):
                ak = FallbackAk()
                result = history.fetch(
                    symbol, "2026-08-26", "2026-08-27",
                    provider_symbol=explicit_provider_symbol,
                    ak_module=ak,
                )
                self.assertEqual(result["meta"]["source"], "akshare_eastmoney")
                self.assertEqual(result["meta"]["provider_symbol"], expected_provider_symbol)
                self.assertEqual(ak.kwargs["symbol"], expected_provider_symbol)
                self.assertEqual(ak.kwargs["adjust"], "qfq")

    def test_raw_history_preserves_raw_metadata_and_provider_argument(self):
        ak = FakeAk()
        result = history.fetch(
            "601872.SH", "2026-08-25", "2026-08-27",
            adjust="raw", ak_module=ak,
        )
        self.assertEqual(ak.calls[0][1]["adjust"], "")
        self.assertEqual(result["meta"]["adjustment"], "raw")

    def test_explicit_provider_failure_does_not_silently_switch_vendor(self):
        class BrokenSina:
            __version__ = "1.18.94"

            def __init__(self):
                self.calls = []

            def stock_zh_a_daily(self, **_kwargs):
                self.calls.append("sina")
                raise RuntimeError("sina unavailable")

            def stock_zh_a_hist(self, **_kwargs):
                self.calls.append("eastmoney")
                return Frame(rows("2026-08-26", "2026-08-27"))

        ak = BrokenSina()
        with self.assertRaisesRegex(history.StockError, "all history providers failed"):
            history.fetch(
                "601872.SH", "2026-08-26", "2026-08-27",
                provider="akshare-sina", ak_module=ak,
            )
        self.assertEqual(ak.calls, ["sina"])

    def test_provider_failure_is_sanitized_and_restores_process_timeout(self):
        class BrokenProviders:
            __version__ = "1.18.94"

            def stock_zh_a_daily(self, **_kwargs):
                raise RuntimeError("failed at https://secret.invalid/sina")

            def stock_zh_a_hist(self, **_kwargs):
                raise RuntimeError("failed at https://secret.invalid/eastmoney")

        original = socket.getdefaulttimeout()
        socket.setdefaulttimeout(7.25)
        try:
            with self.assertRaisesRegex(
                history.StockError, "all history providers failed",
            ) as raised:
                history.fetch(
                    "601872.SH", "2026-08-26", "2026-08-27",
                    timeout=1, ak_module=BrokenProviders(),
                )
            self.assertNotIn("secret.invalid", str(raised.exception))
            self.assertIn("provider endpoint", str(raised.exception))
            self.assertEqual(socket.getdefaulttimeout(), 7.25)
        finally:
            socket.setdefaulttimeout(original)

    def test_partial_provider_results_do_not_report_false_success(self):
        class PartialProviders:
            __version__ = "1.18.94"

            def stock_zh_a_daily(self, **_kwargs):
                return Frame(rows("2026-08-27"))

            def stock_zh_a_hist(self, **_kwargs):
                return Frame(rows("2026-08-27"))

        with self.assertRaisesRegex(
            history.StockError, "all history providers failed",
        ) as raised:
            history.fetch(
                "601872.SH", "2026-08-26", "2026-08-27",
                ak_module=PartialProviders(),
            )
        self.assertIn("fewer than two bars", str(raised.exception))
        self.assertIn("akshare-sina", str(raised.exception))
        self.assertIn("akshare-eastmoney", str(raised.exception))

    def test_does_not_silently_truncate_provider_rows(self):
        ak = FakeAk()
        with self.assertRaisesRegex(history.StockError, "exceeding max-bars"):
            history.fetch(
                "601872", "2026-08-25", "2026-08-27", max_bars=2, ak_module=ak,
            )

    def test_invalid_options_fail_before_any_provider_call(self):
        invalid = [
            {"start": "2026-08-28", "end": "2026-08-27"},
            {"start": "2026/08/26", "end": "2026-08-27"},
            {"provider": "unknown"},
            {"adjust": "split-only"},
            {"timeout": 0},
            {"timeout": 61},
            {"max_bars": 1},
            {"max_bars": 20_001},
        ]
        for kwargs in invalid:
            with self.subTest(kwargs=kwargs):
                ak = FakeAk()
                defaults = {"start": "2026-08-26", "end": "2026-08-27"}
                defaults.update(kwargs)
                with self.assertRaises(history.StockError):
                    history.fetch("601872.SH", ak_module=ak, **defaults)
                self.assertEqual(ak.calls, [])

    def test_dependency_is_exactly_pinned(self):
        self.assertEqual(
            (SKILL_DIR / "requirements.history.txt").read_text(encoding="utf-8").strip(),
            "akshare==1.18.94",
        )


if __name__ == "__main__":
    unittest.main()
