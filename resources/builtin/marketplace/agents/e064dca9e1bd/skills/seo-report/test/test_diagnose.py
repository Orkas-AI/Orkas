"""Tests for the bounded SEO/GEO diagnosis orchestrator."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
sys.path.insert(0, str(HERE.parents[1] / "seo-crawl" / "scripts"))

import diagnose  # noqa: E402
import crawl  # noqa: E402


HTML = """<!doctype html><html lang="en"><head>
<title>Example Product Platform</title>
<meta name="description" content="A clear product description for testing.">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="canonical" href="https://example.com/">
<script type="application/ld+json">{"@type":"Organization","name":"Example"}</script>
</head><body><h1>Example Product Platform</h1>
<p>Example helps teams complete useful work with a reliable product.</p>
<a href="/pricing">Pricing</a></body></html>"""


class DiagnoseTest(unittest.TestCase):
    def test_rejects_dynamic_or_parent_output_paths(self):
        with self.assertRaises(ValueError):
            diagnose._relative_out_dir("/tmp/audit")
        with self.assertRaises(ValueError):
            diagnose._relative_out_dir(r"C:\tmp\audit")
        with self.assertRaises(ValueError):
            diagnose._relative_out_dir(r"\\server\share\audit")
        with self.assertRaises(ValueError):
            diagnose._relative_out_dir("../audit")
        with self.assertRaises(ValueError):
            diagnose._relative_out_dir(r"..\audit")
        self.assertEqual(diagnose._relative_out_dir(".orkas-seo-audit"), Path(".orkas-seo-audit"))

    def test_bounds_and_deduplicates_sample_urls(self):
        self.assertEqual(
            diagnose._sample_urls(["https://example.com/a", "https://example.com/a"]),
            ["https://example.com/a"],
        )
        with self.assertRaises(ValueError):
            diagnose._sample_urls(["file:///tmp/a"])
        with self.assertRaises(ValueError):
            diagnose._sample_urls(["https://example.com/{}".format(i) for i in range(6)])

    def test_runs_root_pipeline_from_an_existing_local_crawl(self):
        with tempfile.TemporaryDirectory() as tmp:
            prior = os.getcwd()
            try:
                os.chdir(tmp)
                html_path = Path("page.html")
                html_path.write_text(HTML, encoding="utf-8")
                crawl_path = Path("crawl.json")
                crawl_path.write_text(
                    json.dumps({"ok": True, "data": crawl.crawl_file(str(html_path), "https://example.com/")}),
                    encoding="utf-8",
                )
                result = diagnose.main([
                    "--crawl", str(crawl_path),
                    "--out-dir", ".orkas-seo-audit",
                ])
                self.assertTrue(result["ok"])
                self.assertIn("dashboard", result)
                self.assertIn("action_plan_md", result)
                self.assertEqual(result["multi_page"], [])
                self.assertEqual(result['page_evidence']['h1s'], ['Example Product Platform'])
                self.assertEqual(result['page_evidence']['source'], 'file')
                for name in (
                    "tech.json",
                    "content.json",
                    "schema.json",
                    "geo.json",
                    "opportunities.json",
                    "multi-summary.json",
                    "report.json",
                ):
                    self.assertTrue((Path(".orkas-seo-audit") / name).is_file(), name)
            finally:
                os.chdir(prior)

    def test_sample_evidence_survives_pipeline_and_partial_failure_without_extra_acquisition(self):
        urls = ['https://example.com/pricing', 'https://example.com/unavailable']
        calls = []
        def run(skill, script, argv, **kwargs):
            calls.append((skill, list(argv)))
            if skill == 'seo-crawl' and argv[0] == urls[1]:
                raise RuntimeError('controlled page failure')
            output = Path(argv[argv.index('--out') + 1])
            if skill == 'seo-crawl':
                output.write_text(json.dumps({'data': {'pages': [{
                    'url': urls[0], 'status_code': 200, 'title': 'Product Plans',
                    'h1s': ['Plans for your team'], 'first_paragraph': 'Compare feature and usage limits.',
                    'meta_description': 'Billing and plan terms', 'canonical': urls[0],
                }]}}), encoding='utf-8')
            else:
                output.write_text(json.dumps({'data': {'health_score': 94, 'geo_score': 86}}), encoding='utf-8')
            return {'ok': True}
        with tempfile.TemporaryDirectory() as tmp, patch.object(diagnose, '_run_script', side_effect=run):
            rows = diagnose._run_samples(urls, Path(tmp))
        self.assertEqual(rows[0]['url'], urls[0])
        self.assertEqual(rows[0]['health_score'], 94)
        self.assertEqual(rows[0]['page_evidence']['h1s'], ['Plans for your team'])
        self.assertEqual(rows[0]['page_evidence']['canonical'], urls[0])
        self.assertFalse(rows[1]['ok'])
        self.assertNotIn('page_evidence', rows[1])
        self.assertEqual([argv[0] for skill, argv in calls if skill == 'seo-crawl'], urls)


if __name__ == "__main__":
    unittest.main()
