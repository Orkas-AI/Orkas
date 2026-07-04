"""Unit tests for geo-score. stdlib unittest."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from geo_score import score_geo, _robots_blocks_ai  # noqa: E402


def crawl(page, robots_text=""):
    return {"ok": True, "data": {
        "site": {"robots": {"text": robots_text}}, "pages": [page]}}


STRONG = {
    "url": "https://x.com/", "https": True, "is_indexable": True,
    "first_paragraph": "X is a local-first desktop AI client; here is exactly what it does and why it matters in one clear sentence.",
    "word_count": 1500, "h1_count": 1, "heading_order": [1, 2, 2, 3, 2],
    "images_total": 4, "images_missing_alt": 0, "external_link_count": 6,
    "structured_data_types": ["Organization", "WebSite"],
    "structured_data": [{"@type": "Organization", "name": "X", "url": "https://x.com",
                         "sameAs": ["https://github.com/x", "https://www.wikidata.org/wiki/Q1"]}],
}

WEAK = {
    "url": "http://x.com/p", "https": False, "is_indexable": False,
    "first_paragraph": "", "word_count": 0, "h1_count": 0, "heading_order": [1, 3],
    "images_total": 0, "images_missing_alt": 0, "external_link_count": 0,
    "structured_data_types": [], "structured_data": [],
}


class StrongTest(unittest.TestCase):
    def setUp(self):
        self.r = score_geo(crawl(STRONG))

    def test_high_score(self):
        self.assertGreaterEqual(self.r["geo_score"], 90)

    def test_entity_recognized(self):
        self.assertEqual(self.r["entity_status"], "recognized")

    def test_dimensions_present(self):
        self.assertEqual(set(self.r["geo_dimensions"]),
                         {"citability", "structure", "multimodal", "authority", "technical"})


class WeakTest(unittest.TestCase):
    def setUp(self):
        self.r = score_geo(crawl(WEAK))

    def test_low_score(self):
        self.assertLess(self.r["geo_score"], 50)

    def test_entity_unrecognized(self):
        self.assertEqual(self.r["entity_status"], "unrecognized")

    def test_recommendations_falsifiable(self):
        self.assertTrue(self.r["geo_recommendations"])
        for rec in self.r["geo_recommendations"]:
            self.assertTrue(rec["leading_indicator"] and rec["failure_criterion"])
            self.assertTrue(rec["dimension"].startswith("geo:"))


class EntityStatusTest(unittest.TestCase):
    def test_partial_when_org_without_sameas(self):
        page = dict(STRONG, structured_data=[{"@type": "Organization", "name": "X", "url": "https://x.com"}])
        self.assertEqual(score_geo(crawl(page))["entity_status"], "partial")


class RobotsTest(unittest.TestCase):
    def test_blocks_wildcard_root(self):
        self.assertEqual(_robots_blocks_ai("User-agent: *\nDisallow: /"), ["*"])

    def test_blocks_named_ai_bot(self):
        self.assertIn("GPTBot", _robots_blocks_ai("User-agent: GPTBot\nDisallow: /"))

    def test_allows_when_specific_path(self):
        self.assertEqual(_robots_blocks_ai("User-agent: *\nDisallow: /admin/"), [])

    def test_robots_block_penalizes_technical(self):
        r = score_geo(crawl(STRONG, robots_text="User-agent: GPTBot\nDisallow: /"))
        self.assertLess(r["geo_dimensions"]["technical"], 100)
        self.assertTrue(any("robots" in rec["title"].lower() for rec in r["geo_recommendations"]))


class StructureSkipTest(unittest.TestCase):
    def test_heading_skip_vs_clean_outline(self):
        # A skipped level (1->2->4, jump of 2) costs 20 structure points and emits a skip rec.
        skip = score_geo(crawl(dict(STRONG, heading_order=[1, 2, 4])))
        self.assertEqual(skip["geo_dimensions"]["structure"], 80)
        self.assertTrue(any("skip" in rec["title"].lower() for rec in skip["geo_recommendations"]))
        # A clean monotonic outline (1->2->3) keeps structure perfect, no skip rec.
        clean = score_geo(crawl(dict(STRONG, heading_order=[1, 2, 3])))
        self.assertEqual(clean["geo_dimensions"]["structure"], 100)
        self.assertFalse(any("skip" in rec["title"].lower() for rec in clean["geo_recommendations"]))


class TechnicalDefaultsTest(unittest.TestCase):
    def test_missing_optional_fields_defaults(self):
        # Drop https + is_indexable: https missing reads falsy (-20), is_indexable defaults True (no -50).
        page = dict(STRONG)
        del page["https"]
        del page["is_indexable"]
        r = score_geo(crawl(page))
        self.assertEqual(r["geo_dimensions"]["technical"], 80)  # 100 - 20 (https only)
        self.assertTrue(any("https" in rec["title"].lower() for rec in r["geo_recommendations"]))
        self.assertFalse(any("indexable" in rec["title"].lower() for rec in r["geo_recommendations"]))

    def test_technical_clamps_at_zero(self):
        # WEAK + AI-block: deductions 50+20+30+20=120 exceed 100; per-deduct max(0,...) clamps to 0.
        r = score_geo(crawl(dict(WEAK), robots_text="User-agent: *\nDisallow: /"))
        self.assertEqual(r["geo_dimensions"]["technical"], 0)  # clamped, not negative
        # geo_score reflects the clamped (non-negative) technical dim.
        self.assertEqual(r["geo_score"], 38)
        self.assertGreaterEqual(r["geo_score"], 0)


class RobotsMultiUAGroupTest(unittest.TestCase):
    def test_consecutive_user_agents_share_one_group(self):
        # Stacked User-agent lines form one group; both must be reported, not just the last.
        self.assertEqual(
            _robots_blocks_ai("User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /"),
            ["ClaudeBot", "GPTBot"])

    def test_user_agent_after_rule_starts_new_group(self):
        # A User-agent following a rule line opens a fresh group (no over-grouping):
        # GPTBot is root-blocked, ClaudeBot is only blocked from /admin.
        txt = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /admin"
        self.assertEqual(_robots_blocks_ai(txt), ["GPTBot"])


if __name__ == "__main__":
    unittest.main()
