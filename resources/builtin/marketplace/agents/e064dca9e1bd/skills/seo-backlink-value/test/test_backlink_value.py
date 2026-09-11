import io
import json
import os
import sys
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from backlink_value import (  # noqa: E402
    InputError,
    LINK_TYPES,
    REFERENCE_MEDIAN_USD,
    evaluate,
    main,
    market_band,
    normalize_link_type,
    percentile,
    quality_gate,
    rank,
    tranco_rank_proxy,
    tranco_trend,
)


SOLID = {
    "domain": "example-blog.com",
    "link_type": "guest_post",
    "quoted_price_usd": 150,
    "metrics": {"dr": 45, "monthly_traffic": 30_000, "organic_share": 0.62, "traffic_trend": 0.05, "domain_age_years": 6},
}


class GateTest(unittest.TestCase):
    def test_solid_site_passes(self):
        got = evaluate(SOLID)
        self.assertEqual(got["gate"]["status"], "pass")
        self.assertEqual(got["gate"]["reasons"], [])
        # DR 45 / 30k visits / 62% organic / flat trend / 6 years: a solid, not
        # top-tier, site (authority 13.5 + traffic 20.1 + organic 12.4 + trend 7 + age 10).
        self.assertEqual(got["quality"]["tier"], "solid")
        self.assertEqual(got["quality"]["score"], 63)
        self.assertEqual(got["quality"]["components"], {"authority": 13.5, "traffic": 20.1, "organic_share": 12.4, "trend": 7.0, "domain_age": 10.0})
        # $150 against a $231-$616 guest-post band (median 385 after the organic boost) is a bargain.
        self.assertEqual(got["value_band_usd"], {"p25": 231.0, "median": 385.0, "p75": 616.0})
        self.assertEqual(got["quote"]["verdict"], "bargain")

    def test_zero_traffic_zombie_is_vetoed(self):
        got = evaluate({"domain": "dead.example", "metrics": {"dr": 25, "monthly_traffic": 40}})
        self.assertEqual(got["gate"]["status"], "avoid")
        self.assertEqual([r["code"] for r in got["gate"]["reasons"]], ["zero_traffic"])
        self.assertEqual(got["quote"]["verdict"], "avoid")
        self.assertEqual(got["quality"]["tier"], "avoid")

    def test_inflated_traffic_is_vetoed_only_when_traffic_is_material(self):
        inflated = evaluate({"domain": "bot.example", "metrics": {"dr": 30, "monthly_traffic": 50_000, "organic_share": 0.05}})
        self.assertIn("inflated_traffic", [r["code"] for r in inflated["gate"]["reasons"]])
        # Negative control: a tiny site with low organic share is a zombie question, not an inflation one.
        small = evaluate({"domain": "small.example", "metrics": {"dr": 30, "monthly_traffic": 600, "organic_share": 0.05}})
        self.assertNotIn("inflated_traffic", [r["code"] for r in small["gate"]["reasons"]])
        self.assertEqual(small["gate"]["status"], "pass")

    def test_link_farm_high_dr_without_audience(self):
        got = evaluate({"domain": "farm.example", "metrics": {"dr": 68, "monthly_traffic": 120}})
        codes = [r["code"] for r in got["gate"]["reasons"]]
        self.assertIn("link_farm", codes)
        # Below the DR floor the same traffic is only a zombie finding.
        low = evaluate({"domain": "lowdr.example", "metrics": {"dr": 20, "monthly_traffic": 120}})
        self.assertEqual([r["code"] for r in low["gate"]["reasons"]], [])

    def test_deindexed_domain_is_vetoed(self):
        got = evaluate({"domain": "gone.example", "metrics": {"dr": 40, "monthly_traffic": 20_000, "indexed": False}})
        self.assertIn("deindexed", [r["code"] for r in got["gate"]["reasons"]])
        ok = evaluate({"domain": "here.example", "metrics": {"dr": 40, "monthly_traffic": 20_000, "indexed": "true"}})
        self.assertEqual(ok["gate"]["status"], "pass")

    def test_missing_metrics_is_insufficient_not_avoid(self):
        got = evaluate({"domain": "unknown.example", "link_type": "homepage"})
        self.assertEqual(got["gate"]["status"], "insufficient_evidence")
        self.assertEqual(got["gate"]["missing_metrics"], ["dr", "monthly_traffic"])
        self.assertIsNone(got["value_band_usd"])
        self.assertEqual(got["quote"]["verdict"], "insufficient_evidence")
        self.assertEqual(got["data_tier"], "insufficient_evidence")
        self.assertTrue(any("ask for the site's DR/DA and monthly traffic" in n for n in got["notes"]))


class BandTest(unittest.TestCase):
    def test_reference_bracket_and_ratios(self):
        market = market_band(45, 30_000)
        self.assertEqual(market["dr_tier"], "40-50")
        self.assertEqual(market["traffic_tier"], "20,000-100,000/mo")
        self.assertEqual(market["data_tier"], "reference_table")
        median = REFERENCE_MEDIAN_USD[4][3]
        self.assertEqual(market["guest_post_band_usd"], {"p25": median * 0.6, "median": float(median), "p75": median * 1.6})

    def test_reference_table_is_monotonic_in_both_axes(self):
        for row in REFERENCE_MEDIAN_USD:
            self.assertEqual(row, sorted(row))
        for col in range(len(REFERENCE_MEDIAN_USD[0])):
            column = [row[col] for row in REFERENCE_MEDIAN_USD]
            self.assertEqual(column, sorted(column))

    def test_top_brackets_clamp(self):
        market = market_band(100, 5_000_000)
        self.assertEqual(market["dr_tier"], "70-101")
        self.assertEqual(market["traffic_tier"], "500,000+/mo")

    def test_observed_prices_replace_the_reference_table(self):
        market = market_band(45, 30_000, observed_prices=[100, 120, 150, 200, 400, 500, 900])
        self.assertEqual(market["data_tier"], "observed_market")
        self.assertEqual(market["guest_post_band_usd"], {"p25": 120.0, "median": 200.0, "p75": 500.0})
        # Negative control: fewer than five observations keep the reference table and say so.
        few = market_band(45, 30_000, observed_prices=[100, "bad", 300])
        self.assertEqual(few["data_tier"], "reference_table")
        self.assertIn("2 observed prices ignored", few["basis"])

    def test_percentile_nearest_rank(self):
        values = [10, 20, 30, 40]
        self.assertEqual(percentile(values, 0.25), 10)
        self.assertEqual(percentile(values, 0.5), 20)
        self.assertEqual(percentile(values, 0.75), 30)
        with self.assertRaises(InputError):
            percentile([], 0.5)


class MultiplierTest(unittest.TestCase):
    def test_link_type_multipliers_scale_the_band(self):
        base = evaluate({**SOLID, "link_type": "guest_post", "metrics": {"dr": 45, "monthly_traffic": 30_000}})["value_band_usd"]
        for link_type, factor in LINK_TYPES.items():
            got = evaluate({**SOLID, "link_type": link_type, "metrics": {"dr": 45, "monthly_traffic": 30_000}})
            self.assertEqual(got["type_multiplier"], factor)
            self.assertAlmostEqual(got["value_band_usd"]["median"], round(base["median"] * factor, 2), places=2)
        self.assertEqual(normalize_link_type("Guest Post"), "guest_post")
        self.assertEqual(normalize_link_type("sitewide"), "homepage")
        self.assertEqual(normalize_link_type("link insertion"), "niche_edit")
        with self.assertRaises(InputError):
            normalize_link_type("banner")

    def test_nofollow_carries_the_no_authority_note(self):
        got = evaluate({**SOLID, "link_type": "nofollow"})
        self.assertTrue(any("Nofollow passes no authority" in n for n in got["notes"]))

    def test_quality_adjustments(self):
        plain = evaluate({"domain": "a.example", "metrics": {"dr": 45, "monthly_traffic": 30_000}})
        self.assertEqual(plain["adjustments"], [])
        boosted = evaluate({"domain": "a.example", "metrics": {"dr": 45, "monthly_traffic": 30_000, "organic_share": 0.7, "relevance": "high"}})
        self.assertEqual([a["code"] for a in boosted["adjustments"]], ["high_organic_share", "relevance_high"])
        self.assertAlmostEqual(boosted["value_band_usd"]["median"], round(plain["value_band_usd"]["median"] * 1.1 * 1.1, 2), places=2)
        cut = evaluate({"domain": "a.example", "metrics": {"dr": 45, "monthly_traffic": 30_000, "traffic_trend": -0.3, "domain_age_years": 0.5, "outbound_links_on_page": 80, "relevance": "low"}})
        self.assertEqual([a["code"] for a in cut["adjustments"]], ["traffic_decline", "young_domain", "link_heavy_page", "relevance_low"])
        self.assertAlmostEqual(cut["value_band_usd"]["median"], round(plain["value_band_usd"]["median"] * 0.85 * 0.9 * 0.9 * 0.8, 2), places=2)
        # Boundary: exactly -15% counts as decline, -14% does not.
        self.assertEqual([a["code"] for a in evaluate({"domain": "b", "metrics": {"dr": 45, "monthly_traffic": 30_000, "traffic_trend": -0.15}})["adjustments"]], ["traffic_decline"])
        self.assertEqual(evaluate({"domain": "b", "metrics": {"dr": 45, "monthly_traffic": 30_000, "traffic_trend": -0.14}})["adjustments"], [])


class QuoteTest(unittest.TestCase):
    def band(self):
        return evaluate({"domain": "q.example", "metrics": {"dr": 45, "monthly_traffic": 30_000}})["value_band_usd"]

    def test_verdicts_follow_the_band(self):
        band = self.band()
        cases = [
            (band["p25"], "bargain"),
            (band["median"], "fair"),
            (band["median"] + 1, "negotiate"),
            (band["p75"], "negotiate"),
            (band["p75"] + 1, "overpriced"),
        ]
        for quote, verdict in cases:
            got = evaluate({"domain": "q.example", "quoted_price_usd": quote, "metrics": {"dr": 45, "monthly_traffic": 30_000}})
            self.assertEqual(got["quote"]["verdict"], verdict, quote)

    def test_no_quote_gives_a_fair_offer_and_a_ceiling(self):
        got = evaluate({"domain": "q.example", "metrics": {"dr": 45, "monthly_traffic": 30_000}})
        self.assertEqual(got["quote"]["verdict"], "no_quote")
        self.assertIn("walk away above", got["quote"]["detail"])

    def test_share_accepts_percentages_and_rejects_nonsense(self):
        got = evaluate({"domain": "p.example", "metrics": {"dr": 45, "monthly_traffic": 30_000, "organic_share": 62}})
        self.assertEqual(got["metrics"]["organic_share"], 0.62)
        with self.assertRaises(InputError):
            evaluate({"domain": "p.example", "metrics": {"dr": 145, "monthly_traffic": 30_000}})
        with self.assertRaises(InputError):
            evaluate({"metrics": {"dr": 45, "monthly_traffic": 30_000}})
        with self.assertRaises(InputError):
            evaluate({"domain": "p.example", "metrics": {"dr": "high", "monthly_traffic": 30_000}})


class RankTest(unittest.TestCase):
    def test_rank_orders_pass_by_value_then_needs_metrics_then_avoid(self):
        got = rank({"candidates": [
            {"domain": "farm.example", "quoted_price_usd": 50, "metrics": {"dr": 70, "monthly_traffic": 100}},
            {"domain": "cheap.example", "quoted_price_usd": 60, "metrics": {"dr": 30, "monthly_traffic": 8_000, "organic_share": 0.7}},
            {"domain": "pricey.example", "quoted_price_usd": 2_000, "metrics": {"dr": 45, "monthly_traffic": 30_000}},
            {"domain": "unknown.example", "quoted_price_usd": 80},
        ]})
        order = [row["domain"] for row in got["candidates"]]
        self.assertEqual(order[0], "cheap.example")
        self.assertEqual(order[-1], "farm.example")
        self.assertEqual(order.index("unknown.example"), 2)
        self.assertEqual([row["rank"] for row in got["candidates"]], [1, 2, 3, 4])
        self.assertEqual(got["buy"], ["cheap.example"])
        self.assertEqual(got["avoid"], ["pricey.example", "farm.example"])
        self.assertEqual(got["needs_metrics"], ["unknown.example"])

    def test_shared_market_prices_apply_to_every_candidate(self):
        prices = [100, 120, 150, 200, 400]
        got = rank({"market_prices": prices, "candidates": [
            {"domain": "a.example", "metrics": {"dr": 45, "monthly_traffic": 30_000}},
            {"domain": "b.example", "metrics": {"dr": 20, "monthly_traffic": 3_000}, "market_prices": [10, 20, 30, 40, 50]},
        ]})
        by_domain = {row["domain"]: row for row in got["candidates"]}
        self.assertEqual(by_domain["a.example"]["market"]["guest_post_band_usd"]["median"], 150.0)
        # A candidate's own list wins over the shared one.
        self.assertEqual(by_domain["b.example"]["market"]["guest_post_band_usd"]["median"], 30.0)

    def test_rank_rejects_bad_payloads(self):
        with self.assertRaises(InputError):
            rank({"candidates": []})
        with self.assertRaises(InputError):
            rank({"candidates": ["x"]})


class PublicProxyTest(unittest.TestCase):
    HISTORY = [{"date": "2026-08-03", "rank": 2061}, {"date": "2026-08-20", "rank": 2060}, {"date": "2026-09-08", "rank": 2140}]

    def test_tranco_rank_maps_to_conservative_tiers(self):
        self.assertEqual(tranco_rank_proxy(2_140), {"monthly_traffic": 750_000.0, "dr": 70.0, "tier": "rank <= 10,000"})
        self.assertEqual(tranco_rank_proxy(120_000)["monthly_traffic"], 50_000.0)
        self.assertEqual(tranco_rank_proxy(999_999)["dr"], 18.0)
        self.assertEqual(tranco_rank_proxy(5_000_000)["tier"], "rank > 1,000,000")
        with self.assertRaises(InputError):
            tranco_rank_proxy(0)

    def test_tranco_trend_needs_two_weeks_and_clamps(self):
        self.assertAlmostEqual(tranco_trend(self.HISTORY), (2061 - 2140) / 2061, places=4)
        self.assertIsNone(tranco_trend([{"date": "2026-09-01", "rank": 100}, {"date": "2026-09-05", "rank": 50}]))
        self.assertIsNone(tranco_trend([{"date": "2026-09-01", "rank": 100}]))
        self.assertEqual(tranco_trend([{"date": "2026-01-01", "rank": 10_000}, {"date": "2026-03-01", "rank": 100}]), 0.5)
        self.assertEqual(tranco_trend([{"date": "2026-01-01", "rank": 100}, {"date": "2026-03-01", "rank": 10_000}]), -0.5)

    def test_proxies_fill_only_missing_metrics_and_label_the_result(self):
        got = evaluate({
            "domain": "ahrefs.com", "link_type": "guest_post", "quoted_price_usd": 500, "as_of": "2026-09-09",
            "proxies": {"tranco_rank": 2140, "tranco_history": self.HISTORY, "rdap_registration": "2010-11-25T15:32:54Z", "site_results": 1200},
        })
        self.assertEqual(got["metrics"]["monthly_traffic"], 750_000.0)
        self.assertEqual(got["metrics"]["dr"], 70.0)
        self.assertAlmostEqual(got["metrics"]["domain_age_years"], 15.79, places=2)
        self.assertTrue(got["metrics"]["indexed"])
        self.assertEqual(got["metric_sources"], {
            "monthly_traffic": "tranco_rank_proxy", "dr": "tranco_rank_proxy",
            "traffic_trend": "tranco_history_proxy", "domain_age_years": "rdap", "indexed": "site_search_proxy",
        })
        self.assertEqual(got["gate"]["status"], "pass")
        self.assertEqual(got["data_tier"], "public_proxy")
        self.assertEqual(got["market"]["data_tier"], "reference_table")
        self.assertTrue(any("organic_share unavailable" in n for n in got["notes"]))
        self.assertTrue(any("treat the median as a ceiling" in n for n in got["notes"]))

    def test_supplied_metrics_win_over_proxies(self):
        got = evaluate({
            "domain": "shop.example", "metrics": {"dr": 22, "monthly_traffic": 4_000},
            "sources": {"dr": "ahrefs", "monthly_traffic": "similarweb"},
            "proxies": {"tranco_rank": 2140},
        })
        self.assertEqual(got["metrics"]["dr"], 22.0)
        self.assertEqual(got["metrics"]["monthly_traffic"], 4_000.0)
        self.assertEqual(got["metric_sources"], {"dr": "ahrefs", "monthly_traffic": "similarweb"})
        self.assertEqual(got["data_tier"], "reference_table")

    def test_unranked_domain_requires_metrics_before_a_purchase_recommendation(self):
        for rank_value in (None, 1_000_001):
            for supplied in ({}, {"dr": 22}, {"monthly_traffic": 4_000}):
                with self.subTest(rank=rank_value, supplied=supplied):
                    got = rank({"candidates": [{
                        "domain": "tiny.example", "quoted_price_usd": 10,
                        "metrics": supplied, "proxies": {"tranco_rank": rank_value},
                    }]})
                    row = got["candidates"][0]
                    missing = [name for name in ("dr", "monthly_traffic") if name not in supplied]
                    self.assertEqual(row["gate"]["status"], "insufficient_evidence")
                    self.assertEqual(row["gate"]["missing_metrics"], missing)
                    self.assertEqual(row["metric_sources"], {name: "supplied" for name in supplied})
                    for name in ("dr", "monthly_traffic"):
                        self.assertEqual(row["metrics"][name], supplied.get(name))
                    self.assertIsNone(row["value_band_usd"])
                    self.assertEqual(row["quote"]["verdict"], "insufficient_evidence")
                    self.assertEqual(got["buy"], [])
                    self.assertEqual(got["avoid"], [])
                    self.assertEqual(got["needs_metrics"], ["tiny.example"])

    def test_unranked_domain_with_supplied_metrics_still_uses_them(self):
        got = evaluate({
            "domain": "tiny.example", "metrics": {"dr": 22, "monthly_traffic": 4_000},
            "proxies": {"tranco_rank": None},
        })
        self.assertEqual(got["metrics"]["dr"], 22.0)
        self.assertEqual(got["metrics"]["monthly_traffic"], 4_000.0)
        self.assertEqual(got["gate"]["reasons"], [])
        self.assertEqual(got["gate"]["status"], "pass")

    def test_empty_search_results_leave_indexation_unknown_without_a_false_veto(self):
        for count in (0, "0"):
            with self.subTest(count=count):
                got = rank({"candidates": [{**SOLID, "proxies": {"site_results": count}}]})
                row = got["candidates"][0]
                self.assertIsNone(row["metrics"]["indexed"])
                self.assertNotIn("indexed", row["metric_sources"])
                self.assertEqual(row["gate"]["status"], "pass")
                self.assertEqual(row["gate"]["reasons"], [])
                self.assertEqual(row["value_band_usd"], evaluate(SOLID)["value_band_usd"])
                self.assertEqual(got["avoid"], [])
                self.assertTrue(any("indexation unknown" in note and "verify" in note for note in row["notes"]))
        missing = evaluate({"domain": "unknown.example", "proxies": {"site_results": 0}})
        self.assertIsNone(missing["metrics"]["indexed"])
        self.assertEqual(missing["gate"]["status"], "insufficient_evidence")
        self.assertEqual(missing["gate"]["missing_metrics"], ["dr", "monthly_traffic"])

    def test_explicit_indexation_wins_over_conflicting_search_results(self):
        for indexed, count, status in ((False, 1200, "avoid"), (True, 0, "pass")):
            with self.subTest(indexed=indexed, count=count):
                got = rank({"candidates": [{
                    **SOLID, "metrics": {**SOLID["metrics"], "indexed": indexed},
                    "sources": {"indexed": "verified_index_status"},
                    "proxies": {"site_results": count},
                }]})
                row = got["candidates"][0]
                self.assertIs(row["metrics"]["indexed"], indexed)
                self.assertEqual(row["metric_sources"]["indexed"], "verified_index_status")
                self.assertEqual(row["gate"]["status"], status)
                self.assertEqual([r["code"] for r in row["gate"]["reasons"]], [] if indexed else ["deindexed"])
                self.assertEqual(got["avoid"], [] if indexed else [SOLID["domain"]])
                if not indexed:
                    self.assertEqual(got["buy"], [])
                    self.assertEqual(row["quote"]["verdict"], "avoid")

    def test_proxies_without_a_rank_signal_leave_traffic_missing(self):
        got = evaluate({"domain": "mystery.example", "proxies": {"rdap_registration": "2024-01-01"}})
        self.assertEqual(got["gate"]["status"], "insufficient_evidence")
        self.assertEqual(got["gate"]["missing_metrics"], ["dr", "monthly_traffic"])
        self.assertEqual(got["metric_sources"], {"domain_age_years": "rdap"})


class CliTest(unittest.TestCase):
    def run_cli(self, argv, payload):
        stdin = sys.stdin
        sys.stdin = io.StringIO(json.dumps(payload))
        out = io.StringIO()
        try:
            with redirect_stdout(out):
                code = main(argv)
        finally:
            sys.stdin = stdin
        return code, json.loads(out.getvalue())

    def test_evaluate_and_rank_envelopes(self):
        code, body = self.run_cli(["--op", "evaluate"], SOLID)
        self.assertEqual(code, 0)
        self.assertTrue(body["ok"])
        self.assertEqual(body["data"]["quote"]["verdict"], "bargain")
        code, body = self.run_cli(["--op", "rank"], {"candidates": [SOLID]})
        self.assertEqual(code, 0)
        self.assertEqual(body["data"]["candidates"][0]["rank"], 1)

    def test_invalid_input_is_a_structured_error(self):
        code, body = self.run_cli(["--op", "evaluate"], {"metrics": {}})
        self.assertEqual(code, 1)
        self.assertFalse(body["ok"])
        self.assertIn("domain is required", body["error"])


if __name__ == "__main__":
    unittest.main()
