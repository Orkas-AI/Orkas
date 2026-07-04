"""Unit tests for seo-monitor snapshot + drift compare. stdlib unittest."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from monitor import compare, make_snapshot  # noqa: E402


def crawl(page):
    return {"ok": True, "data": {"site": {"fetched_at": "2026-06-24T00:00:00Z"}, "pages": [page]}}


def gsc_result(clicks, impressions, position, start="2026-05-27", end="2026-06-23"):
    """Shape one aggregate row like the gsearch-console `query_search_analytics` output."""
    return {
        "siteUrl": "sc-domain:x.com", "startDate": start, "endDate": end,
        "rows": [{"keys": [start], "clicks": clicks, "impressions": impressions,
                  "ctr": (clicks / impressions) if impressions else 0.0, "position": position}],
    }


def bing_result(clicks, impressions, position=None):
    """Shape Bing GetPageStats/GetQueryStats rows (capitalized fields) via the adapter envelope."""
    row = {"Clicks": clicks, "Impressions": impressions}
    if position is not None:
        row["AvgImpressionPosition"] = position
    return {"siteUrl": "https://x.com/", "rowCount": 1, "rows": [row]}


BASE_PAGE = {
    "url": "https://x.com/", "status_code": 200, "title": "Orkas — AI desktop client",
    "meta_description": "desc", "canonical": "https://x.com/", "noindex": False, "is_indexable": True,
    "h1s": ["Orkas is an AI client"], "h2_count": 6, "og_title": "Orkas", "og_image": "/og.jpg",
    "structured_data_types": ["Organization", "WebSite"], "word_count": 1500,
    "text_sample": "Orkas is a local-first AI client. " * 50,
}


class SnapshotTest(unittest.TestCase):
    def test_snapshot_fields(self):
        s = make_snapshot(crawl(BASE_PAGE), health=90, geo=88)
        self.assertEqual(len(s["content_hash"]), 64)
        self.assertEqual(s["health_score"], 90)
        self.assertEqual(s["structured_data_types"], ["Organization", "WebSite"])

    def test_identical_no_drift(self):
        b = make_snapshot(crawl(BASE_PAGE), 90, 88)
        r = compare(b, dict(b))
        self.assertFalse(r["changed"])
        self.assertEqual(r["summary"]["total"], 0)


class DriftTest(unittest.TestCase):
    def setUp(self):
        self.base = make_snapshot(crawl(BASE_PAGE), 90, 88)

    def ids(self, current_snapshot):
        return {f["id"] for f in compare(self.base, current_snapshot)["drift_findings"]}

    def test_noindex_added_critical(self):
        cur = make_snapshot(crawl(dict(BASE_PAGE, noindex=True, is_indexable=False)), 90, 88)
        r = compare(self.base, cur)
        self.assertIn("noindex_added", {f["id"] for f in r["drift_findings"]})
        self.assertEqual(r["drift_findings"][0]["severity"], "critical")

    def test_schema_removed_critical(self):
        self.assertIn("schema_removed", self.ids(make_snapshot(crawl(dict(BASE_PAGE, structured_data_types=[])), 90, 88)))

    def test_canonical_changed_high(self):
        self.assertIn("canonical_changed", self.ids(make_snapshot(crawl(dict(BASE_PAGE, canonical="https://x.com/other")), 90, 88)))

    def test_title_changed_medium(self):
        self.assertIn("title_changed", self.ids(make_snapshot(crawl(dict(BASE_PAGE, title="Totally different title")), 90, 88)))

    def test_status_error_critical(self):
        self.assertIn("status_code_error", self.ids(make_snapshot(crawl(dict(BASE_PAGE, status_code=404)), 90, 88)))

    def test_word_count_drop(self):
        cur = make_snapshot(crawl(dict(BASE_PAGE, word_count=500)), 90, 88)
        self.assertIn("word_count_dropped", self.ids(cur))

    def test_content_change_info(self):
        cur = make_snapshot(crawl(dict(BASE_PAGE, text_sample="completely different body text here")), 90, 88)
        self.assertIn("content_hash_changed", self.ids(cur))

    def test_health_regressed_severity(self):
        cur = make_snapshot(crawl(BASE_PAGE), health=65, geo=88)  # -25 → high
        fs = compare(self.base, cur)["drift_findings"]
        hr = [f for f in fs if f["id"] == "health_regressed"]
        self.assertTrue(hr and hr[0]["severity"] == "high")

    def test_small_health_drop_medium(self):
        cur = make_snapshot(crawl(BASE_PAGE), health=78, geo=88)  # -12 → medium
        hr = [f for f in compare(self.base, cur)["drift_findings"] if f["id"] == "health_regressed"]
        self.assertTrue(hr and hr[0]["severity"] == "medium")

    def test_no_false_drift_on_tiny_meta_noop(self):
        # identical except an unrelated field not tracked → no drift
        cur = make_snapshot(crawl(dict(BASE_PAGE, response_time_ms=999)), 90, 88)
        self.assertEqual(self.ids(cur), set())


class CliEnvelopeTest(unittest.TestCase):
    """Regression: compare via CLI must unwrap the {ok, data: snapshot} envelope
    that `snapshot --out` writes (not diff the wrappers)."""

    def test_compare_main_unwraps_envelope(self):
        import json as _json
        import tempfile
        from monitor import main
        base = make_snapshot(crawl(BASE_PAGE), 90, 88)
        cur = make_snapshot(crawl(dict(BASE_PAGE, noindex=True, is_indexable=False, structured_data_types=[])), 70, 88)
        d = tempfile.mkdtemp()
        bp, cp = os.path.join(d, "b.json"), os.path.join(d, "c.json")
        _json.dump({"ok": True, "data": base}, open(bp, "w"))   # envelope form
        _json.dump({"ok": True, "data": cur}, open(cp, "w"))
        out = main(["--op", "compare", "--baseline", bp, "--current", cp])
        ids = {f["id"] for f in out["data"]["drift_findings"]}
        self.assertIn("noindex_added", ids)
        self.assertIn("schema_removed", ids)
        self.assertTrue(out["data"]["changed"])


class GscAggregateTest(unittest.TestCase):
    def test_weighted_position_and_totals(self):
        from monitor import _aggregate_gsc
        obj = {"rows": [
            {"clicks": 10, "impressions": 100, "position": 5.0},
            {"clicks": 1, "impressions": 900, "position": 20.0},
        ], "startDate": "2026-05-27", "endDate": "2026-06-23"}
        agg = _aggregate_gsc(obj)
        self.assertEqual(agg["clicks"], 11)
        self.assertEqual(agg["impressions"], 1000)
        # impression-weighted: (5*100 + 20*900)/1000 = 18.5, NOT the naive mean 12.5
        self.assertAlmostEqual(agg["position"], 18.5, places=2)
        self.assertEqual(agg["rows"], 2)
        self.assertEqual(agg["start"], "2026-05-27")

    def test_empty_or_zero_impression_returns_none(self):
        from monitor import _aggregate_gsc
        self.assertIsNone(_aggregate_gsc({"rows": []}))
        self.assertIsNone(_aggregate_gsc({"rows": [{"clicks": 0, "impressions": 0, "position": 0}]}))
        self.assertIsNone(_aggregate_gsc("garbage"))

    def test_accepts_envelope_and_bare_list(self):
        from monitor import _aggregate_gsc
        rows = [{"clicks": 5, "impressions": 50, "position": 7.0}]
        self.assertEqual(_aggregate_gsc({"ok": True, "data": {"rows": rows}})["clicks"], 5)
        self.assertEqual(_aggregate_gsc(rows)["impressions"], 50)

    def test_snapshot_carries_and_omits_gsc(self):
        s = make_snapshot(crawl(BASE_PAGE), 90, 88, gsc=gsc_result(40, 1000, 8.0))
        self.assertEqual(s["gsc"]["clicks"], 40)
        self.assertEqual(s["gsc"]["impressions"], 1000)
        self.assertIsNone(make_snapshot(crawl(BASE_PAGE), 90, 88)["gsc"])


class GscDriftTest(unittest.TestCase):
    """GSC drift fires only when BOTH snapshots carry totals and the baseline clears the
    traffic floor — and never on improvements."""

    def base(self, clicks, impressions, position):
        return make_snapshot(crawl(BASE_PAGE), 90, 88, gsc=gsc_result(clicks, impressions, position))

    def ids(self, b, c):
        return {f["id"] for f in compare(b, c)["drift_findings"]}

    def test_impressions_drop_fires_measured(self):
        f = [x for x in compare(self.base(40, 1000, 8.0), self.base(38, 600, 8.0))["drift_findings"]
             if x["id"] == "gsc_impressions_dropped"]
        self.assertTrue(f and f[0]["data_tier"] == "Measured")

    def test_big_impressions_drop_high(self):
        f = [x for x in compare(self.base(40, 1000, 8.0), self.base(10, 300, 8.0))["drift_findings"]
             if x["id"] == "gsc_impressions_dropped"]
        self.assertTrue(f and f[0]["severity"] == "high")

    def test_clicks_drop_fires(self):
        # impressions ~flat, clicks halved → only the clicks rule fires
        self.assertIn("gsc_clicks_dropped", self.ids(self.base(40, 1000, 8.0), self.base(20, 950, 8.0)))

    def test_position_worsened_high(self):
        f = [x for x in compare(self.base(40, 1000, 6.0), self.base(40, 1000, 9.5))["drift_findings"]
             if x["id"] == "gsc_position_worsened"]
        self.assertTrue(f and f[0]["severity"] == "high")

    # ---- look-alikes that must NOT fire ----

    def test_low_traffic_swing_does_not_fire(self):
        bad = self.ids(self.base(2, 30, 8.0), self.base(0, 5, 8.0))
        self.assertEqual(bad & {"gsc_impressions_dropped", "gsc_clicks_dropped"}, set())

    def test_position_improved_does_not_fire(self):
        self.assertNotIn("gsc_position_worsened", self.ids(self.base(40, 1000, 9.0), self.base(45, 1000, 5.0)))

    def test_missing_gsc_on_one_side_no_finding(self):
        b = self.base(40, 1000, 8.0)
        c = make_snapshot(crawl(BASE_PAGE), 90, 88)  # current never got GSC
        self.assertEqual({i for i in self.ids(b, c) if i.startswith("gsc_")}, set())


class BingDriftTest(unittest.TestCase):
    """Bing drifts click/impression COUNTS (Measured) but never position (scale ambiguous), and is
    independent of GSC."""

    def base(self, clicks, impressions, position=None):
        return make_snapshot(crawl(BASE_PAGE), 90, 88, bing=bing_result(clicks, impressions, position))

    def ids(self, b, c):
        return {f["id"] for f in compare(b, c)["drift_findings"]}

    def test_snapshot_carries_and_omits_bing(self):
        s = make_snapshot(crawl(BASE_PAGE), 90, 88, bing=bing_result(30, 800, 4.0))
        self.assertEqual(s["bing"]["clicks"], 30)
        self.assertEqual(s["bing"]["impressions"], 800)
        self.assertIsNone(make_snapshot(crawl(BASE_PAGE), 90, 88)["bing"])

    def test_aggregate_capitalized_weighted_position(self):
        from monitor import _aggregate_bing
        agg = _aggregate_bing({"rows": [
            {"Clicks": 10, "Impressions": 100, "AvgImpressionPosition": 3.0},
            {"Clicks": 2, "Impressions": 900, "AvgImpressionPosition": 8.0},
        ]})
        self.assertEqual(agg["clicks"], 12)
        self.assertEqual(agg["impressions"], 1000)
        self.assertAlmostEqual(agg["position"], (3 * 100 + 8 * 900) / 1000, places=2)

    def test_impressions_drop_fires_measured(self):
        f = [x for x in compare(self.base(30, 1000), self.base(28, 600))["drift_findings"]
             if x["id"] == "bing_impressions_dropped"]
        self.assertTrue(f and f[0]["data_tier"] == "Measured")

    def test_clicks_drop_fires(self):
        self.assertIn("bing_clicks_dropped", self.ids(self.base(40, 1000), self.base(18, 950)))

    def test_position_never_drifts_for_bing(self):
        # a large avg-position regression must NOT emit a Bing position finding (counts are flat)
        bad = self.ids(self.base(40, 1000, 4.0), self.base(40, 1000, 12.0))
        self.assertEqual({i for i in bad if i.startswith("bing_")}, set())

    def test_low_traffic_does_not_fire(self):
        self.assertEqual({i for i in self.ids(self.base(2, 30), self.base(0, 5)) if i.startswith("bing_")}, set())

    def test_gsc_and_bing_independent(self):
        b = make_snapshot(crawl(BASE_PAGE), 90, 88, gsc=gsc_result(40, 1000, 8.0), bing=bing_result(30, 1000))
        c = make_snapshot(crawl(BASE_PAGE), 90, 88, gsc=gsc_result(10, 300, 12.0), bing=bing_result(30, 1000))
        ids = {f["id"] for f in compare(b, c)["drift_findings"]}
        self.assertIn("gsc_impressions_dropped", ids)        # GSC dropped
        self.assertNotIn("bing_impressions_dropped", ids)    # Bing flat


class SimTest(unittest.TestCase):
    def test_sim_thresholds(self):
        from monitor import _sim
        # one extra token: |∩|=5, |∪|=6 → 5/6
        self.assertAlmostEqual(_sim("Orkas is an AI client", "Orkas is an AI client today"),
                               0.8333, places=3)
        self.assertEqual(_sim("", ""), 1.0)        # both empty → identical
        self.assertEqual(_sim("a", ""), 0.0)       # one empty → no overlap
        self.assertEqual(_sim("a b", "c d"), 0.0)  # disjoint tokens


class H1AndScoreDriftTest(unittest.TestCase):
    def setUp(self):
        self.base = make_snapshot(crawl(BASE_PAGE), 90, 88)

    def ids(self, cur):
        return {f["id"] for f in compare(self.base, cur)["drift_findings"]}

    def test_h1_minor_edit_vs_rewrite_vs_removal(self):
        # minor edit (sim 5/6 ≥ 0.5), nothing else changed → no drift at all
        minor = make_snapshot(crawl(dict(BASE_PAGE, h1s=["Orkas is an AI client today"])), 90, 88)
        self.assertEqual(compare(self.base, minor)["drift_findings"], [])
        # disjoint rewrite (sim 0) → h1_changed, medium
        major = make_snapshot(crawl(dict(BASE_PAGE, h1s=["Completely unrelated heading"])), 90, 88)
        major_fs = compare(self.base, major)["drift_findings"]
        self.assertEqual({f["id"] for f in major_fs}, {"h1_changed"})
        self.assertEqual(major_fs[0]["severity"], "medium")
        # full removal → h1_removed (high); the h1_changed branch must NOT also fire
        removed_ids = self.ids(make_snapshot(crawl(dict(BASE_PAGE, h1s=[])), 90, 88))
        self.assertIn("h1_removed", removed_ids)
        self.assertNotIn("h1_changed", removed_ids)
        rem_fs = compare(self.base, make_snapshot(crawl(dict(BASE_PAGE, h1s=[])), 90, 88))["drift_findings"]
        self.assertEqual([f["severity"] for f in rem_fs if f["id"] == "h1_removed"], ["high"])

    def test_geo_regressed_has_no_high_tier(self):
        # baseline geo 88 → 60 is a large drop, but GEO has only a single medium tier.
        cur = make_snapshot(crawl(BASE_PAGE), health=90, geo=60)
        fs = compare(self.base, cur)["drift_findings"]
        geo = [f for f in fs if f["id"] == "geo_regressed"]
        self.assertTrue(geo)
        self.assertEqual(geo[0]["severity"], "medium")
        # health is unchanged (90→90) so it must not fire
        self.assertNotIn("health_regressed", {f["id"] for f in fs})


class MakeSnapshotGuardTest(unittest.TestCase):
    def test_make_snapshot_guards(self):
        with self.assertRaises(ValueError):
            make_snapshot({"ok": True, "data": {"pages": []}})   # empty pages
        with self.assertRaises(ValueError):
            make_snapshot([])                                    # not a dict / no pages
        # a bare crawl dict (no ok/data envelope) is accepted
        s = make_snapshot({"pages": [BASE_PAGE]})
        self.assertEqual(s["url"], "https://x.com/")


class SummarySortTest(unittest.TestCase):
    def test_summary_counts_and_sort_order(self):
        from monitor import _SEV_RANK
        base = make_snapshot(crawl(BASE_PAGE), 90, 88)
        cur = make_snapshot(crawl(dict(BASE_PAGE, status_code=404, canonical="https://x.com/other",
                                       title="Different title", structured_data_types=[])), 90, 88)
        r = compare(base, cur)
        fs = r["drift_findings"]
        self.assertEqual([f["id"] for f in fs],
                         ["status_code_error", "schema_removed", "canonical_changed", "title_changed"])
        ranks = [_SEV_RANK[f["severity"]] for f in fs]
        self.assertEqual(ranks, sorted(ranks))  # critical→high→medium→… non-decreasing
        # per-severity counts in summary match the findings
        expected = {}
        for f in fs:
            expected[f["severity"]] = expected.get(f["severity"], 0) + 1
        for sev, n in expected.items():
            self.assertEqual(r["summary"][sev], n)
        self.assertEqual(r["summary"]["total"], len(fs))
        self.assertEqual(r["summary"], {"critical": 2, "high": 1, "medium": 1, "total": 4})


class ThresholdBoundaryTest(unittest.TestCase):
    def gbase(self, clicks, impressions, position):
        return make_snapshot(crawl(BASE_PAGE), 90, 88, gsc=gsc_result(clicks, impressions, position))

    def test_threshold_boundaries(self):
        # GSC position: Δ between 1.5 and 3 → medium (counts flat so only position fires)
        f = [x for x in compare(self.gbase(40, 1000, 8.0), self.gbase(40, 1000, 10.0))["drift_findings"]
             if x["id"] == "gsc_position_worsened"]
        self.assertTrue(f and f[0]["severity"] == "medium")
        # just under the 1.5 floor (Δ1.3) → not flagged
        under = {x["id"] for x in compare(self.gbase(40, 1000, 8.0), self.gbase(40, 1000, 9.3))["drift_findings"]}
        self.assertNotIn("gsc_position_worsened", under)
        # h2 structure: Δ3 fires, Δ2 does not (BASE_PAGE h2_count=6)
        base = make_snapshot(crawl(BASE_PAGE), 90, 88)
        d3 = {f["id"] for f in compare(base, make_snapshot(crawl(dict(BASE_PAGE, h2_count=3)), 90, 88))["drift_findings"]}
        d2 = {f["id"] for f in compare(base, make_snapshot(crawl(dict(BASE_PAGE, h2_count=4)), 90, 88))["drift_findings"]}
        self.assertIn("h2_structure_changed", d3)
        self.assertNotIn("h2_structure_changed", d2)


class PartialBaselineTest(unittest.TestCase):
    def test_missing_baseline_field_does_not_fabricate_drift(self):
        # An old-schema baseline that never recorded `canonical` must not read as
        # a HIGH canonical change when nothing actually changed.
        cur = make_snapshot(crawl(BASE_PAGE), 90, 88)
        b = dict(cur)
        del b["canonical"]
        self.assertEqual(compare(b, cur)["drift_findings"], [])

    def test_empty_baseline_fabricates_no_drift(self):
        cur = make_snapshot(crawl(BASE_PAGE), 90, 88)
        self.assertEqual(compare({}, cur)["drift_findings"], [])


if __name__ == "__main__":
    unittest.main()
