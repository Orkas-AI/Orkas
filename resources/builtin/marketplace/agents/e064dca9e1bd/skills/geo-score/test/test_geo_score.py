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
    def test_unobserved_response_facts_are_unscored_not_assumed(self):
        # These two facts come from a response. Absent, they used to be guessed
        # in opposite directions — a missing https deducted 20 as though the page
        # had been seen on plain http, while a missing is_indexable defaulted to
        # True and passed. A local-file crawl now reports both as None, and
        # neither a deduction nor a pass is honest about a page never contacted.
        for page in (
            {k: v for k, v in STRONG.items() if k not in ("https", "is_indexable")},
            dict(STRONG, https=None, is_indexable=None),
        ):
            r = score_geo(crawl(page))
            self.assertIsNone(r["geo_dimensions"]["technical"])
            self.assertEqual(
                sorted(e["check"] for e in r["not_assessed"]),
                ["https", "is_indexable"],
            )
            titles = " ".join(rec["title"].lower() for rec in r["geo_recommendations"])
            self.assertNotIn("https", titles)
            self.assertNotIn("indexable", titles)

    def test_observed_response_facts_still_deduct(self):
        # The negative control: when the crawl really did see http and a
        # non-indexable page, both deductions stand and nothing is unassessed.
        r = score_geo(crawl(dict(STRONG, https=False, is_indexable=False)))
        self.assertEqual(r["geo_dimensions"]["technical"], 30)  # 100 - 50 - 20
        self.assertEqual(r["not_assessed"], [])
        titles = " ".join(rec["title"].lower() for rec in r["geo_recommendations"])
        self.assertIn("https", titles)
        self.assertIn("indexable", titles)

    def test_technical_clamps_at_zero(self):
        # WEAK + AI-block: deductions 50+20+30+20=120 exceed 100; per-deduct max(0,...) clamps to 0.
        r = score_geo(crawl(dict(WEAK), robots_text="User-agent: *\nDisallow: /"))
        self.assertEqual(r["geo_dimensions"]["technical"], 0)  # clamped, not negative
        # geo_score reflects the clamped (non-negative) technical dim.
        self.assertEqual(r["geo_score"], 38)
        self.assertGreaterEqual(r["geo_score"], 0)


class RobotsCaseAndWildcardTest(unittest.TestCase):
    """UA tokens compare case-insensitively; 'Disallow: /*' equals a root
    disallow; a specific path stays a non-block (look-alike guard)."""

    def test_lowercase_ua_detected_with_canonical_name(self):
        self.assertEqual(_robots_blocks_ai("User-agent: gptbot\nDisallow: /"),
                         ["GPTBot"])

    def test_mixed_case_ua_detected(self):
        self.assertEqual(_robots_blocks_ai("User-Agent: claudebot\nDisallow: /"),
                         ["ClaudeBot"])

    def test_disallow_slash_star_is_root_block(self):
        self.assertEqual(_robots_blocks_ai("User-agent: GPTBot\nDisallow: /*"),
                         ["GPTBot"])

    def test_disallow_specific_path_is_not_root_block(self):
        self.assertEqual(_robots_blocks_ai("User-agent: gptbot\nDisallow: /private"), [])

    def test_disallow_star_prefix_pattern_is_not_root_block(self):
        # Look-alike: "/*x" is a pattern, not the whole-site wildcard.
        self.assertEqual(_robots_blocks_ai("User-agent: GPTBot\nDisallow: /*x"), [])

    def test_unknown_bot_still_ignored_case_insensitively(self):
        self.assertEqual(_robots_blocks_ai("User-agent: randombot\nDisallow: /"), [])


class NestedOrganizationTest(unittest.TestCase):
    """Organization/sameAs are recognized one nesting level down (e.g.
    Article -> publisher), not only at the top level / @graph."""

    def test_publisher_nested_org_recognized(self):
        page = dict(STRONG,
                    structured_data_types=["Article"],
                    structured_data=[{"@type": "Article", "headline": "t",
                                      "publisher": {"@type": "Organization", "name": "X",
                                                    "sameAs": ["https://github.com/x"]}}])
        r = score_geo(crawl(page))
        self.assertEqual(r["entity_status"], "recognized")
        self.assertEqual(r["geo_dimensions"]["authority"], 100)
        self.assertFalse(any("Organization" in rec["title"] for rec in r["geo_recommendations"]))

    def test_author_list_nested_org_recognized(self):
        page = dict(STRONG,
                    structured_data_types=["Article"],
                    structured_data=[{"@type": "Article",
                                      "author": [{"@type": "Organization",
                                                  "sameAs": ["https://x.example"]}]}])
        self.assertEqual(score_geo(crawl(page))["entity_status"], "recognized")

    def test_publisher_string_does_not_crash(self):
        page = dict(STRONG,
                    structured_data_types=["Article"],
                    structured_data=[{"@type": "Article", "publisher": "X Corp",
                                      "keywords": ["a", "b"]}])
        r = score_geo(crawl(page))  # must not raise
        self.assertEqual(r["entity_status"], "unrecognized")

    def test_nested_dict_without_org_type_still_docked(self):
        # Look-alike: a nested publisher object that is NOT typed Organization.
        page = dict(STRONG,
                    structured_data_types=["Article"],
                    structured_data=[{"@type": "Article", "publisher": {"name": "X"}}])
        r = score_geo(crawl(page))
        self.assertEqual(r["entity_status"], "unrecognized")
        self.assertTrue(any(rec["title"] == "No Organization entity"
                            for rec in r["geo_recommendations"]))

    def test_top_level_org_unchanged(self):
        self.assertEqual(score_geo(crawl(STRONG))["entity_status"], "recognized")


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
