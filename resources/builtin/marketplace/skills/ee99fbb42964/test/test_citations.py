"""Unit tests for deep-research citations (anti-fabrication). stdlib unittest, no deps.

Run:  cd PC/resources/builtin/marketplace/skills/ee99fbb42964 && python3 -m unittest
or:   python3 -m unittest discover -s <skill>/test

Covers BOTH matching shapes (real quotes/DOIs we must accept despite formatting
differences) and look-alike non-matching shapes (paraphrases, wrong-source
quotes, invented DOIs, phantom sources) that must be flagged — per the repo's
text-processing test rule.
"""

import os
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import citations  # noqa: E402
from citations import (  # noqa: E402
    MIN_QUOTE_CHARS, _cli_stdout, _enrich_sources_from_evidence_ledger,
    _expand_compact_landscape_payload, _normalize_url, references, verify,
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


def _write_trusted_snapshot(path, url, text, *, content_hash=None):
    row = {
        "schema_version": 1,
        "canonical_url": url,
        "captured_at": "2026-08-20T00:00:00.000Z",
        "content_sha256": (
            content_hash
            if content_hash is not None
            else hashlib.sha256(text.encode("utf-8")).hexdigest()
        ),
        "text": text,
    }
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(row) + "\n")


def _write_single_compact_case(directory, *, source_url, claim):
    input_path = os.path.join(directory, "citations_input.json")
    ledger_path = os.path.join(directory, "evidence_ledger.jsonl")
    with open(input_path, "w", encoding="utf-8") as fh:
        json.dump({
            "compact_landscape": {
                "candidates": [{
                    "candidate": "Example app",
                    "best_for": "Desktop use",
                    "ideal_user": "Desktop user",
                }],
            },
        }, fh)
    with open(ledger_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "id": "claim_os",
            "candidate": "Example app",
            "field": "os",
            "source_id": "official",
            "canonical_url": source_url,
            "quote": claim,
            "claim": claim,
        }) + "\n")
    return input_path


def _comparison_fixture(*, privacy_field="local_offline"):
    facts = {
        "os": "The desktop app supports Windows and macOS.",
        "setup_ease": "The desktop app provides a signed installer.",
        "model_capabilities": "The desktop app supports local language models.",
        privacy_field: (
            "The desktop app runs fully offline."
            if privacy_field == "local_offline"
            else "The desktop app keeps private data on the device."
        ),
        "pricing_cost": "The desktop app is free for personal use.",
        "key_limitations": "The desktop app requires sixteen gigabytes of memory.",
    }
    claims = []
    field_claims = {}
    for field, text in facts.items():
        claim_id = "claim_{}".format(field)
        claims.append({
            "id": claim_id,
            "text": text,
            "citations": [{"source": "official", "quote": text}],
        })
        field_claims[field] = [claim_id]
    row = {
        "candidate": "Example desktop app",
        "best_for": "Everyday private use",
        "os": "Not verified",
        "setup_ease": "Not verified",
        "model_capabilities": "Not verified",
        "local_offline": "Not verified",
        "privacy_data_handling": "Not verified",
        "pricing_cost": "Not verified",
        "key_limitations": "Not verified",
        "ideal_user": "Everyday desktop user",
        "evidence_sources": ["official"],
        "field_claims": field_claims,
        **facts,
    }
    return {
        "sources": [{
            "id": "official",
            "url": "https://example.com/desktop-app",
            "title": "Official desktop app guide",
            "text": " ".join(facts.values()),
        }],
        "claims": claims,
        "comparison": [row],
    }


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
        self.assertFalse(out["claims"][0]["supported"])
        self.assertEqual(out["claims"][0]["support_status"], "unproven")
        self.assertEqual(out["warnings"][0]["issue"], "claim_evidence_alignment_unproven")
        self.assertEqual(out["flags"], [])

    def test_exact_but_unrelated_quote_does_not_support_claim(self):
        sources = SOURCES + [{
            "id": "s3",
            "url": "https://example.net/moon",
            "title": "Lunar observations",
            "text": "The Moon completes one orbit around Earth in approximately 27.3 days.",
        }]
        out = _verify([
            _claim(
                "This treatment cures cancer.",
                _cite(source="s3", quote="The Moon completes one orbit around Earth in approximately 27.3 days."),
            ),
        ], sources=sources)
        citation = out["claims"][0]["citations"][0]
        self.assertEqual(citation["quote_status"], "verified")
        self.assertEqual(citation["verdict"], "verified")
        self.assertEqual(citation["alignment_status"], "unproven")
        self.assertFalse(out["claims"][0]["supported"])
        self.assertEqual(out["claims"][0]["support_status"], "unproven")

    def test_related_chinese_quote_passes_alignment_gate(self):
        source = {
            "id": "zh",
            "url": "https://example.cn/study",
            "text": "临床试验显示，该疗法使部分癌症患者达到完全缓解，但仍需更长期随访。",
        }
        out = _verify([
            _claim(
                "该疗法可能使部分癌症患者完全缓解。",
                _cite(source="zh", quote="该疗法使部分癌症患者达到完全缓解"),
            ),
        ], sources=[source])
        self.assertTrue(out["claims"][0]["supported"])
        self.assertEqual(
            out["claims"][0]["citations"][0]["alignment_status"], "aligned")


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

    def test_no_quote_no_doi_is_weak_and_unproven(self):
        out = _verify([_claim("x", _cite(source="s1"))])
        c = out["claims"][0]["citations"][0]
        self.assertEqual(c["verdict"], "weak")
        self.assertFalse(out["claims"][0]["supported"])
        self.assertEqual(out["claims"][0]["support_status"], "unproven")


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


class CompactLandscapeInput(unittest.TestCase):
    def test_expands_tagged_evidence_and_writes_verified_report(self):
        field_claims = {
            "os": "The desktop app supports Windows and macOS.",
            "setup_ease": "The desktop app provides a signed installer.",
            "model_capabilities": "The desktop app supports local language models.",
            "local_offline": "The desktop app runs fully offline after setup.",
            "pricing_cost": "The desktop app is free for personal use.",
            "key_limitations": "The desktop app requires sixteen gigabytes of memory.",
        }
        with tempfile.TemporaryDirectory() as tmp:
            ledger_path = os.path.join(tmp, "evidence_ledger.jsonl")
            snapshot_path = os.path.join(tmp, "source_snapshots.jsonl")
            input_path = os.path.join(tmp, "citations_input.json")
            output_path = os.path.join(tmp, "citations_output.json")
            report_path = os.path.join(tmp, "RESEARCH-REPORT.md")
            with open(ledger_path, "w", encoding="utf-8") as fh:
                for index, (field, claim) in enumerate(field_claims.items(), 1):
                    fh.write(json.dumps({
                        "id": "claim_{}".format(index),
                        "candidate": "Example desktop app",
                        "field": field,
                        "source_id": "official",
                        "url": "https://example.com/desktop-app",
                        "title": "Official desktop app guide",
                        "source_date": "2026-08-20",
                        "accessed_at": "2026-08-20",
                        "quote": claim,
                        "claim": claim,
                        "limitations": "Official product source only.",
                    }, ensure_ascii=False) + "\n")
            payload = {
                "compact_landscape": {
                    "title": "Example desktop-app comparison",
                    "boundary": "Official evidence accessed on 2026-08-20.",
                    "candidates": [{
                        "candidate": "Example desktop app",
                        "best_for": "Everyday private use",
                        "ideal_user": "Everyday desktop user",
                    }],
                },
            }
            with open(input_path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh)

            _write_trusted_snapshot(
                snapshot_path,
                "https://example.com/desktop-app",
                "\n".join(field_claims.values()),
            )

            with mock.patch.dict(
                os.environ,
                {"ORKAS_DEEP_RESEARCH_EVIDENCE_FILE": snapshot_path},
            ):
                result = citations.main([
                    "--op", "verify",
                    "--input", input_path,
                    "--out", output_path,
                    "--report-out", report_path,
                ])

            data = result["data"]
            self.assertEqual(data["summary"]["supported"], 6)
            self.assertEqual(data["summary"]["comparison_recommendation_ready"], 1)
            self.assertEqual(
                data["compact_landscape_expansion"]["selected_evidence_rows"], 6
            )
            self.assertTrue(os.path.isfile(report_path))
            with open(report_path, encoding="utf-8") as fh:
                report = fh.read()
            self.assertIn("# Example desktop-app comparison", report)
            self.assertIn("Official evidence accessed on 2026-08-20.", report)
            self.assertIn("## Recommendations", report)
            self.assertIn(
                "Recommendations are analytical inferences",
                report,
            )
            self.assertIn("| Candidate | Best for |", report)
            self.assertIn("## Evidence used", report)
            self.assertEqual(
                data["compact_landscape_expansion"]["missing_snapshot_sources"],
                0,
            )

            stdout = _cli_stdout(result, [
                "--input", input_path,
                "--out", output_path,
                "--report-out", report_path,
            ])
            self.assertEqual(stdout["report"]["path"], report_path)
            self.assertNotIn("comparison_markdown", stdout)
            self.assertNotIn("evidence_markdown", stdout)

    def test_fabricated_compact_quote_is_not_supported_by_host_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            input_path = os.path.join(tmp, "citations_input.json")
            ledger_path = os.path.join(tmp, "evidence_ledger.jsonl")
            snapshot_path = os.path.join(tmp, "source_snapshots.jsonl")
            with open(input_path, "w", encoding="utf-8") as fh:
                json.dump({
                    "compact_landscape": {
                        "candidates": [{
                            "candidate": "Example app",
                            "best_for": "Desktop use",
                            "ideal_user": "Desktop user",
                        }],
                    },
                }, fh)
            with open(ledger_path, "w", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "id": "claim_os",
                    "candidate": "Example app",
                    "field": "os",
                    "source_id": "official",
                    "canonical_url": "https://example.com/app",
                    "quote": "The app supports every desktop operating system.",
                    "claim": "The app supports every desktop operating system.",
                }) + "\n")
            _write_trusted_snapshot(
                snapshot_path,
                "https://example.com/app",
                "The official page documents a browser application.",
            )

            with mock.patch.dict(
                os.environ,
                {"ORKAS_DEEP_RESEARCH_EVIDENCE_FILE": snapshot_path},
            ):
                result = citations.main([
                    "--op", "verify",
                    "--input", input_path,
                ])

            data = result["data"]
            self.assertEqual(data["summary"]["supported"], 0)
            self.assertEqual(data["summary"]["flagged"], 1)
            self.assertEqual(data["claims"][0]["citations"][0]["quote_status"], "not_found")

    def test_tampered_host_snapshot_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            input_path = os.path.join(tmp, "citations_input.json")
            ledger_path = os.path.join(tmp, "evidence_ledger.jsonl")
            snapshot_path = os.path.join(tmp, "source_snapshots.jsonl")
            claim = "The app supports Windows and macOS."
            with open(input_path, "w", encoding="utf-8") as fh:
                json.dump({
                    "compact_landscape": {
                        "candidates": [{
                            "candidate": "Example app",
                            "best_for": "Desktop use",
                            "ideal_user": "Desktop user",
                        }],
                    },
                }, fh)
            with open(ledger_path, "w", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "id": "claim_os",
                    "candidate": "Example app",
                    "field": "os",
                    "source_id": "official",
                    "canonical_url": "https://example.com/app",
                    "quote": claim,
                    "claim": claim,
                }) + "\n")
            _write_trusted_snapshot(
                snapshot_path,
                "https://example.com/app",
                claim,
                content_hash="0" * 64,
            )

            with mock.patch.dict(
                os.environ,
                {"ORKAS_DEEP_RESEARCH_EVIDENCE_FILE": snapshot_path},
            ):
                result = citations.main([
                    "--op", "verify",
                    "--input", input_path,
                ])

            expansion = result["data"]["compact_landscape_expansion"]
            self.assertEqual(result["data"]["summary"]["supported"], 0)
            self.assertEqual(expansion["trusted_source_snapshots"]["valid_rows"], 0)
            self.assertEqual(expansion["trusted_source_snapshots"]["invalid_rows"], 1)
            self.assertEqual(expansion["missing_snapshot_sources"], 1)

    def test_compact_quote_cannot_borrow_matching_text_from_another_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            claim = "The app supports Windows and macOS."
            input_path = _write_single_compact_case(
                tmp,
                source_url="https://claimed.example/app",
                claim=claim,
            )
            snapshot_path = os.path.join(tmp, "source_snapshots.jsonl")
            _write_trusted_snapshot(
                snapshot_path,
                "https://different.example/app",
                claim,
            )

            with mock.patch.dict(
                os.environ,
                {"ORKAS_DEEP_RESEARCH_EVIDENCE_FILE": snapshot_path},
            ):
                result = citations.main([
                    "--op", "verify",
                    "--input", input_path,
                ])

            data = result["data"]
            expansion = data["compact_landscape_expansion"]
            self.assertEqual(data["summary"]["supported"], 0)
            self.assertEqual(data["summary"]["flagged"], 1)
            self.assertEqual(
                data["claims"][0]["citations"][0]["quote_status"],
                "not_found",
            )
            self.assertEqual(expansion["missing_snapshot_sources"], 1)

    def test_valid_snapshot_survives_a_partial_trailing_jsonl_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            claim = "The app supports Windows and macOS."
            source_url = "https://example.com/app"
            input_path = _write_single_compact_case(
                tmp,
                source_url=source_url,
                claim=claim,
            )
            snapshot_path = os.path.join(tmp, "source_snapshots.jsonl")
            _write_trusted_snapshot(snapshot_path, source_url, claim)
            with open(snapshot_path, "a", encoding="utf-8") as fh:
                fh.write('{"schema_version":1,"canonical_url":')

            with mock.patch.dict(
                os.environ,
                {"ORKAS_DEEP_RESEARCH_EVIDENCE_FILE": snapshot_path},
            ):
                result = citations.main([
                    "--op", "verify",
                    "--input", input_path,
                ])

            data = result["data"]
            diagnostics = data["compact_landscape_expansion"][
                "trusted_source_snapshots"
            ]
            self.assertEqual(data["summary"]["supported"], 1)
            self.assertEqual(data["summary"]["flagged"], 0)
            self.assertEqual(diagnostics["valid_rows"], 1)
            self.assertEqual(diagnostics["invalid_rows"], 1)
            self.assertEqual(diagnostics["source_urls"], 1)

    def test_compact_field_uses_the_first_evidence_row_that_verifies(self):
        with tempfile.TemporaryDirectory() as tmp:
            input_path = os.path.join(tmp, "citations_input.json")
            ledger_path = os.path.join(tmp, "evidence_ledger.jsonl")
            snapshot_path = os.path.join(tmp, "source_snapshots.jsonl")
            source_url = "https://example.com/app"
            unsupported = "The app supports every desktop operating system."
            supported = "The app supports Windows and macOS."
            with open(input_path, "w", encoding="utf-8") as fh:
                json.dump({
                    "compact_landscape": {
                        "candidates": [{
                            "candidate": "Example app",
                            "best_for": "Desktop use",
                            "ideal_user": "Desktop user",
                        }],
                    },
                }, fh)
            with open(ledger_path, "w", encoding="utf-8") as fh:
                for claim_id, claim in (
                    ("unsupported_os", unsupported),
                    ("supported_os", supported),
                ):
                    fh.write(json.dumps({
                        "id": claim_id,
                        "candidate": "Example app",
                        "field": "os",
                        "source_id": "official",
                        "canonical_url": source_url,
                        "quote": claim,
                        "claim": claim,
                    }) + "\n")
            _write_trusted_snapshot(snapshot_path, source_url, supported)

            with mock.patch.dict(
                os.environ,
                {"ORKAS_DEEP_RESEARCH_EVIDENCE_FILE": snapshot_path},
            ):
                result = citations.main([
                    "--op", "verify",
                    "--input", input_path,
                ])

            data = result["data"]
            self.assertEqual(data["summary"]["supported"], 1)
            self.assertEqual(data["summary"]["flagged"], 0)
            self.assertEqual(data["claims"][0]["id"], "supported_os")
            self.assertIn(supported, data["comparison_rows"][0]["os"])
            self.assertNotIn(unsupported, data["comparison_markdown"])

    def test_compact_field_skips_an_exact_quote_that_does_not_support_its_claim(self):
        with tempfile.TemporaryDirectory() as tmp:
            input_path = os.path.join(tmp, "citations_input.json")
            ledger_path = os.path.join(tmp, "evidence_ledger.jsonl")
            snapshot_path = os.path.join(tmp, "source_snapshots.jsonl")
            source_url = "https://example.com/app"
            unrelated_quote = "The company was founded in 2018."
            unsupported = "The app supports every desktop operating system."
            supported = "The app supports Windows and macOS."
            with open(input_path, "w", encoding="utf-8") as fh:
                json.dump({
                    "compact_landscape": {
                        "candidates": [{
                            "candidate": "Example app",
                            "best_for": "Desktop use",
                            "ideal_user": "Desktop user",
                        }],
                    },
                }, fh)
            with open(ledger_path, "w", encoding="utf-8") as fh:
                for claim_id, claim, quote in (
                    ("misaligned_os", unsupported, unrelated_quote),
                    ("supported_os", supported, supported),
                ):
                    fh.write(json.dumps({
                        "id": claim_id,
                        "candidate": "Example app",
                        "field": "os",
                        "source_id": "official",
                        "canonical_url": source_url,
                        "quote": quote,
                        "claim": claim,
                    }) + "\n")
            _write_trusted_snapshot(
                snapshot_path,
                source_url,
                "{} {}".format(unrelated_quote, supported),
            )

            with mock.patch.dict(
                os.environ,
                {"ORKAS_DEEP_RESEARCH_EVIDENCE_FILE": snapshot_path},
            ):
                result = citations.main([
                    "--op", "verify",
                    "--input", input_path,
                ])

            data = result["data"]
            self.assertEqual(data["summary"]["supported"], 1)
            self.assertEqual(data["summary"]["flagged"], 0)
            self.assertEqual(data["claims"][0]["id"], "supported_os")
            self.assertIn(supported, data["comparison_rows"][0]["os"])
            self.assertNotIn(unsupported, data["comparison_markdown"])

    def test_rejects_mixed_compact_and_expanded_payloads(self):
        with self.assertRaisesRegex(ValueError, "must not be mixed"):
            _expand_compact_landscape_payload({
                "compact_landscape": {"candidates": [{}]},
                "sources": [{"id": "s1"}],
            }, "citations_input.json")

    def test_rejects_one_source_id_bound_to_multiple_urls(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger_path = os.path.join(tmp, "evidence_ledger.jsonl")
            input_path = os.path.join(tmp, "citations_input.json")
            rows = [
                {
                    "id": "claim_os",
                    "candidate": "Example app",
                    "field": "os",
                    "source_id": "official",
                    "canonical_url": "https://example.com/download",
                    "quote": "The app supports Windows and macOS.",
                    "claim": "The app supports Windows and macOS.",
                },
                {
                    "id": "claim_pricing",
                    "candidate": "Example app",
                    "field": "pricing_cost",
                    "source_id": "official",
                    "canonical_url": "https://example.net/pricing",
                    "quote": "The app is free for personal use.",
                    "claim": "The app is free for personal use.",
                },
            ]
            with open(ledger_path, "w", encoding="utf-8") as fh:
                for row in rows:
                    fh.write(json.dumps(row) + "\n")
            with open(input_path, "w", encoding="utf-8") as fh:
                json.dump({
                    "compact_landscape": {
                        "candidates": [{
                            "candidate": "Example app",
                            "best_for": "Personal use",
                            "ideal_user": "Desktop user",
                        }],
                    },
                }, fh)

            with self.assertRaisesRegex(ValueError, "multiple canonical URLs"):
                citations.main(["--op", "verify", "--input", input_path])


class ReferencesContinued(unittest.TestCase):
    def test_numbering_is_first_cited_order(self):
        out = _verify([_claim("a",
                              _cite(source="s2", quote="add round-trip latency"),
                              _cite(source="s1", quote="keep user data on the device"))])
        refs = {r["ref"]: r["url"] for r in out["references"]}
        self.assertEqual(refs[1], "https://example.org/blog/")   # s2 cited first
        self.assertEqual(refs[2], "https://example.com/paper")

    def test_reference_preserves_bibliographic_metadata(self):
        source = {
            **SOURCES[0],
            "authors": ["Ada Lovelace"],
            "publisher": "Example University",
            "pmid": "12345678",
            "source_type": "journal",
        }
        out = verify({"sources": [source], "claims": [
            _claim(
                "User data remains on the device.",
                _cite(source="s1", quote="keep user data on the device"),
            ),
        ]})
        reference = out["references"][0]
        self.assertEqual(reference["authors"], ["Ada Lovelace"])
        self.assertEqual(reference["publisher"], "Example University")
        self.assertEqual(reference["doi"], "10.1234/abcd.5678")
        self.assertEqual(reference["pmid"], "12345678")
        self.assertEqual(reference["source_type"], "journal")

    def test_verified_aligned_citation_emits_delivery_ready_evidence_markdown(self):
        source = {
            **SOURCES[0],
            "accessed_at": "2026-07-28",
            "limitations": "Official project description; no independent usability test.",
        }
        out = verify({"sources": [source], "claims": [
            _claim(
                "User data remains on the device.",
                _cite(source="s1", quote="keep user data on the device"),
            ),
        ]})
        self.assertEqual(len(out["evidence_rows"]), 1)
        row = out["evidence_rows"][0]
        self.assertEqual(row["evidence_id"], "E1")
        self.assertEqual(row["quote"], "keep user data on the device")
        self.assertEqual(row["source_date"], "2024-05-01")
        self.assertEqual(row["accessed_at"], "2026-07-28")
        self.assertIn('"keep user data on the device"', out["evidence_markdown"])
        self.assertIn("[On Local Agents](https://example.com/paper)", out["evidence_markdown"])
        self.assertIn("source/release date: 2024-05-01", out["evidence_markdown"])
        self.assertIn("access date: 2026-07-28", out["evidence_markdown"])
        self.assertIn("— verified —", out["evidence_markdown"])

    def test_evidence_markdown_groups_repeated_source_metadata_without_losing_quotes(self):
        source = {
            **SOURCES[0],
            "accessed_at": "2026-07-28",
            "limitations": "Official project description only.",
        }
        out = verify({"sources": [source], "claims": [
            _claim(
                "User data remains on the device.",
                _cite(source="s1", quote="keep user data on the device"),
            ),
            _claim(
                "The study reports a 42% latency reduction.",
                _cite(source="s1", quote="The study reports a 42% latency reduction."),
            ),
        ]})
        markdown = out["evidence_markdown"]
        self.assertEqual(markdown.count("[On Local Agents](https://example.com/paper)"), 1)
        self.assertEqual(markdown.count("access date: 2026-07-28"), 1)
        self.assertIn("[E1]", markdown)
        self.assertIn("[E2]", markdown)
        self.assertIn('"keep user data on the device"', markdown)
        self.assertIn('"The study reports a 42% latency reduction."', markdown)

    def test_structured_source_candidates_become_atomic_evidence_without_model_claim_splitting(self):
        source = {
            "id": "repo",
            "url": "https://github.com/example/project",
            "title": "example/project",
            "date": "2026-07-28",
            "accessed_at": "2026-07-28",
            "text": "\n".join([
                "Decision evidence candidates (atomic exact excerpts):",
                '- field=os; exact_quote="Supports Windows, macOS, and Linux."',
                '- field=privacy; exact_quote="All data remains on your device."',
                '- field=project_activity; exact_quote="Pushed at: 2026-07-28T10:00:00Z"',
            ]),
        }
        out = verify({
            "sources": [source],
            "claims": [],
            "comparison": [{
                "candidate": "Example",
                "best_for": "Private desktop use",
                "os": "Windows, macOS, Linux",
                "setup_ease": "Not verified",
                "model_capabilities": "Not verified",
                "local_offline": "Not verified",
                "privacy_data_handling": "Data remains on device",
                "pricing_cost": "Not verified",
                "key_limitations": "Not verified",
                "ideal_user": "Everyday user",
                "evidence_sources": ["repo"],
            }],
        })
        self.assertEqual(out["summary"]["structured_evidence_candidates"], 3)
        self.assertEqual(
            [row["field"] for row in out["evidence_rows"]],
            ["os", "privacy", "project_activity"],
        )
        self.assertTrue(all(
            row["verification_basis"] == "structured_source_adapter"
            for row in out["evidence_rows"]
        ))
        self.assertIn("[E1]", out["evidence_markdown"])
        self.assertIn('"All data remains on your device."', out["evidence_markdown"])
        self.assertEqual(out["comparison_rows"][0]["evidence"], "E1, E2")

    def test_github_snapshot_is_classified_in_research_layer(self):
        source = {
            "id": "repo",
            "url": "https://github.com/example/project",
            "title": "example/project",
            "date": "2026-07-28",
            "accessed_at": "2026-07-28",
            "text": "\n".join([
                "Source type: structured GitHub repository snapshot",
                "Repository metadata (authoritative GitHub API values at access time):",
                "- Description: A local-first desktop assistant.",
                "- License SPDX ID: Apache-2.0",
                "- Pushed at: 2026-07-28T10:00:00Z",
                "",
                "Official repository README:",
                "# Example",
                "A desktop assistant for chatting with local documents.",
                "Cross-platform support for Windows, macOS, and Linux.",
                "Install the signed desktop package with no environment setup.",
                "Run local models through Ollama while keeping data on your device.",
                "All user data remains private on your device.",
                "Minimum requirement: 8 GB RAM; a GPU is optional.",
                "Licensed under Apache-2.0.",
            ]),
        }
        out = verify({"sources": [source], "claims": []})

        fields = [row["field"] for row in out["evidence_rows"]]
        self.assertEqual(out["summary"]["structured_evidence_candidates"], 10)
        self.assertEqual(fields[:3], [
            "core_use_case",
            "license_open_source",
            "project_activity",
        ])
        self.assertTrue({
            "os",
            "installation",
            "local_model_path",
            "privacy",
            "hardware_constraints",
        }.issubset(set(fields)))
        self.assertTrue(all(
            row["verification_basis"] == "structured_source_adapter"
            for row in out["evidence_rows"]
        ))

    def test_verifier_emits_complete_comparison_table_from_same_payload(self):
        source = {
            **SOURCES[0],
            "accessed_at": "2026-07-28",
        }
        out = verify({
            "sources": [source],
            "claims": [
                {
                    "id": "c_privacy",
                    **_claim(
                        "User data remains on the device.",
                        _cite(source="s1", quote="keep user data on the device"),
                    ),
                },
            ],
            "comparison": [{
                "candidate": "Local | Agent",
                "best_for": "Private chat",
                "os": "Not verified",
                "setup_ease": "Not verified",
                "model_capabilities": "Not verified",
                "local_offline": "Not verified",
                "privacy_data_handling": "User data remains on the device",
                "pricing_cost": "Not verified",
                "key_limitations": "Not verified",
                "ideal_user": "Everyday desktop user",
                "evidence_sources": ["s1"],
                "field_claims": {"privacy_data_handling": ["c_privacy"]},
            }],
        })
        table = out["comparison_markdown"]
        self.assertTrue(table.startswith(
            "| Candidate | Best for | OS | Setup/ease | Model capabilities | Local/offline | "
            "Privacy/data handling | Pricing/cost | Key limitations | Ideal user | Evidence |"
        ))
        self.assertIn("Local \\| Agent", table)
        self.assertIn("| E1 |", table)
        self.assertEqual(out["comparison_warnings"], [])

    def test_comparison_coverage_marks_a_complete_decision_row_ready(self):
        out = verify(_comparison_fixture())

        coverage = out["comparison_coverage"][0]
        self.assertEqual(coverage["status"], "recommendation_ready")
        self.assertTrue(coverage["recommendation_ready"])
        self.assertEqual(coverage["verified_field_count"], 6)
        self.assertEqual(coverage["factual_field_count"], 7)
        self.assertEqual(coverage["missing_decision_groups"], [])
        self.assertEqual(out["summary"]["comparison_recommendation_ready"], 1)
        self.assertEqual(out["summary"]["comparison_under_evidenced"], 0)
        self.assertIn(
            "**Everyday private use: Example desktop app**",
            out["recommendation_markdown"],
        )
        self.assertIn("material limitation:", out["recommendation_markdown"])
        self.assertIn("[E6]", out["recommendation_markdown"])
        self.assertIn(
            "Recommendations are analytical inferences",
            out["recommendation_markdown"],
        )
        self.assertIn(
            "verified comparison evidence:",
            out["recommendation_markdown"],
        )
        self.assertNotIn("verified recommendation", out["recommendation_markdown"].lower())
        self.assertNotIn("verified pick", out["recommendation_markdown"].lower())

    def test_comparison_coverage_accepts_privacy_instead_of_offline_evidence(self):
        out = verify(_comparison_fixture(privacy_field="privacy_data_handling"))

        coverage = out["comparison_coverage"][0]
        self.assertTrue(coverage["recommendation_ready"])
        self.assertIn("privacy_data_handling", coverage["verified_fields"])
        self.assertIn("local_offline", coverage["not_verified_fields"])

    def test_comparison_coverage_requires_a_material_limitation(self):
        payload = _comparison_fixture()
        row = payload["comparison"][0]
        row["key_limitations"] = "Not verified"
        row["field_claims"].pop("key_limitations")

        out = verify(payload)

        coverage = out["comparison_coverage"][0]
        self.assertFalse(coverage["recommendation_ready"])
        self.assertEqual(coverage["tradeoff_groups_verified"], 2)
        self.assertEqual(coverage["missing_decision_groups"], ["limitations"])
        self.assertEqual(coverage["blocking_decision_groups"], ["limitations"])
        self.assertIn(
            "Conditional path — **Everyday private use: Example desktop app**",
            out["recommendation_markdown"],
        )
        self.assertIn(
            "verify before choosing: limitations",
            out["recommendation_markdown"],
        )
        self.assertIn(
            "current comparison evidence:",
            out["recommendation_markdown"],
        )
        self.assertNotIn(
            "verified comparison evidence:",
            out["recommendation_markdown"],
        )

    def test_comparison_coverage_keeps_honest_gaps_but_downgrades_the_row(self):
        payload = _comparison_fixture()
        row = payload["comparison"][0]
        row["pricing_cost"] = "Not verified"
        row["key_limitations"] = "Not verified"
        row["field_claims"].pop("pricing_cost")
        row["field_claims"].pop("key_limitations")

        out = verify(payload)

        self.assertEqual(out["comparison_warnings"], [])
        coverage = out["comparison_coverage"][0]
        self.assertEqual(coverage["status"], "under_evidenced")
        self.assertFalse(coverage["recommendation_ready"])
        self.assertEqual(coverage["missing_decision_groups"], ["pricing", "limitations"])
        self.assertEqual(coverage["blocking_decision_groups"], ["limitations", "pricing"])
        self.assertEqual(out["summary"]["comparison_under_evidenced"], 1)
        self.assertIn(
            "verify before choosing: limitations, pricing",
            out["recommendation_markdown"],
        )
        self.assertNotIn(
            "No retained candidate is recommendation-ready",
            out["recommendation_markdown"],
        )

    def test_comparison_markdown_places_claim_ids_on_each_verified_factual_cell(self):
        out = verify(_comparison_fixture())

        row = out["comparison_rows"][0]
        for field in (
            "os", "setup_ease", "model_capabilities", "local_offline",
            "pricing_cost", "key_limitations",
        ):
            self.assertRegex(row[field], r" \[E\d+\]$")
        self.assertIn(
            "The desktop app supports Windows and macOS. [E1]",
            out["comparison_markdown"],
        )

    def test_comparison_coverage_uses_the_downgraded_normalized_cell(self):
        payload = _comparison_fixture()
        payload["comparison"][0]["field_claims"].pop("os")

        out = verify(payload)

        self.assertEqual(out["comparison_rows"][0]["os"], "Not verified: OS")
        self.assertEqual(
            out["comparison_coverage"][0]["missing_decision_groups"],
            ["platform_and_setup"],
        )
        self.assertIn(
            "comparison_field_evidence_missing",
            {warning["issue"] for warning in out["comparison_warnings"]},
        )

    def test_comparison_downgrades_unmapped_factual_cell(self):
        source = {**SOURCES[0], "accessed_at": "2026-07-28"}
        out = verify({
            "sources": [source],
            "claims": [{
                "id": "c_privacy",
                **_claim(
                    "User data remains on the device.",
                    _cite(source="s1", quote="keep user data on the device"),
                ),
            }],
            "comparison": [{
                "candidate": "Unmapped app",
                "best_for": "Private chat",
                "os": "Not verified",
                "setup_ease": "Not verified",
                "model_capabilities": "Not verified",
                "local_offline": "Not verified",
                "privacy_data_handling": "User data remains on the device",
                "pricing_cost": "Not verified",
                "key_limitations": "Not verified",
                "ideal_user": "Everyday desktop user",
                "evidence_sources": ["s1"],
            }],
        })
        row = out["comparison_rows"][0]
        self.assertEqual(row["privacy_data_handling"], "Not verified: Privacy/data handling")
        self.assertEqual(row["evidence"], "Not verified: no verified Evidence ID")
        self.assertIn(
            "comparison_field_evidence_missing",
            {warning["issue"] for warning in out["comparison_warnings"]},
        )

    def test_comparison_rejects_claim_from_another_candidate_source(self):
        out = verify({
            "sources": SOURCES,
            "claims": [{
                "id": "c_cloud",
                **_claim(
                    "Cloud agents stream everything to a server.",
                    _cite(source="s2", quote="Cloud agents stream everything to a server"),
                ),
            }],
            "comparison": [{
                "candidate": "Local app",
                "best_for": "Private chat",
                "os": "Not verified",
                "setup_ease": "Not verified",
                "model_capabilities": "Not verified",
                "local_offline": "Cloud agents stream everything to a server",
                "privacy_data_handling": "Not verified",
                "pricing_cost": "Not verified",
                "key_limitations": "Not verified",
                "ideal_user": "Everyday desktop user",
                "evidence_sources": ["s1"],
                "field_claims": {"local_offline": ["c_cloud"]},
            }],
        })
        row = out["comparison_rows"][0]
        self.assertEqual(row["local_offline"], "Not verified: Local/offline")
        self.assertEqual(row["evidence"], "Not verified: no verified Evidence ID")

    def test_comparison_rejects_unproven_field_claim(self):
        out = verify({
            "sources": SOURCES,
            "claims": [{
                "id": "c_unproven",
                **_claim(
                    "The application supports Windows and macOS.",
                    _cite(source="s1", quote="keep user data on the device"),
                ),
            }],
            "comparison": [{
                "candidate": "Unsupported app",
                "best_for": "Desktop use",
                "os": "Windows and macOS",
                "setup_ease": "Not verified",
                "model_capabilities": "Not verified",
                "local_offline": "Not verified",
                "privacy_data_handling": "Not verified",
                "pricing_cost": "Not verified",
                "key_limitations": "Not verified",
                "ideal_user": "Everyday desktop user",
                "evidence_sources": ["s1"],
                "field_claims": {"os": ["c_unproven"]},
            }],
        })
        row = out["comparison_rows"][0]
        self.assertFalse(out["claims"][0]["supported"])
        self.assertEqual(row["os"], "Not verified: OS")
        self.assertEqual(row["evidence"], "Not verified: no verified Evidence ID")

    def test_comparison_rejects_verified_but_unrelated_field_claim(self):
        out = verify({
            "sources": SOURCES,
            "claims": [{
                "id": "c_privacy",
                **_claim(
                    "User data remains on the device.",
                    _cite(source="s1", quote="keep user data on the device"),
                ),
            }],
            "comparison": [{
                "candidate": "Misbound app",
                "best_for": "Desktop use",
                "os": "Windows and macOS",
                "setup_ease": "Not verified",
                "model_capabilities": "Not verified",
                "local_offline": "Not verified",
                "privacy_data_handling": "Not verified",
                "pricing_cost": "Not verified",
                "key_limitations": "Not verified",
                "ideal_user": "Everyday desktop user",
                "evidence_sources": ["s1"],
                "field_claims": {"os": ["c_privacy"]},
            }],
        })
        row = out["comparison_rows"][0]
        self.assertTrue(out["claims"][0]["supported"])
        self.assertEqual(row["os"], "Not verified: OS")
        self.assertEqual(row["evidence"], "Not verified: no verified Evidence ID")

    def test_comparison_marks_missing_fields_and_unverified_evidence(self):
        out = verify({
            "sources": SOURCES,
            "claims": [],
            "comparison": [{
                "candidate": "Sparse candidate",
                "evidence": "E99",
            }],
        })
        row = out["comparison_rows"][0]
        self.assertEqual(row["os"], "Not verified: OS")
        self.assertEqual(row["pricing_cost"], "Not verified: Pricing/cost")
        self.assertEqual(row["evidence"], "Not verified: no verified Evidence ID")
        issues = {warning["issue"] for warning in out["comparison_warnings"]}
        self.assertIn("comparison_field_missing", issues)
        self.assertIn("comparison_evidence_missing", issues)

    def test_unproven_or_flagged_citations_are_not_rendered_as_evidence(self):
        out = _verify([
            _claim("weak", _cite(source="s2")),
            _claim("bad", _cite(source="s1", quote="totally invented sentence here")),
        ])
        self.assertEqual(out["evidence_rows"], [])
        self.assertEqual(out["evidence_markdown"], "")

    def test_sibling_evidence_ledger_restores_delivery_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            input_path = os.path.join(directory, "citations_input.json")
            ledger_path = os.path.join(directory, "evidence_ledger.jsonl")
            with open(input_path, "w", encoding="utf-8") as fh:
                json.dump({}, fh)
            with open(ledger_path, "w", encoding="utf-8") as fh:
                fh.write(json.dumps({
                    "source_id": "s1",
                    "canonical_url": "https://example.com/paper",
                    "published_at": "2024-05-01",
                    "accessed_at": "2026-07-28",
                    "limitations": "Official source only.",
                }) + "\n")
            payload = {"sources": [{**SOURCES[0], "date": None}], "claims": []}
            diag = _enrich_sources_from_evidence_ledger(payload, input_path)
            source = payload["sources"][0]
            self.assertEqual(diag["matched_sources"], 1)
            self.assertEqual(diag["ledger"], "evidence_ledger.jsonl")
            self.assertEqual(source["date"], "2024-05-01")
            self.assertEqual(source["accessed_at"], "2026-07-28")
            self.assertEqual(source["limitations"], "Official source only.")

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
        self.assertEqual(out["evidence_rows"], [])
        self.assertEqual(out["evidence_markdown"], "")
        self.assertEqual(out["comparison_rows"], [])
        self.assertEqual(out["comparison_markdown"], "")

    def test_summary_counts(self):
        out = _verify([
            _claim("User data stays on the device.",
                   _cite(source="s1", quote="keep user data on the device")),          # supported
            _claim("weak", _cite(source="s2")),                                         # weak
            _claim("bad", _cite(source="s1", quote="totally invented sentence here")),  # flagged
        ])
        s = out["summary"]
        self.assertEqual(s["claims"], 3)
        self.assertEqual(s["supported"], 1)
        self.assertEqual(s["unsupported"], 2)
        self.assertEqual(s["verified"], 1)
        self.assertEqual(s["weak"], 1)
        self.assertEqual(s["flagged"], 1)
        self.assertEqual(s["aligned"], 1)
        self.assertEqual(s["support_unproven"], 1)

    def test_references_op_matches_verify(self):
        claims = [_claim("a", _cite(source="s1", quote="keep user data on the device"))]
        ref_out = references({"sources": SOURCES, "claims": claims})
        full = verify({"sources": SOURCES, "claims": claims})
        self.assertEqual(ref_out["references"], full["references"])
        self.assertFalse(ref_out["abstain"])

    def test_cli_stdout_is_ascii_safe_and_round_trips_unicode(self):
        script = os.path.join(os.path.dirname(__file__), "..", "scripts", "citations.py")
        payload = {
            "sources": [{
                "id": "s1",
                "url": "https://example.com/source",
                "title": "桌面应用",
                "text": "The verified source uses an em dash — and remains exact.",
            }],
            "claims": [{
                "text": "The verified source uses an em dash — and remains exact.",
                "citations": [{
                    "source": "s1",
                    "quote": "The verified source uses an em dash — and remains exact.",
                }],
            }],
        }
        with tempfile.TemporaryDirectory() as root:
            input_path = os.path.join(root, "citations_input.json")
            with open(input_path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False)
            completed = subprocess.run(
                [sys.executable, script, "--op", "verify", "--input", input_path],
                check=True,
                capture_output=True,
            )
        self.assertTrue(completed.stdout.isascii())
        decoded = json.loads(completed.stdout.decode("ascii"))
        self.assertEqual(decoded["data"]["references"][0]["title"], "桌面应用")
        self.assertIn("—", decoded["data"]["evidence_markdown"])

    def test_cli_with_out_persists_full_result_but_prints_only_compact_summary(self):
        script = os.path.join(os.path.dirname(__file__), "..", "scripts", "citations.py")
        payload = {
            "sources": [{
                "id": "s1",
                "url": "https://example.com/source",
                "title": "Official source",
                "text": "The desktop application keeps private documents on the local device.",
            }],
            "claims": [{
                "id": "c_privacy",
                "text": "The desktop application keeps private documents on the local device.",
                "citations": [{
                    "source": "s1",
                    "quote": "The desktop application keeps private documents on the local device.",
                }],
            }],
            "comparison": [{
                "candidate": "Example",
                "best_for": "Private desktop use",
                "os": "Not verified",
                "setup_ease": "Not verified",
                "model_capabilities": "Not verified",
                "local_offline": "Not verified",
                "privacy_data_handling": "The application keeps private documents on the local device",
                "pricing_cost": "Not verified",
                "key_limitations": "Not verified",
                "ideal_user": "Desktop user",
                "evidence_sources": ["s1"],
                "field_claims": {"privacy_data_handling": ["c_privacy"]},
            }],
        }
        with tempfile.TemporaryDirectory() as root:
            input_path = os.path.join(root, "citations_input.json")
            output_path = os.path.join(root, "citations_output.json")
            with open(input_path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh)
            completed = subprocess.run(
                [sys.executable, script, "--op", "verify", "--input", input_path,
                 "--out", output_path],
                check=True,
                capture_output=True,
            )
            stdout = json.loads(completed.stdout.decode("ascii"))
            with open(output_path, encoding="utf-8") as fh:
                persisted = json.load(fh)

        self.assertEqual(stdout["output"], output_path)
        self.assertEqual(stdout["summary"]["supported"], 1)
        self.assertEqual(stdout["flags"], 0)
        self.assertEqual(stdout["comparison_warnings"], 0)
        self.assertEqual(stdout["comparison_warning_details"], [])
        self.assertEqual(
            stdout["comparison_coverage_details"][0]["status"],
            "under_evidenced",
        )
        self.assertEqual(
            stdout["comparison_coverage_details"][0]["blocking_decision_groups"],
            ["platform_and_setup", "model_capabilities", "limitations", "pricing"],
        )
        self.assertNotIn("verified_fields", stdout["comparison_coverage_details"][0])
        self.assertNotIn("data", stdout)
        self.assertIn("| Candidate |", stdout["comparison_markdown"])
        self.assertIn("## Recommendations", stdout["recommendation_markdown"])
        self.assertIn("## Evidence used", stdout["evidence_markdown"])
        self.assertTrue(persisted["data"]["claims"][0]["supported"])
        self.assertEqual(
            persisted["data"]["comparison_coverage"][0]["missing_decision_groups"],
            ["platform_and_setup", "model_capabilities", "pricing", "limitations"],
        )
        self.assertIn("## Evidence used", persisted["data"]["evidence_markdown"])
        self.assertIn("The desktop application keeps private documents", persisted["data"]["evidence_markdown"])

    def test_cli_with_out_compacts_diagnostics_but_persists_full_details(self):
        script = os.path.join(os.path.dirname(__file__), "..", "scripts", "citations.py")
        payload = {
            "sources": [{
                "id": "s1",
                "url": "https://example.com/source",
                "text": "The source discusses desktop installation only.",
            }],
            "claims": [{
                "text": "The application guarantees private offline use.",
                "citations": [{"source": "s1", "quote": "missing exact quote"}],
            }],
            "comparison": [{
                "candidate": "Example",
                "os": "Windows",
                "evidence_sources": ["s1"],
            }],
        }
        with tempfile.TemporaryDirectory() as root:
            input_path = os.path.join(root, "citations_input.json")
            output_path = os.path.join(root, "citations_output.json")
            with open(input_path, "w", encoding="utf-8") as fh:
                json.dump(payload, fh)
            completed = subprocess.run(
                [sys.executable, script, "--op", "verify", "--input", input_path,
                 "--out", output_path],
                check=True,
                capture_output=True,
            )
            stdout = json.loads(completed.stdout.decode("ascii"))
            with open(output_path, encoding="utf-8") as fh:
                persisted = json.load(fh)

        self.assertEqual(stdout["flags"], 1)
        self.assertEqual(stdout["flag_details"][0]["issue"], "quote_not_found_in_source")
        self.assertNotIn("detail", stdout["flag_details"][0])
        self.assertGreater(stdout["comparison_warnings"], 0)
        self.assertNotIn("detail", stdout["comparison_warning_details"][0])
        self.assertIn("detail", persisted["data"]["flags"][0])
        self.assertTrue(any(
            "detail" in item for item in persisted["data"]["comparison_warnings"]
        ))


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
