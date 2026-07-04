import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from opportunity import (  # noqa: E402
    build_opportunities,
    _ctr,
    _traffic_potential,
    _quick_win_likelihood,
    _priority,
    _topic_terms,
)


CRAWL = {"ok": True, "data": {"site": {"origin": "https://orkas.ai"}, "pages": [{
    "url": "https://orkas.ai/open-source-ai-assistant/",
    "title": "Open Source AI Assistant | Orkas",
    "h1s": ["Open source AI assistant"],
    "first_paragraph": "Orkas is a local-first multi-agent desktop AI assistant for teams.",
}]}}


class OpportunityTest(unittest.TestCase):
    def test_gsc_quick_win(self):
        gsc = {"rows": [{"keys": ["open source ai assistant"], "clicks": 10,
                         "impressions": 800, "ctr": 0.0125, "position": 11.2}]}
        got = build_opportunities(CRAWL, gsc=gsc)
        opp = got["opportunities"][0]
        self.assertEqual(opp["type"], "quick_win")
        self.assertEqual(opp["source"], "gsc")
        self.assertEqual(opp["data_tier"], "Measured")
        self.assertEqual(opp["priority"], "High")

    def test_ctr_gap(self):
        gsc = {"rows": [{"keys": ["ai assistant for research"], "clicks": 3,
                         "impressions": 500, "ctr": 0.006, "position": 5.5}]}
        got = build_opportunities(CRAWL, gsc=gsc)
        self.assertTrue(any(o["type"] == "ctr_gap" for o in got["opportunities"]))

    def test_cannibalization_when_same_query_has_multiple_pages(self):
        gsc_pages = {"rows": [
            {"keys": ["local first ai", "https://orkas.ai/a"], "clicks": 2, "impressions": 80, "position": 12},
            {"keys": ["local first ai", "https://orkas.ai/b"], "clicks": 1, "impressions": 70, "position": 15},
        ]}
        got = build_opportunities(CRAWL, gsc_pages=gsc_pages)
        self.assertTrue(any(o["type"] == "cannibalization" for o in got["opportunities"]))

    def test_no_false_cannibalization_across_query_and_page_exports(self):
        # Look-alike non-match: the same hot query appears in the query-dim
        # export (no page) AND the page-dim export (one real page). The crawl
        # fallback URL must NOT count as a second competing page.
        gsc = {"rows": [{"keys": ["open source ai assistant"], "clicks": 10,
                         "impressions": 800, "position": 11.2}]}
        gsc_pages = {"rows": [{"keys": ["open source ai assistant", "https://orkas.ai/real-page"],
                               "clicks": 2, "impressions": 120, "position": 9}]}
        got = build_opportunities(CRAWL, gsc=gsc, gsc_pages=gsc_pages)
        self.assertFalse(any(o["type"] == "cannibalization" for o in got["opportunities"]))

    def test_low_impression_rows_skipped(self):
        # Below the 20-impression floor → no measured console opportunity.
        gsc = {"rows": [{"keys": ["barely searched phrase"], "clicks": 0,
                         "impressions": 5, "position": 12}]}
        got = build_opportunities(CRAWL, gsc=gsc)
        self.assertFalse(any(o["source"] == "gsc" for o in got["opportunities"]))

    def test_geo_gap_from_probe(self):
        geo = {"data": {"brand": "Orkas", "data_tier": "Estimated",
                        "competitor_share": {"Cline": 0.5},
                        "per_answer": [{"query": "best AI coding agent for teams",
                                        "result": "absent", "domain_cited": False}]}}
        got = build_opportunities(CRAWL, geo_probe=geo)
        geo_opp = next(o for o in got["opportunities"] if o["type"] == "geo_gap")
        self.assertEqual(geo_opp["source"], "geo-probe")
        self.assertIn("quotable", geo_opp["recommended_action"])

    def test_inferred_when_no_console(self):
        got = build_opportunities(CRAWL)
        self.assertGreaterEqual(got["summary"]["estimated"], 1)
        self.assertTrue(all(o["data_tier"] == "Estimated" for o in got["opportunities"]))

    def test_geo_gap_mentioned_uncited_vs_cited(self):
        # mentioned-but-uncited is a gap; mentioned-and-cited is not. The top
        # competitor by share (Cursor 0.7 > Cline 0.5) is surfaced in the signal.
        geo = {"data": {"brand": "Orkas", "data_tier": "Estimated",
                        "competitor_share": {"Cline": 0.5, "Cursor": 0.7},
                        "per_answer": [
                            {"query": "best ai pair programmer", "result": "mentioned",
                             "domain_cited": False},
                            {"query": "top ai ide", "result": "mentioned",
                             "domain_cited": True},
                        ]}}
        got = build_opportunities(CRAWL, geo_probe=geo)
        geo_opps = [o for o in got["opportunities"] if o["type"] == "geo_gap"]
        self.assertEqual(len(geo_opps), 1)
        opp = geo_opps[0]
        self.assertEqual(opp["query"], "best ai pair programmer")
        self.assertEqual(opp["priority"], "Medium")
        self.assertIn("mentioned", opp["current_signal"])
        self.assertIn("Cursor", opp["current_signal"])
        self.assertFalse(any(o["query"] == "top ai ide" for o in got["opportunities"]))

    def test_ctr_gap_uses_computed_ctr_when_field_absent(self):
        # No ctr field on the row → CTR is derived from clicks/impressions
        # (1/500 = 0.2%) and the row classifies as a ctr_gap.
        gsc = {"rows": [{"keys": ["ai code review tool"], "clicks": 1,
                         "impressions": 500, "position": 6}]}
        got = build_opportunities(CRAWL, gsc=gsc)
        gsc_opps = [o for o in got["opportunities"] if o["source"] == "gsc"]
        self.assertEqual(len(gsc_opps), 1)
        self.assertEqual(gsc_opps[0]["type"], "ctr_gap")
        self.assertIn("CTR 0.2%", gsc_opps[0]["current_signal"])
        # Zero-impression rows must not raise ZeroDivisionError.
        self.assertEqual(_ctr({}, 5.0, 0.0), 0.0)

    def test_limit_truncates_and_summary_matches_returned_slice(self):
        gsc = {"rows": [
            {"keys": ["open source ai assistant"], "impressions": 800, "position": 11},
            {"keys": ["self hosted ai assistant"], "impressions": 400, "position": 12},
            {"keys": ["local ai assistant software"], "impressions": 300, "position": 14},
        ]}
        full = build_opportunities(CRAWL, gsc=gsc)
        self.assertEqual(full["summary"], {"total": 5, "measured": 3, "estimated": 2})
        self.assertEqual(len(full["opportunities"]), 5)

        limited = build_opportunities(CRAWL, gsc=gsc, limit=2)
        self.assertEqual(len(limited["opportunities"]), 2)
        self.assertEqual(limited["summary"], {"total": 2, "measured": 2, "estimated": 0})
        s = limited["summary"]
        self.assertEqual(s["measured"] + s["estimated"], s["total"])
        self.assertEqual(s["total"], len(limited["opportunities"]))

    def test_bing_source_and_cross_source_coexistence(self):
        gsc = {"rows": [{"keys": ["ai agent for teams"], "clicks": 10,
                         "impressions": 800, "position": 11}]}
        bing = {"rows": [{"keys": ["ai agent for teams"], "clicks": 4,
                          "impressions": 300, "position": 13}]}
        got = build_opportunities(CRAWL, gsc=gsc, bing=bing)
        quick_wins = [o for o in got["opportunities"] if o["type"] == "quick_win"]
        self.assertEqual(len(quick_wins), 2)
        self.assertEqual({o["source"] for o in quick_wins}, {"gsc", "bing"})

        bing_only = build_opportunities(CRAWL, bing=bing)
        bing_qw = [o for o in bing_only["opportunities"] if o["type"] == "quick_win"]
        self.assertEqual(len(bing_qw), 1)
        self.assertEqual(bing_qw[0]["source"], "bing")

    def test_dedup_keeps_highest_scoring_row(self):
        # Same query (case-insensitive), same type+source → one survivor, the
        # higher-scoring row (900 impressions beats 120), original casing kept.
        gsc = {"rows": [
            {"keys": ["ai assistant for teams"], "clicks": 2, "impressions": 120, "position": 12},
            {"keys": ["AI Assistant For Teams"], "clicks": 10, "impressions": 900, "position": 12},
        ]}
        got = build_opportunities(CRAWL, gsc=gsc)
        matches = [o for o in got["opportunities"] if o["query"].lower() == "ai assistant for teams"]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["priority_score"], 88)
        self.assertEqual(matches[0]["query"], "AI Assistant For Teams")

    def test_inferred_skips_query_already_present_in_console(self):
        # "assistant orkas guide" is one of the inferred queries for the CRAWL
        # page; when it already exists as a measured console row the inferred
        # duplicate is dropped, but the sibling inferred query still appears.
        gsc = {"rows": [{"keys": ["assistant orkas guide"], "clicks": 1,
                         "impressions": 50, "position": 12}]}
        got = build_opportunities(CRAWL, gsc=gsc)
        guide = [o for o in got["opportunities"] if o["query"].lower() == "assistant orkas guide"]
        self.assertEqual(len(guide), 1)
        self.assertEqual(guide[0]["type"], "quick_win")
        self.assertTrue(any(o["query"] == "best assistant orkas tools" and o["type"] == "content_gap"
                            for o in got["opportunities"]))

    def test_capitalized_column_shape_is_parsed(self):
        # Capitalized GSC export columns (Query/Page/Impressions/Position) are
        # read by _key_text/_page_text/_num just like the lowercase shape.
        gsc_pages = {"rows": [
            {"Query": "ai code helper", "Page": "https://orkas.ai/x",
             "Clicks": 2, "Impressions": 80, "Position": 12},
            {"Query": "ai code helper", "Page": "https://orkas.ai/y",
             "Clicks": 1, "Impressions": 70, "Position": 15},
        ]}
        got = build_opportunities(CRAWL, gsc_pages=gsc_pages)
        self.assertTrue(any(o["type"] == "cannibalization" and o["query"] == "ai code helper"
                            for o in got["opportunities"]))
        self.assertTrue(any(o["type"] == "quick_win" for o in got["opportunities"]))

    def test_empty_pages_raises_valueerror(self):
        with self.assertRaises(ValueError):
            build_opportunities({"ok": True, "data": {"pages": []}})
        with self.assertRaises(ValueError):
            build_opportunities({"data": {}})


class ScoringHelperTest(unittest.TestCase):
    def test_scoring_helper_boundaries(self):
        traffic_inputs = (1000, 999, 300, 299, 100, 99, 30, 29, 0)
        self.assertEqual([_traffic_potential(x) for x in traffic_inputs],
                         [95, 80, 80, 65, 65, 45, 45, 25, 25])

        qw_inputs = (None, 0, -5, 3, 3.5, 4, 7.9, 8, 20, 20.5, 21, 40, 41)
        self.assertEqual([_quick_win_likelihood(x) for x in qw_inputs],
                         [35, 35, 35, 25, 20, 65, 65, 95, 95, 20, 50, 50, 20])

        priority_inputs = (75, 74, 50, 49, 100, 0)
        self.assertEqual([_priority(x) for x in priority_inputs],
                         ["High", "Medium", "Medium", "Low", "High", "Low"])

    def test_topic_terms_filters_and_is_deterministic(self):
        page = {"title": "Best Free SEO Tools",
                "h1s": ["SEO Audit Software"],
                "first_paragraph": "Track rankings and backlinks."}
        terms = _topic_terms(page)
        self.assertEqual(terms, ["audit", "software", "track", "rankings"])
        self.assertEqual(terms, _topic_terms(page))


if __name__ == "__main__":
    unittest.main()
