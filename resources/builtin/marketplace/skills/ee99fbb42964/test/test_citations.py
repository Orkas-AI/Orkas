"""Unit tests for deep-research citations (anti-fabrication). stdlib unittest, no deps.

Run:  cd PC/resources/builtin/marketplace/skills/ee99fbb42964 && python3 -m unittest
or:   python3 -m unittest discover -s <skill>/test

Covers BOTH matching shapes (real quotes/DOIs we must accept despite formatting
differences) and look-alike non-matching shapes (paraphrases, wrong-source
quotes, invented DOIs, phantom sources) that must be flagged — per the repo's
text-processing test rule.
"""

import os
import json
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import citations  # noqa: E402
from citations import (  # noqa: E402
    MIN_QUOTE_CHARS, _enrich_sources_from_evidence_ledger, _normalize_url,
    references, verify,
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
        self.assertNotIn("data", stdout)
        self.assertIn("| Candidate |", stdout["comparison_markdown"])
        self.assertIn("## Evidence used", stdout["evidence_markdown"])
        self.assertTrue(persisted["data"]["claims"][0]["supported"])
        self.assertIn("## Evidence used", persisted["data"]["evidence_markdown"])
        self.assertIn("The desktop application keeps private documents", persisted["data"]["evidence_markdown"])


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
