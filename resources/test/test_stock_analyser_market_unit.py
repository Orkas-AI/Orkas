import datetime as dt
import contextlib
import importlib.util
import io
import json
import sys
import unittest
import tempfile
from unittest import mock
import urllib.error
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "builtin/marketplace/agents/1040b336306f/skills/market-data/scripts"
sys.path.insert(0, str(SCRIPT_DIR))
SPEC = importlib.util.spec_from_file_location("stock_analyser_market", SCRIPT_DIR / "market.py")
assert SPEC and SPEC.loader
market = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(market)


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def response(text):
    return Response(text.encode("gb18030"))


TENCENT_A = (
    'v_sh601872="1~招商轮船~601872~18.99~18.62~0.00~0~0~0~18.99~2342~'
    '0~0~0~0~0~0~0~0~18.99~2342~0~0~0~0~0~0~0~0~~20260828092302~'
    '0.37~1.99~0.00~0.00~18.99/0/0~0~0~0.00";\n'
)

TENCENT_HK = (
    'v_hk00700="100~腾讯控股~00700~455.600~447.800~444.000~10201355.0~0~0~'
    '455.600~0~0~0~0~0~0~0~0~0~455.600~0~0~0~0~0~0~0~0~0~10201355.0~'
    '2026/08/28 10:38:39~7.800~1.74~459.800~443.400~455.600~10201355.0~'
    '4630281113.124~0~16.66~~0~0~3.66";\n'
)

TENCENT_US = (
    'v_usAAPL="200~苹果~AAPL.OQ~314.58~313.45~310.55~32419233~0~0~314.80~'
    '80~0~0~0~0~0~0~0~0~314.94~80~0~0~0~0~0~0~0~0~~2026-08-27 16:00:01~'
    '1.13~0.36~315.40~309.40~USD~32419233~10163243816~0.22~36.08";\n'
)

SINA_A = (
    'var hq_str_sh601872="招商轮船,0.000,18.620,0.000,0.000,0.000,18.990,'
    '18.990,0,0.000,241936,18.990,13564,0.000,0,0.000,0,0.000,0,0.000,'
    '241936,18.990,0,0.000,0,0.000,0,0.000,0,0.000,2026-08-28,09:23:01,00,";\n'
)

class QuoteTests(unittest.TestCase):
    def test_actual_quote_adapter_result_can_be_validated_without_field_reconstruction(self):
        result = market.quote("700.HK", opener=lambda *_args, **_kwargs: response(TENCENT_HK),
                              now=dt.datetime(2026, 8, 28, 2, 39, tzinfo=dt.timezone.utc))
        from stock import validate_order_payload
        payload = {"order": {"symbol": "00700.HK", "side": "BUY", "quantity": 100},
                   "quote": result, "instrument": {"lot_size": 100}, "account": {"cash": 50000}}
        validation = validate_order_payload(payload, as_of="2026-08-28T10:39:00+08:00")
        self.assertTrue(validation["allowed"])
        self.assertEqual(validation["evidence"]["quote_age_seconds"], 21)
        self.assertEqual(validation["evidence"]["last_price"], 455.6)
        self.assertEqual(validation["estimates"]["order_value"], 45560)
        self.assertNotIn("market_session_not_verified", validation["warnings"])
        self.assertEqual(validation["execution"], "validation_only_no_order_was_submitted")

    def test_tencent_a_quote_is_api_sourced_and_auction_aware(self):
        result = market.quote(
            "601872.SH",
            opener=lambda *_args, **_kwargs: response(TENCENT_A),
            now=dt.datetime(2026, 8, 28, 1, 23, 2, tzinfo=dt.timezone.utc),
        )
        self.assertEqual(result["instrument"]["symbol"], "601872.SH")
        self.assertEqual(result["instrument"]["name"], "招商轮船")
        self.assertEqual(result["quote"]["last"], 18.99)
        self.assertEqual(result["provenance"]["source"], "tencent_quote_api")
        self.assertEqual(result["provenance"]["observed_at"], "2026-08-28T09:23:02+08:00")
        self.assertEqual(result["quality"]["market_session"], "opening_auction")
        self.assertEqual(result["quality"]["quote_kind"], "indicative")
        self.assertIn("indicative_quote", result["quality"]["flags"])

    def test_real_cross_market_shapes_preserve_currency_time_and_snapshot_semantics(self):
        cases = [
            (
                "00700.HK", TENCENT_HK,
                dt.datetime(2026, 8, 28, 2, 39, tzinfo=dt.timezone.utc),
                "700.HK", "HKD", 455.6, "2026-08-28T10:38:39+08:00",
                "regular", "last_trade", 4_630_281_113.124,
            ),
            (
                "AAPL.US", TENCENT_US,
                dt.datetime(2026, 8, 27, 20, 1, tzinfo=dt.timezone.utc),
                "AAPL.US", "USD", 314.58, "2026-08-27T16:00:01-04:00",
                "post_market", "last_market_snapshot", 10_163_243_816,
            ),
        ]
        for (
            symbol, body, now, canonical, currency, last, observed_at,
            session, quote_kind, amount,
        ) in cases:
            with self.subTest(symbol=symbol):
                result = market.quote(
                    symbol,
                    opener=lambda *_args, body=body, **_kwargs: response(body),
                    now=now,
                )
                self.assertEqual(result["instrument"]["symbol"], canonical)
                self.assertEqual(result["instrument"]["currency"], currency)
                self.assertEqual(result["quote"]["last"], last)
                self.assertEqual(result["quote"]["amount"], amount)
                self.assertEqual(result["provenance"]["observed_at"], observed_at)
                self.assertEqual(result["quality"]["market_session"], session)
                self.assertEqual(result["quality"]["quote_kind"], quote_kind)

    def test_future_provider_time_is_disclosed_instead_of_looking_fresh(self):
        result = market.quote(
            "601872.SH",
            opener=lambda *_args, **_kwargs: response(TENCENT_A),
            now=dt.datetime(2026, 8, 28, 1, 22, tzinfo=dt.timezone.utc),
        )
        self.assertEqual(result["quality"]["age_seconds"], 0)
        self.assertIn("provider_timestamp_in_future", result["quality"]["flags"])

    def test_missing_current_trade_uses_previous_close_with_explicit_flag(self):
        no_last = TENCENT_A.replace(
            "~601872~18.99~18.62~", "~601872~~18.62~", 1,
        )
        result = market.quote(
            "601872.SH",
            opener=lambda *_args, **_kwargs: response(no_last),
            now=dt.datetime(2026, 8, 28, 1, 23, 2, tzinfo=dt.timezone.utc),
        )
        self.assertEqual(result["quote"]["last"], 18.62)
        self.assertEqual(result["quality"]["quote_kind"], "previous_close")
        self.assertIn("no_current_trade_used_previous_close", result["quality"]["flags"])

    def test_auto_falls_back_to_sina_and_uses_indicative_bid(self):
        requests = []

        def opener(request, **_kwargs):
            requests.append(request)
            if "qt.gtimg.cn" in request.full_url:
                raise urllib.error.URLError("primary unavailable")
            return response(SINA_A)

        result = market.quote(
            "601872",
            opener=opener,
            now=dt.datetime(2026, 8, 28, 1, 23, 2, tzinfo=dt.timezone.utc),
        )
        self.assertEqual(result["quote"]["last"], 18.99)
        self.assertEqual(result["provenance"]["source"], "sina_quote_api")
        self.assertEqual(result["quality"]["attempts"][0]["status"], "error")
        self.assertEqual(result["quality"]["attempts"][1], {"provider": "sina", "status": "ok"})
        self.assertEqual(requests[1].get_header("Referer"), "https://finance.sina.com.cn/")

    def test_successful_stale_primary_is_disclosed_without_switching_provider(self):
        requests = []

        def opener(request, **_kwargs):
            requests.append(request)
            return response(TENCENT_HK)

        result = market.quote(
            "00700.HK",
            opener=opener,
            now=dt.datetime(2026, 9, 17, 2, 42, 30, tzinfo=dt.timezone.utc),
        )
        self.assertEqual(result["provenance"]["source"], "tencent_quote_api")
        self.assertIn("stale_quote", result["quality"]["flags"])
        self.assertEqual(result["quality"]["attempts"], [{"provider": "tencent", "status": "ok"}])
        self.assertEqual(len(requests), 1)
        self.assertIn("qt.gtimg.cn", requests[0].full_url)

    def test_provider_symbol_mapping_covers_three_markets(self):
        self.assertEqual(market.provider_symbol(market.normalize_symbol("600519"), "tencent"), "sh600519")
        self.assertEqual(market.provider_symbol(market.normalize_symbol("00700", "HK"), "tencent"), "r_hk00700")
        self.assertEqual(market.provider_symbol(market.normalize_symbol("AAPL"), "tencent"), "usAAPL")
        self.assertEqual(market.provider_symbol(market.normalize_symbol("AAPL"), "sina"), "gb_AAPL")

    def test_status_is_free_and_does_not_inspect_credentials(self):
        result = market.status()
        serialized = json.dumps(result).lower()
        self.assertFalse(result["network_checked"])
        self.assertFalse(result["credentials_required"])
        self.assertIn('"cost": "free"', serialized)
        self.assertNotIn("token", serialized)

    def test_all_provider_failures_are_bounded_and_actionable(self):
        attempts = []

        def opener(request, **kwargs):
            attempts.append((request.full_url, kwargs["timeout"]))
            raise urllib.error.URLError("downstream unavailable at https://private.invalid/path")

        with self.assertRaisesRegex(market.StockError, "all quote providers failed") as raised:
            market.quote("AAPL", opener=opener, timeout=3)
        self.assertNotIn("private.invalid", str(raised.exception))
        self.assertEqual(len(attempts), 2)
        self.assertIn("qt.gtimg.cn", attempts[0][0])
        self.assertIn("sinajs.cn", attempts[1][0])
        self.assertEqual([timeout for _, timeout in attempts], [3, 3])

    def test_explicit_provider_failure_does_not_silently_change_source(self):
        attempts = []

        def opener(request, **kwargs):
            attempts.append(request.full_url)
            raise urllib.error.URLError("unavailable")

        with self.assertRaises(market.StockError):
            market.quote("601872.SH", provider="tencent", opener=opener)
        self.assertEqual(len(attempts), 1)
        self.assertIn("qt.gtimg.cn", attempts[0])

    def test_quote_failure_returns_error_without_fabricating_or_overwriting_output(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "quote.json"
            output.write_text("previous verified snapshot", encoding="utf-8")
            stdout, stderr = io.StringIO(), io.StringIO()
            with mock.patch.object(market, "quote", side_effect=market.StockError("all quote providers failed")), \
                    contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = market.main(["quote", "--symbol", "601872.SH", "--output", str(output)])
            self.assertEqual(code, 2)
            self.assertEqual(stdout.getvalue(), "")
            self.assertEqual(stderr.getvalue(), "error: all quote providers failed\n")
            self.assertEqual(output.read_text(encoding="utf-8"), "previous verified snapshot")

    def test_invalid_options_fail_before_any_network_attempt(self):
        attempts = []

        def opener(*args, **kwargs):
            attempts.append((args, kwargs))
            return response(TENCENT_A)

        invalid = [
            {"provider": "unknown"},
            {"timeout": 0},
            {"timeout": 31},
        ]
        for kwargs in invalid:
            with self.subTest(kwargs=kwargs), self.assertRaises(market.StockError):
                market.quote("601872.SH", opener=opener, **kwargs)
        self.assertEqual(attempts, [])


if __name__ == "__main__":
    unittest.main()
