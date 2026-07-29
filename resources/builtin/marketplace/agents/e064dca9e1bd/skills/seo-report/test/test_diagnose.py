"""Tests for the bounded SEO/GEO diagnosis orchestrator."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
