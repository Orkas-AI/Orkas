"""Unit tests for seo-report dashboard + action plan + schema validation."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from report import build_action_plan, build_dashboard, validate_dashboard  # noqa: E402
from report import _tone_for_percent, _health_tone, _data_of_optional  # noqa: E402

AUDIT = {"ok": True, "data": {
    "health_score": 51,
    "dimension_scores": {"security": 100, "indexability": 88, "content_meta": 76,
                         "structure": 94, "schema": 94, "i18n": 98, "media": 94,
                         "mobile": 100, "crawlability": 98},
    "summary": {"critical": 1, "high": 1, "medium": 2, "low": 1, "total": 5},
    "findings": [
        {"id": "noindex", "dimension": "indexability", "severity": "critical",
         "title": "Page is marked noindex", "evidence": "meta robots = 'noindex'",
         "recommendation": "Remove noindex.", "leading_indicator": "indexable on recrawl",
         "failure_criterion": "still noindex", "data_tier": "Measured"},
        {"id": "meta_desc_missing", "dimension": "content_meta", "severity": "high",
         "title": "Missing meta description", "evidence": "no meta description",
         "recommendation": "Add a description.", "leading_indicator": "CTR up",
         "failure_criterion": "CTR flat", "data_tier": "Measured"},
        {"id": "no_structured_data", "dimension": "schema", "severity": "medium",
         "title": "No structured data", "evidence": "0 JSON-LD", "recommendation": "Add JSON-LD.",
         "leading_indicator": "rich-result eligible", "failure_criterion": "none", "data_tier": "Measured"},
    ],
    "meta": {"url": "https://x.com/", "fetched_at": "2026-06-24T00:00:00Z"},
}}

OPPORTUNITIES = {"ok": True, "data": {
    "summary": {"total": 2, "measured": 1, "estimated": 1},
    "opportunities": [
        {"query": "open source ai assistant", "type": "quick_win", "source": "gsc",
         "data_tier": "Measured", "target_page_url": "https://x.com/",
         "current_signal": "position 11.2, 800 impressions, CTR 1.2%",
         "priority_score": 88, "priority": "High", "confidence": "High",
         "recommended_action": "Rewrite title/meta and add answer-first copy.",
         "leading_indicator": "CTR improves by 20%", "failure_criterion": "CTR stays flat"},
        {"query": "best local ai tools", "type": "geo_gap", "source": "geo-probe",
         "data_tier": "Estimated", "target_page_url": "https://x.com/",
         "current_signal": "brand absent", "priority_score": 63, "priority": "Medium",
         "confidence": "Medium", "recommended_action": "Add quotable FAQ.",
         "leading_indicator": "brand cited", "failure_criterion": "still absent"},
    ],
}}

GEO_PROBE = {"ok": True, "data": {
    "brand": "X", "domain": "x.com", "answers_scored": 2, "retrieval_answers": 1,
    "share_of_voice": 0.5, "citation_rate": 0.25, "brand_mentions": 1,
    "domain_citations": 1, "competitor_share": {"Cline": 0.5},
    "data_tier": "Estimated",
    "per_answer": [
        {"query": "best local ai tools", "model": "m", "mode": "retrieval",
         "result": "cited", "domain_cited": True, "context_corroborated": True},
        {"query": "best ai coding agent", "model": "m", "mode": "param",
         "result": "absent", "domain_cited": False, "context_corroborated": False},
    ],
}}


class DashboardTest(unittest.TestCase):
    def setUp(self):
        self.db = build_dashboard(AUDIT)

    def test_valid_against_schema(self):
        validate_dashboard(self.db)  # must not raise
        self.assertEqual(self.db["schema_version"], 1)
        self.assertEqual(self.db["root"]["type"], "Stack")

    def test_contains_expected_widgets(self):
        types = _collect_types(self.db["root"])
        for t in ("Metric", "Grid", "Chart", "Table", "Alert"):
            self.assertIn(t, types)

    def test_health_metric_tone_negative_when_low(self):
        first = self.db["root"]["children"][0]
        self.assertEqual(first["type"], "Metric")
        self.assertEqual(first["props"]["value"], "51")
        self.assertEqual(first["props"]["tone"], "warning")  # 50<=51<80

    def test_chart_points_have_xy(self):
        chart = next(c for c in self.db["root"]["children"] if c["type"] == "Chart")
        self.assertTrue(all("x" in p and "y" in p for p in chart["props"]["data"]))

    def test_no_findings_still_valid(self):
        empty = {"data": {"health_score": 100, "dimension_scores": {"security": 100},
                          "summary": {"critical": 0, "high": 0, "medium": 0, "low": 0, "total": 0},
                          "findings": [], "meta": {"url": "https://x.com/"}}}
        db = build_dashboard(empty)
        validate_dashboard(db)
        types = _collect_types(db["root"])
        self.assertNotIn("Alert", types)  # no critical/high → no alert
        self.assertNotIn("Table", types)  # no findings → no table


class ValidatorTest(unittest.TestCase):
    def test_rejects_unknown_type(self):
        with self.assertRaises(ValueError):
            validate_dashboard({"schema_version": 1, "root": {"type": "Bogus", "props": {}}})

    def test_rejects_bad_schema_version(self):
        with self.assertRaises(ValueError):
            validate_dashboard({"schema_version": 2, "root": {"type": "Stack", "props": {}}})

    def test_rejects_bad_chart_kind(self):
        with self.assertRaises(ValueError):
            validate_dashboard({"schema_version": 1, "root": {"type": "Chart",
                "props": {"kind": "donut", "data": [{"x": "a", "y": 1}]}}})

    def test_rejects_metric_without_value(self):
        with self.assertRaises(ValueError):
            validate_dashboard({"schema_version": 1, "root": {"type": "Metric", "props": {"label": "x"}}})

    def test_rejects_bad_tone(self):
        with self.assertRaises(ValueError):
            validate_dashboard({"schema_version": 1, "root": {"type": "Metric",
                "props": {"label": "x", "value": "1", "tone": "magenta"}}})


class ActionPlanTest(unittest.TestCase):
    def setUp(self):
        self.md = build_action_plan(AUDIT)

    def test_header_and_sections(self):
        self.assertIn("# SEO/GEO Action Plan", self.md)
        self.assertIn("https://x.com/", self.md)
        self.assertIn("## Critical — fix first", self.md)
        self.assertIn("## High", self.md)

    def test_falsifiable_lines_present(self):
        self.assertIn("Leading indicator:", self.md)
        self.assertIn("Failure criterion:", self.md)

    def test_empty_plan(self):
        md = build_action_plan({"data": {"findings": [], "summary": {}, "meta": {"url": "u"},
                                         "health_score": 100}})
        self.assertIn("No technical issues found", md)


class GeoMergeTest(unittest.TestCase):
    def setUp(self):
        self.data = {"data": dict(AUDIT["data"],
            geo_score=72,
            geo_dimensions={"citability": 60, "structure": 80, "multimodal": 70, "authority": 80, "technical": 70},
            entity_status="partial",
            geo_recommendations=[{"dimension": "geo:authority", "title": "No sameAs",
                "evidence": "no sameAs", "recommendation": "Add sameAs.",
                "leading_indicator": "entity recognized", "failure_criterion": "still ambiguous",
                "data_tier": "Estimated"}])}

    def test_dashboard_has_geo_metric_and_chart(self):
        db = build_dashboard(self.data)
        validate_dashboard(db)
        kids = db["root"]["children"]
        metrics = [c for c in kids if c["type"] == "Metric"]
        self.assertTrue(any(m["props"]["label"] == "GEO Score" for m in metrics))
        charts = [c for c in kids if c["type"] == "Chart"]
        self.assertEqual(len(charts), 2)  # SEO dims + GEO dims

    def test_action_plan_has_geo_section(self):
        md = build_action_plan(self.data)
        self.assertIn("## GEO (Generative Engine Optimization)", md)
        self.assertIn("GEO score: 72/100", md)
        self.assertIn("Entity resolution: partial", md)


class OpportunityAndProbeTest(unittest.TestCase):
    def test_dashboard_has_opportunity_and_probe_sections(self):
        db = build_dashboard(AUDIT, opportunities_obj=OPPORTUNITIES, geo_probe_obj=GEO_PROBE)
        validate_dashboard(db)
        text = str(db)
        self.assertIn("Keyword opportunities", text)
        self.assertIn("GEO Mention SoV", text)
        self.assertIn("open source ai assistant", text)
        self.assertIn("Cline", text)

    def test_action_plan_has_opportunity_and_probe_sections(self):
        md = build_action_plan(AUDIT, opportunities_obj=OPPORTUNITIES, geo_probe_obj=GEO_PROBE)
        self.assertIn("## Keyword Opportunities", md)
        self.assertIn("K1. open source ai assistant", md)
        self.assertIn("## GEO Share-of-Voice Snapshot", md)
        self.assertIn("Mention SoV: 50%", md)


class HelperFunctionTest(unittest.TestCase):
    def test_tone_for_percent_thresholds(self):
        self.assertEqual(_tone_for_percent(0.25), "positive")
        self.assertEqual(_tone_for_percent(0.24), "warning")
        self.assertEqual(_tone_for_percent(0.05), "warning")
        self.assertEqual(_tone_for_percent(0.04), "neutral")
        self.assertEqual(_tone_for_percent(1), "positive")

    def test_health_tone_bands(self):
        self.assertEqual([_health_tone(s) for s in (80, 79, 50, 49, 100, 0)],
                         ["positive", "warning", "warning", "negative", "positive", "negative"])

    def test_data_of_optional_recovery(self):
        self.assertEqual(_data_of_optional(None), {})
        self.assertEqual(_data_of_optional({"data": None}), {})
        self.assertEqual(_data_of_optional({"data": {"a": 1}}), {"a": 1})
        self.assertEqual(_data_of_optional({"a": 1}), {"a": 1})
        self.assertEqual(_data_of_optional([1, 2]), {})


class ValidatorEdgeTest(unittest.TestCase):
    def test_rejects_root_missing(self):
        with self.assertRaisesRegex(ValueError, "root missing"):
            validate_dashboard({"schema_version": 1})

    def test_rejects_chart_empty_data(self):
        with self.assertRaises(ValueError):
            validate_dashboard({"schema_version": 1, "root": {"type": "Chart",
                "props": {"kind": "bar", "data": []}}})

    def test_rejects_chart_point_x_only(self):
        with self.assertRaises(ValueError):
            validate_dashboard({"schema_version": 1, "root": {"type": "Chart",
                "props": {"kind": "bar", "data": [{"x": "a"}]}}})

    def test_accepts_chart_point_label_value(self):
        # look-alike of x/y points: label/value is the alternate accepted shape
        validate_dashboard({"schema_version": 1, "root": {"type": "Chart",
            "props": {"kind": "pie", "data": [{"label": "a", "value": 1}]}}})  # must not raise

    def test_rejects_table_missing_rows(self):
        with self.assertRaises(ValueError):
            validate_dashboard({"schema_version": 1, "root": {"type": "Table",
                "props": {"columns": []}}})

    def test_rejects_nested_child_with_path(self):
        spec = {"schema_version": 1, "root": {"type": "Stack", "props": {},
            "children": [{"type": "Metric", "props": {"label": "x"}}]}}
        with self.assertRaises(ValueError) as ctx:
            validate_dashboard(spec)
        self.assertIn("root>Stack[0]", str(ctx.exception))


def _mk_finding(i):
    return {"severity": "medium", "dimension": "schema", "title": "Issue {}".format(i),
            "recommendation": "Fix {}".format(i), "evidence": "ev {}".format(i),
            "leading_indicator": "li", "failure_criterion": "fc"}


def _tables(db):
    return [c for c in db["root"]["children"] if c["type"] == "Table"]


def _table_with_label(db, label):
    return next(t for t in _tables(db)
                if any(col["label"] == label for col in t["props"]["columns"]))


class ProbeAndTruncationTest(unittest.TestCase):
    def test_failed_probe_omits_geo_section(self):
        db = build_dashboard(AUDIT, geo_probe_obj={"ok": False, "data": None})
        validate_dashboard(db)
        self.assertNotIn("GEO Mention SoV", str(db))

    def test_findings_table_truncates_at_14_with_note(self):
        audit = {"data": {"health_score": 20, "dimension_scores": {"schema": 50},
                          "summary": {"critical": 0, "high": 0, "medium": 16, "low": 0, "total": 16},
                          "findings": [_mk_finding(i) for i in range(16)],
                          "meta": {"url": "https://x.com/"}}}
        db = build_dashboard(audit)
        validate_dashboard(db)
        findings_table = _table_with_label(db, "Severity")
        self.assertEqual(len(findings_table["props"]["rows"]), 14)
        self.assertIn("+2 more findings", str(db))

        # boundary: exactly 14 findings produces no "more findings" note
        audit14 = {"data": {"health_score": 20, "dimension_scores": {"schema": 50},
                            "summary": {"critical": 0, "high": 0, "medium": 14, "low": 0, "total": 14},
                            "findings": [_mk_finding(i) for i in range(14)],
                            "meta": {"url": "https://x.com/"}}}
        db14 = build_dashboard(audit14)
        validate_dashboard(db14)
        self.assertEqual(len(_table_with_label(db14, "Severity")["props"]["rows"]), 14)
        self.assertNotIn("more findings", str(db14))

    def test_opportunity_table_truncates_at_10(self):
        opps = [{"query": "q{}".format(i), "type": "quick_win", "priority": "High",
                 "priority_score": 50, "data_tier": "Measured"} for i in range(11)]
        db = build_dashboard(AUDIT, opportunities_obj={"data": {"opportunities": opps}})
        validate_dashboard(db)
        opp_table = _table_with_label(db, "Query")
        self.assertEqual(len(opp_table["props"]["rows"]), 10)
        self.assertIn("+1 more keyword opportunities", str(db))

    def test_empty_opportunities_omits_section(self):
        db = build_dashboard(AUDIT, opportunities_obj={"data": {"opportunities": []}})
        validate_dashboard(db)  # still passes
        self.assertNotIn("Keyword opportunities", str(db))


class UrlFallbackAndFormattingTest(unittest.TestCase):
    def test_footer_and_header_use_final_url_fallback(self):
        audit = {"data": {"health_score": 50, "dimension_scores": {}, "summary": {},
                          "findings": [], "meta": {"final_url": "https://final.example/"}}}
        db = build_dashboard(audit)
        footer = db["root"]["children"][-1]
        self.assertEqual(footer["type"], "Markdown")
        self.assertIn("Diagnosed `https://final.example/`", footer["props"]["text"])
        md = build_action_plan(audit)
        self.assertIn("- URL: https://final.example/", md)

    def test_action_plan_geo_percent_formatting(self):
        probe = {"share_of_voice": 0.333, "citation_rate": 0.125,
                 "competitor_share": {"Cline": 0.5, "Foo": 0.125}, "per_answer": []}
        md = build_action_plan(AUDIT, geo_probe_obj=probe)
        self.assertIn("Mention SoV: 33%", md)
        self.assertIn("Citation rate: 12%", md)  # banker's rounding: 12.5 -> 12
        self.assertIn("Competitor share: Cline 50%, Foo 12%", md)


def _collect_types(node, acc=None):
    acc = acc if acc is not None else set()
    acc.add(node.get("type"))
    for ch in node.get("children", []) or []:
        _collect_types(ch, acc)
    return acc


class GeoProbeTruncationTest(unittest.TestCase):
    def test_geo_probe_rows_truncated_with_note(self):
        probe = {"data": {"share_of_voice": 0.1, "citation_rate": 0.1, "answers_scored": 9,
                          "data_tier": "Estimated",
                          "per_answer": [{"query": "q{}".format(i), "mode": "param", "result": "absent",
                                          "domain_cited": False, "context_corroborated": False}
                                         for i in range(9)]}}
        db = build_dashboard(AUDIT, geo_probe_obj=probe)
        validate_dashboard(db)
        self.assertEqual(len(_table_with_label(db, "Prompt")["props"]["rows"]), 8)
        self.assertIn("+1 more prompts", str(db))
        md = build_action_plan(AUDIT, geo_probe_obj=probe)
        self.assertIn("### S8.", md)
        self.assertNotIn("### S9.", md)
        self.assertIn("+1 more prompts", md)


class NonNumericProbeTest(unittest.TestCase):
    def test_non_numeric_competitor_share_does_not_crash(self):
        # An upstream/LLM-derived probe can carry a junk value; it must coerce to
        # 0% rather than crash the whole dashboard + action plan via float().
        probe = {"data": {"share_of_voice": 0.5, "citation_rate": 0.25, "answers_scored": 1,
                          "data_tier": "Estimated", "competitor_share": {"Foo": "n/a", "Bar": 0.3},
                          "per_answer": []}}
        db = build_dashboard(AUDIT, geo_probe_obj=probe)  # must not raise
        validate_dashboard(db)
        self.assertIn("GEO Mention SoV", str(db))
        md = build_action_plan(AUDIT, geo_probe_obj=probe)  # must not raise
        self.assertIn("Foo 0%", md)    # junk value coerced to 0%
        self.assertIn("Bar 30%", md)   # good value preserved


if __name__ == "__main__":
    unittest.main()
