"""Unit tests for deep-research academic. stdlib unittest, no deps, no network.

Run:  cd PC/resources/builtin/marketplace/skills/ee99fbb42964 && python3 -m unittest

The deterministic core is the per-source parsers + normalization + host guard;
network I/O is exercised only through monkeypatched fetchers. Covers BOTH real
response shapes and look-alike/malformed shapes (missing fields, bad XML, blocked
hosts) per the repo's text-processing test rule.
"""

import os
import sys
import unittest
import urllib.error
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import academic  # noqa: E402
from academic import (  # noqa: E402
    _AllowlistRedirect, _crossref_date, _dedup_key, _http_get, _norm_doi,
    _openalex_abstract, _rec, parse_arxiv, parse_crossref, parse_openalex,
    parse_semanticscholar, search,
)

ARXIV_XML = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <published>2024-01-02T00:00:00Z</published>
    <title>Local-First AI Agents
       and Privacy</title>
    <summary>We study on-device agents that keep data private.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <arxiv:doi>10.1234/arxiv.0001</arxiv:doi>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00002v1</id>
    <published>2024-02-03T00:00:00Z</published>
    <title>Cloud Agents</title>
    <summary>Server-side agents and latency.</summary>
    <author><name>Grace Hopper</name></author>
  </entry>
</feed>"""

OPENALEX = {"results": [
    {"id": "https://openalex.org/W1", "title": "On-Device Privacy",
     "publication_date": "2023-05-01", "doi": "https://doi.org/10.5555/OA.1",
     "authorships": [{"author": {"display_name": "Ada Lovelace"}},
                     {"author": {"display_name": "Alan Turing"}}],
     "abstract_inverted_index": {"Local": [0], "first": [1], "privacy": [2]}},
    {"id": "https://openalex.org/W2", "display_name": "No Abstract Work",
     "publication_year": 2020, "authorships": [], "abstract_inverted_index": None},
]}

CROSSREF = {"message": {"items": [
    {"title": ["Deep Research Methods"], "DOI": "10.1000/XYZ.1",
     "issued": {"date-parts": [[2022, 3, 4]]},
     "author": [{"given": "Ada", "family": "Lovelace"}, {"name": "Anon Group"}],
     "abstract": "<jats:p>An <b>abstract</b> with tags.</jats:p>",
     "URL": "https://doi.org/10.1000/xyz.1"},
    {"title": ["No Date Paper"], "DOI": "10.1000/xyz.2", "issued": {"date-parts": [[2021]]}, "author": []},
]}}

S2 = {"data": [
    {"paperId": "abc", "title": "S2 Paper", "year": 2019, "abstract": "An abstract.",
     "externalIds": {"DOI": "10.9/S2.1"}, "authors": [{"name": "Ada Lovelace"}], "url": "https://s2.org/abc"},
    {"paperId": "def", "title": "No Abstract", "year": None, "abstract": None,
     "externalIds": {}, "authors": []},
]}


class ArxivParse(unittest.TestCase):
    def test_valid_feed(self):
        recs = parse_arxiv(ARXIV_XML)
        self.assertEqual(len(recs), 2)
        r0 = recs[0]
        self.assertEqual(r0["title"], "Local-First AI Agents and Privacy")   # newline+indent collapsed
        self.assertEqual(r0["authors"], ["Ada Lovelace", "Alan Turing"])
        self.assertEqual(r0["date"], "2024-01-02")
        self.assertEqual(r0["doi"], "10.1234/arxiv.0001")
        self.assertEqual(r0["source"], "arxiv")
        self.assertEqual(r0["url"], "http://arxiv.org/abs/2401.00001v1")
        self.assertIsNone(recs[1]["doi"])

    def test_empty_feed(self):
        self.assertEqual(parse_arxiv('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'), [])

    def test_malformed_xml_raises(self):
        with self.assertRaises(ET.ParseError):
            parse_arxiv("<feed><entry> not closed")


class OpenAlexParse(unittest.TestCase):
    def test_inverted_index_reconstruction(self):
        self.assertEqual(_openalex_abstract({"Hello": [1], "World": [0]}), "World Hello")
        self.assertEqual(_openalex_abstract(None), "")
        self.assertEqual(_openalex_abstract({}), "")

    def test_parse(self):
        recs = parse_openalex(OPENALEX)
        self.assertEqual(len(recs), 2)
        self.assertEqual(recs[0]["title"], "On-Device Privacy")
        self.assertEqual(recs[0]["text"], "Local first privacy")
        self.assertEqual(recs[0]["doi"], "10.5555/oa.1")               # prefix stripped + lowered
        self.assertEqual(recs[0]["authors"], ["Ada Lovelace", "Alan Turing"])
        self.assertEqual(recs[0]["url"], "https://openalex.org/W1")
        self.assertEqual(recs[1]["title"], "No Abstract Work")          # display_name fallback
        self.assertEqual(recs[1]["date"], "2020")
        self.assertEqual(recs[1]["text"], "")

    def test_empty(self):
        self.assertEqual(parse_openalex({}), [])


class CrossrefParse(unittest.TestCase):
    def test_date_parts(self):
        self.assertEqual(_crossref_date({"date-parts": [[2022, 3, 4]]}), "2022-03-04")
        self.assertEqual(_crossref_date({"date-parts": [[2021]]}), "2021")
        self.assertEqual(_crossref_date(None), "")

    def test_parse_strips_tags_and_builds_authors(self):
        recs = parse_crossref(CROSSREF)
        self.assertEqual(recs[0]["title"], "Deep Research Methods")
        self.assertEqual(recs[0]["doi"], "10.1000/xyz.1")
        self.assertEqual(recs[0]["date"], "2022-03-04")
        self.assertEqual(recs[0]["authors"], ["Ada Lovelace", "Anon Group"])
        self.assertEqual(recs[0]["text"], "An abstract with tags.")     # JATS tags stripped
        self.assertEqual(recs[1]["date"], "2021")


class SemanticScholarParse(unittest.TestCase):
    def test_parse(self):
        recs = parse_semanticscholar(S2)
        self.assertEqual(recs[0]["doi"], "10.9/s2.1")
        self.assertEqual(recs[0]["date"], "2019")
        self.assertEqual(recs[0]["text"], "An abstract.")
        self.assertEqual(recs[0]["url"], "https://s2.org/abc")
        self.assertEqual(recs[1]["text"], "")
        self.assertIsNone(recs[1]["date"])
        self.assertIsNone(recs[1]["doi"])


class Normalization(unittest.TestCase):
    def test_norm_doi(self):
        self.assertEqual(_norm_doi("https://doi.org/10.1/AB"), "10.1/ab")
        self.assertEqual(_norm_doi("http://dx.doi.org/10.2/X"), "10.2/x")
        self.assertEqual(_norm_doi("10.3/Y"), "10.3/y")
        self.assertIsNone(_norm_doi(None))
        self.assertIsNone(_norm_doi(""))

    def test_rec_caps_and_cleans_authors(self):
        r = _rec("x", "  Title\n here ", "body", ["  A  ", "", "B"] + ["Z"] * 20, "2024", None, "u", "id")
        self.assertEqual(r["title"], "Title here")
        self.assertEqual(len(r["authors"]), academic.MAX_AUTHORS)
        self.assertEqual(r["authors"][0], "A")
        self.assertNotIn("", r["authors"])


class HostGuard(unittest.TestCase):
    def test_rejects_non_https(self):
        with self.assertRaises(ValueError):
            _http_get("http://api.openalex.org/works", "application/json", 5)

    def test_rejects_non_allowlisted_host(self):
        with self.assertRaises(ValueError):
            _http_get("https://evil.example.com/works", "application/json", 5)

    def test_redirect_to_disallowed_host_blocked(self):
        h = _AllowlistRedirect()
        req = academic.urllib.request.Request("https://export.arxiv.org/api/query")
        with self.assertRaises(urllib.error.HTTPError):
            h.redirect_request(req, None, 302, "Found", {}, "https://evil.example.com/x")


class SearchIntegration(unittest.TestCase):
    def setUp(self):
        self._orig = dict(academic.FETCHERS)

    def tearDown(self):
        academic.FETCHERS = self._orig

    def test_dedup_across_sources_and_error_isolation(self):
        def fake_arxiv(q, l, t):
            return [_rec("arxiv", "Shared Paper", "", [], "2024", "10.1/DUP", "http://a", "a1")]

        def fake_crossref(q, l, t):
            return [_rec("crossref", "Shared Paper", "", [], "2024", "https://doi.org/10.1/dup", "http://c", "c1"),
                    _rec("crossref", "Unique Paper", "", [], "2024", "10.2/u", "http://c2", "c2")]

        def fake_boom(q, l, t):
            raise RuntimeError("network down")

        academic.FETCHERS = {"arxiv": fake_arxiv, "crossref": fake_crossref, "semanticscholar": fake_boom}
        out = search("q", ["arxiv", "crossref", "semanticscholar", "bogus"], 5, 1)

        self.assertEqual(out["count"], 2)                                  # Shared deduped by DOI + Unique
        titles = [r["title"] for r in out["results"]]
        self.assertEqual(titles.count("Shared Paper"), 1)
        self.assertIn("Unique Paper", titles)
        self.assertEqual(out["sources_queried"], ["arxiv", "crossref", "semanticscholar"])  # bogus not queried
        err_sources = {e["source"] for e in out["errors"]}
        self.assertEqual(err_sources, {"semanticscholar", "bogus"})

    def test_dedup_key_prefers_doi_then_title(self):
        self.assertEqual(_dedup_key({"doi": "10.1/x", "title": "T"}), "doi:10.1/x")
        self.assertEqual(_dedup_key({"doi": None, "title": "Some Title"}), "title:some title")


if __name__ == "__main__":
    unittest.main()
