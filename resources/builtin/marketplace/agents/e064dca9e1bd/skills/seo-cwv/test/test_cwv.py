"""Unit tests for seo-cwv PSI parsing (no network). stdlib unittest."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from cwv import parse_psi  # noqa: E402

# PSI v5 response shaped like the real API (trimmed).
PSI_POOR_FIELD = {
    "id": "https://x.com/",
    "loadingExperience": {
        "overall_category": "SLOW",
        "metrics": {
            "LARGEST_CONTENTFUL_PAINT_MS": {"percentile": 4200},
            "CUMULATIVE_LAYOUT_SHIFT_SCORE": {"percentile": 30},   # CrUX *100 → 0.30
            "INTERACTION_TO_NEXT_PAINT": {"percentile": 540},
            "FIRST_CONTENTFUL_PAINT_MS": {"percentile": 2200},
        },
    },
    "lighthouseResult": {
        "categories": {"performance": {"score": 0.42}},
        "audits": {
            "largest-contentful-paint": {"numericValue": 4100.5},
            "cumulative-layout-shift": {"numericValue": 0.28},
            "total-blocking-time": {"numericValue": 600},
            "first-contentful-paint": {"numericValue": 2100},
            "speed-index": {"numericValue": 5000},
        },
    },
}

PSI_GOOD_LABONLY = {
    "id": "https://x.com/fast",
    "loadingExperience": {},  # no field data
    "lighthouseResult": {
        "categories": {"performance": {"score": 0.97}},
        "audits": {
            "largest-contentful-paint": {"numericValue": 1800},
            "cumulative-layout-shift": {"numericValue": 0.02},
            "total-blocking-time": {"numericValue": 50},
            "first-contentful-paint": {"numericValue": 900},
        },
    },
}


class FieldParseTest(unittest.TestCase):
    def setUp(self):
        self.r = parse_psi(PSI_POOR_FIELD, "mobile")

    def test_scores_and_metrics(self):
        self.assertEqual(self.r["performance_score"], 42)
        self.assertEqual(self.r["field"]["lcp_ms"], 4200)
        self.assertEqual(self.r["field"]["cls"], 0.3)   # 30/100
        self.assertEqual(self.r["field"]["inp_ms"], 540)
        self.assertTrue(self.r["field"]["has_field_data"])

    def test_findings_use_field_and_measured(self):
        ids = {f["id"] for f in self.r["findings"]}
        self.assertIn("lcp_poor", ids)
        self.assertIn("cls_poor", ids)
        self.assertIn("inp_poor", ids)
        self.assertIn("perf_score_low", ids)
        cwv = [f for f in self.r["findings"] if f["id"] in ("lcp_poor", "cls_poor", "inp_poor")]
        self.assertTrue(all(f["data_tier"] == "Measured" for f in cwv))
        self.assertTrue(all(f["dimension"] == "performance" for f in self.r["findings"]))

    def test_falsifiable_fields(self):
        for f in self.r["findings"]:
            self.assertTrue(f["leading_indicator"] and f["failure_criterion"])


class LabOnlyTest(unittest.TestCase):
    def setUp(self):
        self.r = parse_psi(PSI_GOOD_LABONLY, "mobile")

    def test_no_field_uses_lab_estimated(self):
        self.assertFalse(self.r["field"]["has_field_data"])
        # good lab metrics → no CWV findings; high score → no perf finding
        self.assertEqual(self.r["findings"], [])
        self.assertEqual(self.r["lab"]["lcp_ms"], 1800)

    def test_lab_lcp_drives_finding_when_no_field(self):
        bad = dict(PSI_GOOD_LABONLY)
        bad["lighthouseResult"] = dict(bad["lighthouseResult"],
            audits={"largest-contentful-paint": {"numericValue": 5000}},
            categories={"performance": {"score": 0.4}})
        r = parse_psi(bad, "mobile")
        ids = {f["id"] for f in r["findings"]}
        self.assertIn("lcp_poor", ids)
        self.assertTrue(all(f["data_tier"] == "Estimated" for f in r["findings"] if f["id"] == "lcp_poor"))


class FieldNeedsImproveTest(unittest.TestCase):
    """Field-tier `needs_improve` tiers and threshold boundaries (no lab/perf noise)."""

    def test_cls_needs_improve_field(self):
        r = parse_psi({"id": "u", "loadingExperience": {"metrics": {
            "CUMULATIVE_LAYOUT_SHIFT_SCORE": {"percentile": 15}}}}, "mobile")
        self.assertEqual(r["field"]["cls"], 0.15)  # 15/100
        self.assertEqual({f["id"] for f in r["findings"]}, {"cls_needs_improve"})
        f = r["findings"][0]
        self.assertEqual(f["severity"], "medium")
        self.assertEqual(f["data_tier"], "Measured")

    def test_lcp_needs_improve_boundary(self):
        # percentile 4000 is NOT > 4000, so it is "needs improve", not "poor".
        r = parse_psi({"id": "u", "loadingExperience": {"metrics": {
            "LARGEST_CONTENTFUL_PAINT_MS": {"percentile": 4000}}}}, "mobile")
        ids = {f["id"] for f in r["findings"]}
        self.assertIn("lcp_needs_improve", ids)
        self.assertNotIn("lcp_poor", ids)

    def test_inp_needs_improve_uses_ms_key(self):
        # exercises the _MS key variant of INP and the >200 (not >500) tier.
        r = parse_psi({"id": "u", "loadingExperience": {"metrics": {
            "INTERACTION_TO_NEXT_PAINT_MS": {"percentile": 500}}}}, "mobile")
        self.assertEqual({f["id"] for f in r["findings"]}, {"inp_needs_improve"})

    def test_empty_response_no_crash(self):
        r = parse_psi({}, "mobile")
        self.assertIsNone(r["performance_score"])
        self.assertIsNone(r["lab"]["lcp_ms"])
        self.assertFalse(r["field"]["has_field_data"])
        self.assertEqual(r["findings"], [])


class PartialFieldFallbackTest(unittest.TestCase):
    def test_field_missing_lcp_falls_back_to_lab(self):
        # CrUX carries only CLS; a poor lab LCP must still surface (per-metric
        # fallback) instead of being masked by the global field flag.
        resp = {"id": "https://x.com/",
                "loadingExperience": {"metrics": {"CUMULATIVE_LAYOUT_SHIFT_SCORE": {"percentile": 5}}},
                "lighthouseResult": {"categories": {"performance": {"score": 0.4}},
                                     "audits": {"largest-contentful-paint": {"numericValue": 5000}}}}
        r = parse_psi(resp, "mobile")
        findings = {f["id"]: f for f in r["findings"]}
        self.assertIn("lcp_poor", findings)                        # lab fallback, not masked
        self.assertEqual(findings["lcp_poor"]["data_tier"], "Estimated")  # sourced from lab
        self.assertIn("perf_score_low", findings)                  # perf 40 < 50


if __name__ == "__main__":
    unittest.main()
