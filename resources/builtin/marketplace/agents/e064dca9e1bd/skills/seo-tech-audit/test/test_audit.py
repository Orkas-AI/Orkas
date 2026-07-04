"""Unit tests for seo-tech-audit scoring + findings. stdlib unittest, no deps."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from audit import audit, _norm_url  # noqa: E402


def crawl(page, site=None):
    return {"ok": True, "data": {"site": site or {"origin": "https://x.com",
            "robots": {"exists": True, "sitemaps": ["https://x.com/sitemap.xml"]}},
            "pages": [page]}}


GOOD_PAGE = {
    "url": "https://x.com/", "final_url": "https://x.com/", "status_code": 200,
    "https": True, "lang": "en", "title": "X — a clear descriptive title here",
    "title_length": 34, "meta_description": "A meta description of reasonable length that reads well as a search snippet for the page.",
    "canonical": "https://x.com/", "noindex": False, "h1_count": 1,
    "heading_order": [1, 2, 2, 3], "word_count": 1200, "viewport": "width=device-width",
    "images_total": 3, "images_missing_alt": 0, "has_structured_data": True,
    "og_title": "X", "og_image": "/og.jpg",
}

BAD_PAGE = {
    "url": "http://x.com/p", "final_url": "http://x.com/p", "status_code": 200,
    "https": False, "lang": None, "title": "", "title_length": 0,
    "meta_description": None, "canonical": "https://x.com/other", "noindex": True,
    "h1_count": 0, "heading_order": [1, 3], "word_count": 40, "viewport": None,
    "images_total": 4, "images_missing_alt": 4, "has_structured_data": False,
}


class GoodPageTest(unittest.TestCase):
    def setUp(self):
        self.r = audit(crawl(GOOD_PAGE))

    def test_high_health_no_critical(self):
        self.assertGreaterEqual(self.r["health_score"], 90)
        self.assertEqual(self.r["summary"]["critical"], 0)

    def test_no_false_findings(self):
        ids = {f["id"] for f in self.r["findings"]}
        for unexpected in ("title_missing", "meta_desc_missing", "h1_missing",
                           "viewport_missing", "no_structured_data", "not_https",
                           "noindex", "heading_skip", "canonical_elsewhere"):
            self.assertNotIn(unexpected, ids)


class BadPageTest(unittest.TestCase):
    def setUp(self):
        self.r = audit(crawl(BAD_PAGE))
        self.ids = {f["id"] for f in self.r["findings"]}

    def test_low_health(self):
        self.assertEqual(self.r["health_score"], 0)

    def test_critical_findings_present(self):
        for fid in ("not_https", "noindex", "title_missing", "canonical_elsewhere"):
            self.assertIn(fid, self.ids)

    def test_each_finding_has_falsifiable_fields(self):
        for f in self.r["findings"]:
            self.assertTrue(f["evidence"])
            self.assertTrue(f["leading_indicator"])
            self.assertTrue(f["failure_criterion"])
            self.assertEqual(f["data_tier"], "Measured")

    def test_findings_sorted_critical_first(self):
        sev = [f["severity"] for f in self.r["findings"]]
        self.assertEqual(sev[0], "critical")

    def test_heading_skip_detected(self):
        self.assertIn("heading_skip", self.ids)


class LookAlikeTest(unittest.TestCase):
    def test_canonical_trailing_slash_not_flagged(self):
        page = dict(GOOD_PAGE, canonical="https://x.com", final_url="https://x.com/")
        ids = {f["id"] for f in audit(crawl(page))["findings"]}
        self.assertNotIn("canonical_elsewhere", ids)

    def test_canonical_case_and_port_normalized(self):
        self.assertEqual(_norm_url("HTTPS://X.com:443/p/"), _norm_url("https://x.com/p"))

    def test_heading_order_without_skip(self):
        page = dict(GOOD_PAGE, heading_order=[1, 2, 3, 2])
        ids = {f["id"] for f in audit(crawl(page))["findings"]}
        self.assertNotIn("heading_skip", ids)

    def test_404_flagged_client_error(self):
        page = dict(GOOD_PAGE, status_code=404)
        ids = {f["id"] for f in audit(crawl(page))["findings"]}
        self.assertIn("client_error", ids)

    def test_sitemap_undeclared(self):
        r = audit(crawl(GOOD_PAGE, site={"origin": "https://x.com",
                  "robots": {"exists": True, "sitemaps": []}}))
        self.assertIn("sitemap_undeclared", {f["id"] for f in r["findings"]})


class DimensionTest(unittest.TestCase):
    def test_dimension_scores_and_counts(self):
        r = audit(crawl(BAD_PAGE))
        self.assertIn("security", r["dimension_scores"])
        self.assertEqual(r["dimension_scores"]["security"], 75)  # one critical (-25)
        self.assertEqual(r["summary"]["total"], len(r["findings"]))


class WeightAndBranchTest(unittest.TestCase):
    def _ids(self, **overrides):
        r = audit(crawl(dict(GOOD_PAGE, **overrides)))
        return {f["id"] for f in r["findings"]}

    def test_single_finding_weights(self):
        # one HIGH finding: missing meta description (weight 12 off base 100)
        r = audit(crawl(dict(GOOD_PAGE, meta_description=None)))
        self.assertEqual(r["health_score"], 88)
        self.assertEqual(r["summary"]["high"], 1)
        self.assertEqual(r["summary"]["total"], 1)
        # one MEDIUM finding: no structured data (weight 6)
        r = audit(crawl(dict(GOOD_PAGE, has_structured_data=False)))
        self.assertEqual(r["health_score"], 94)
        self.assertEqual(r["summary"]["medium"], 1)
        self.assertEqual(r["summary"]["total"], 1)
        # one LOW finding: no canonical declared (weight 2)
        r = audit(crawl(dict(GOOD_PAGE, canonical=None)))
        self.assertEqual(r["health_score"], 98)
        self.assertEqual(r["summary"]["low"], 1)
        self.assertEqual(r["summary"]["total"], 1)

    def test_server_error_branch_and_boundary(self):
        s500 = self._ids(status_code=500)
        self.assertIn("server_error", s500)
        self.assertNotIn("client_error", s500)
        s399 = self._ids(status_code=399)
        self.assertNotIn("server_error", s399)
        self.assertNotIn("client_error", s399)
        s400 = self._ids(status_code=400)
        self.assertIn("client_error", s400)
        self.assertNotIn("server_error", s400)

    def test_canonical_missing_flagged(self):
        ids = self._ids(canonical=None)
        self.assertIn("canonical_missing", ids)
        self.assertNotIn("canonical_elsewhere", ids)

    def test_length_boundaries(self):
        self.assertIn("title_long", self._ids(title_length=61))
        self.assertNotIn("title_long", self._ids(title_length=60))
        self.assertIn("meta_desc_long", self._ids(meta_description="a" * 166))
        self.assertIn("meta_desc_short", self._ids(meta_description="a" * 40))
        mid = self._ids(meta_description="a" * 60)
        self.assertNotIn("meta_desc_long", mid)
        self.assertNotIn("meta_desc_short", mid)

    def test_robots_exists_identity(self):
        missing = audit(crawl(GOOD_PAGE, site={"origin": "https://x.com",
                        "robots": {"exists": False}}))
        self.assertIn("robots_missing", {f["id"] for f in missing["findings"]})
        # robots {} → exists is None, which is NOT `is False`; the elif also needs
        # a truthy exists, so neither finding fires (the `is False` identity trap).
        empty = audit(crawl(GOOD_PAGE, site={"origin": "https://x.com", "robots": {}}))
        empty_ids = {f["id"] for f in empty["findings"]}
        self.assertNotIn("robots_missing", empty_ids)
        self.assertNotIn("sitemap_undeclared", empty_ids)

    def test_page_of_contracts(self):
        with self.assertRaises(ValueError):
            audit({"ok": True, "data": {"pages": []}})
        bare = audit({"pages": [GOOD_PAGE]})  # no "data" wrapper
        self.assertIsInstance(bare, dict)
        self.assertEqual(bare["health_score"], 100)


if __name__ == "__main__":
    unittest.main()
