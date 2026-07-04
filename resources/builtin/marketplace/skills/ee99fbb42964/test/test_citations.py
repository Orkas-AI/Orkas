"""Unit tests for deep-research citations (anti-fabrication). stdlib unittest, no deps.

Run:  cd PC/resources/builtin/marketplace/skills/ee99fbb42964 && python3 -m unittest
or:   python3 -m unittest discover -s <skill>/test

Covers BOTH matching shapes (real quotes/DOIs we must accept despite formatting
differences) and look-alike non-matching shapes (paraphrases, wrong-source
quotes, invented DOIs, phantom sources) that must be flagged — per the repo's
text-processing test rule.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import citations  # noqa: E402
from citations import (  # noqa: E402
    MIN_QUOTE_CHARS, _normalize_url, references, verify,
)


# s1 uses a hyphen in "Local-first"; the quote tests feed an en-dash + caps +
# double-spaces variant to prove normalization, not paraphrase, is what passes.
SOURCES = [
    {"id": "s1", "url": "https://example.com/paper", "title": "On Local Agents",
     "date": "2024-05-01", "doi": "10.1234/abcd.5678",
     "text": ("Local-first AI agents keep user data on the device. "
              "The study reports a 42% latency reduction.")},
    {"id": "s2", "url": "https://example.org/blog/", "title": "Cloud Blog",
     "date": "2023-01-01",
     "text": ("Cloud agents stream everything to a server and add round-trip "
              "latency. See 10.5555/xyz.999 for details.")},
]


def _cite(**kw):
    return kw


def _claim(text, *cits):
    return {"text": text, "citations": list(cits)}


def _verify(claims, sources=None):
    return verify({"sources": SOURCES if sources is None else sources, "claims": claims})


class QuoteVerification(unittest.TestCase):
    def test_verified_despite_formatting(self):
        # en-dash for hyphen, uppercase, and collapsed double spaces must still match.
        q = "Local–first  AI  agents keep USER data on the device"
        out = _verify([_claim("Local agents are private.", _cite(source="s1", quote=q))])
        c = out["claims"][0]["citations"][0]
        self.assertEqual(c["quote_status"], "verified")
        self.assertEqual(c["verdict"], "verified")
        self.assertTrue(out["claims"][0]["supported"])
        self.assertEqual(c["ref"], 1)
        self.assertEqual(out["flags"], [])

    def test_paraphrase_is_flagged_not_verified(self):
        # Same meaning, different words — must NOT pass (this is the whole point).
        q = "Local-first AI agents store your data on the phone"
        out = _verify([_claim("x", _cite(source="s1", quote=q))])
        c = out["claims"][0]["citations"][0]
        self.assertEqual(c["quote_status"], "not_found")
        self.assertEqual(c["verdict"], "flagged")
        self.assertFalse(out["claims"][0]["supported"])
        self.assertEqual(out["flags"][0]["issue"], "quote_not_found_in_source")

    def test_real_quote_attributed_to_wrong_source_is_flagged(self):
        # The quote is real — but it lives in s2, and the claim cites s1.
        q = "Cloud agents stream everything to a server"
        out = _verify([_claim("x", _cite(source="s1", quote=q))])
        c = out["claims"][0]["citations"][0]
        self.assertEqual(c["quote_status"], "not_found")
        self.assertEqual(c["verdict"], "flagged")

    def test_fabricated_quote_is_flagged(self):
        out = _verify([_claim("x", _cite(source="s1", quote="agents achieve full sentience overnight"))])
        self.assertEqual(out["claims"][0]["citations"][0]["quote_status"], "not_found")

    def test_short_quote_is_too_short_not_verified(self):
        short = "AI agents"  # < MIN_QUOTE_CHARS after normalization
        self.assertLess(len(short), MIN_QUOTE_CHARS)
        out = _verify([_claim("x", _cite(source="s1", quote=short))])
        c = out["claims"][0]["citations"][0]
        self.assertEqual(c["quote_status"], "too_short")
        self.assertEqual(c["verdict"], "weak")          # real source, just unprovable
        self.assertTrue(out["claims"][0]["supported"])
        self.assertEqual(out["flags"], [])


class DoiVerification(unittest.TestCase):
    def test_doi_matches_source_field(self):
        out = _verify([_claim("x", _cite(source="s1", quote="keep user data on the device",
                                         doi="10.1234/abcd.5678"))])
        self.assertEqual(out["claims"][0]["citations"][0]["doi_status"], "verified")

    def test_doi_found_in_source_text(self):
        out = _verify([_claim("x", _cite(source="s2", quote="add round-trip latency",
                                         doi="10.5555/xyz.999"))])
        self.assertEqual(out["claims"][0]["citations"][0]["doi_status"], "verified")

    def test_malformed_doi_is_flagged(self):
        out = _verify([_claim("x", _cite(source="s1", quote="keep user data on the device",
                                         doi="10/not-a-doi"))])
        c = out["claims"][0]["citations"][0]
        self.assertEqual(c["doi_status"], "malformed")
        self.assertEqual(c["verdict"], "flagged")
        self.assertEqual(out["flags"][0]["issue"], "doi_malformed")

    def test_wellformed_but_absent_doi_is_flagged(self):
        out = _verify([_claim("x", _cite(source="s1", quote="keep user data on the device",
                                         doi="10.9999/invented.111"))])
        c = out["claims"][0]["citations"][0]
        self.assertEqual(c["doi_status"], "unverified")
        self.assertEqual(c["verdict"], "flagged")
        self.assertEqual(out["flags"][0]["issue"], "doi_not_found_in_source")


class SourceResolution(unittest.TestCase):
    def test_unknown_source_is_flagged(self):
        out = _verify([_claim("x", _cite(source="s99", quote="whatever it says here"))])
        c = out["claims"][0]["citations"][0]
        self.assertEqual(c["url_status"], "unknown")
        self.assertEqual(c["verdict"], "flagged")
        self.assertEqual(out["flags"][0]["issue"], "citation_source_not_found")

    def test_resolve_by_url_with_fragment_and_case(self):
        # No source id — resolve by url, tolerating fragment + trailing-slash + host case.
        out = _verify([_claim("x", _cite(url="https://EXAMPLE.com/paper#s2",
                                         quote="keep user data on the device"))])
        c = out["claims"][0]["citations"][0]
        self.assertEqual(c["url_status"], "known")
        self.assertEqual(c["resolved_by"], "url")
        self.assertEqual(c["verdict"], "verified")

    def test_no_quote_no_doi_is_weak_but_supported(self):
        out = _verify([_claim("x", _cite(source="s1"))])
        c = out["claims"][0]["citations"][0]
        self.assertEqual(c["verdict"], "weak")
        self.assertTrue(out["claims"][0]["supported"])


class SourceTextCache(unittest.TestCase):
    def test_source_text_normalized_once_for_repeated_citations(self):
        original = citations._normalize_text
        source_text_normalizations = 0

        def counting_normalize(text):
            nonlocal source_text_normalizations
            if text == SOURCES[0]["text"]:
                source_text_normalizations += 1
            return original(text)

        citations._normalize_text = counting_normalize
        try:
            out = _verify([
                _claim("a", _cite(source="s1", quote="keep user data on the device")),
                _claim("b", _cite(source="s1", quote="The study reports a 42% latency reduction")),
                _claim("c", _cite(source="s1", quote="Local-first AI agents keep user data")),
            ])
        finally:
            citations._normalize_text = original

        self.assertEqual(out["summary"]["verified"], 3)
        self.assertEqual(source_text_normalizations, 1)


class References(unittest.TestCase):
    def test_dedup_same_url_different_ids(self):
        s3 = {"id": "s3", "url": "https://example.com/paper/",  # trailing slash == s1
              "title": "dup", "text": SOURCES[0]["text"]}
        out = verify({"sources": SOURCES + [s3], "claims": [
            _claim("a", _cite(source="s1", quote="keep user data on the device")),
            _claim("b", _cite(source="s3", quote="keep user data on the device")),
        ]})
        self.assertEqual(len(out["references"]), 1)
        self.assertEqual(out["claims"][0]["citations"][0]["ref"], 1)
        self.assertEqual(out["claims"][1]["citations"][0]["ref"], 1)

    def test_numbering_is_first_cited_order(self):
        out = _verify([_claim("a",
                              _cite(source="s2", quote="add round-trip latency"),
                              _cite(source="s1", quote="keep user data on the device"))])
        refs = {r["ref"]: r["url"] for r in out["references"]}
        self.assertEqual(refs[1], "https://example.org/blog/")   # s2 cited first
        self.assertEqual(refs[2], "https://example.com/paper")

    def test_flagged_citations_get_no_reference(self):
        out = _verify([_claim("x", _cite(source="s99", quote="ghost source quote here"))])
        self.assertEqual(out["references"], [])
        self.assertNotIn("ref", out["claims"][0]["citations"][0])


class AbstainAndSummary(unittest.TestCase):
    def test_abstain_when_no_sources(self):
        out = verify({"sources": [], "claims": [_claim("x", _cite(source="s1", quote="anything"))]})
        self.assertTrue(out["abstain"])
        self.assertEqual(out["abstain_reason"], "no_sources")
        self.assertEqual(out["references"], [])

    def test_summary_counts(self):
        out = _verify([
            _claim("ok", _cite(source="s1", quote="keep user data on the device")),   # verified
            _claim("weak", _cite(source="s2")),                                         # weak
            _claim("bad", _cite(source="s1", quote="totally invented sentence here")),  # flagged
        ])
        s = out["summary"]
        self.assertEqual(s["claims"], 3)
        self.assertEqual(s["supported"], 2)
        self.assertEqual(s["unsupported"], 1)
        self.assertEqual(s["verified"], 1)
        self.assertEqual(s["weak"], 1)
        self.assertEqual(s["flagged"], 1)

    def test_references_op_matches_verify(self):
        claims = [_claim("a", _cite(source="s1", quote="keep user data on the device"))]
        ref_out = references({"sources": SOURCES, "claims": claims})
        full = verify({"sources": SOURCES, "claims": claims})
        self.assertEqual(ref_out["references"], full["references"])
        self.assertFalse(ref_out["abstain"])


class UrlNormalization(unittest.TestCase):
    def test_normalize_equivalences(self):
        a = _normalize_url("https://Example.com/Path/")
        b = _normalize_url("https://example.com/Path#frag")
        self.assertEqual(a, b)
        # path case is preserved (paths can be case-sensitive)
        self.assertNotEqual(_normalize_url("https://example.com/Path"),
                            _normalize_url("https://example.com/path"))


if __name__ == "__main__":
    unittest.main()
