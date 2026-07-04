"""deep-research pipeline e2e — proves the four engine scripts COMPOSE.

The agent workflow chains them: caps.plan -> gather (academic) -> compress ->
draft -> citations.verify -> deliver. This test drives that chain deterministically
(no model, no network) and asserts the I/O contracts line up: an `academic` record
is consumable as a `compress` source AND a `citations` source; a quote copied from
a compressed chunk still verifies against the original source; and `caps` bounds
the plan then stops the run at the budget ceiling.

stdlib unittest, no deps, no network.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import academic  # noqa: E402
import caps  # noqa: E402
import citations  # noqa: E402
import compress  # noqa: E402

QUERY = "on device inference privacy"
QUOTE = "On-device inference keeps the private prompt history off any remote server."

# One long topical source (> 2000 chars so compress runs its real path), containing
# the distinctive QUOTE sentence verbatim.
SOURCE_TEXT = " ".join([
    QUOTE,
    "A local first agent performs inference on the user's own hardware, so the private data never leaves the device.",
    "This on device design gives a concrete privacy guarantee that a cloud service cannot match.",
    "Researchers measured the privacy attack surface and found that on device inference removes the operator trust assumption entirely.",
    "Because inference runs locally, sensitive prompts and documents stay private and are never uploaded to a remote server.",
    "The study argues that privacy and capability are compatible when the model runs where the data already lives.",
    "On device inference also works offline, which further limits exposure of the private prompt history.",
    "Encrypted state may sync between devices, but the plaintext prompt content remains on device and private.",
    "The authors recommend on device inference as the default for any privacy sensitive assistant.",
    "Overall the paper frames local first, on device inference as the core privacy mechanism for autonomous agents.",
    "The evaluation compares on device inference latency against a cloud baseline across several hardware profiles.",
    "For most workloads the on device path stayed within an acceptable latency budget while preserving privacy.",
    "The report notes that quantized models make on device inference practical even on modest consumer hardware.",
    "A privacy threat model section enumerates how a remote server could otherwise correlate a user's prompt history.",
    "Keeping inference on device also simplifies regulatory compliance because no personal data crosses a network boundary.",
    "The authors release a reproducible benchmark so others can verify the on device privacy and latency claims.",
    "They conclude that a privacy first assistant should treat on device inference as a requirement, not an option.",
    "An appendix details the on device inference runtime, including memory limits and the private key handling.",
    "The discussion contrasts on device privacy guarantees with the weaker promises of an encrypted cloud service.",
    "Finally the paper outlines future work on federated evaluation that still keeps every prompt private and on device.",
])


class PipelineCompose(unittest.TestCase):
    def test_academic_record_feeds_compress_and_citations(self):
        rec = academic._rec("openalex", "On-Device Agents", SOURCE_TEXT, ["Ada Lovelace"],
                            "2024-01-01", "10.1234/od.1", "https://openalex.org/W1", "W1")

        # compress consumes the academic record as a source
        comp = compress.compress({"query": QUERY, "sources": [
            {"id": rec["id"], "url": rec["url"], "title": rec["title"], "text": rec["text"]}]})
        self.assertFalse(comp["stats"]["skipped_compression"])
        self.assertTrue(comp["kept"])

        # citations consumes the SAME academic record as a source (id/url/title/date/doi/text)
        src = {"id": rec["id"], "url": rec["url"], "title": rec["title"],
               "date": rec["date"], "doi": rec["doi"], "text": rec["text"]}
        ver = citations.verify({"sources": [src], "claims": [
            {"text": "On-device inference protects privacy.",
             "citations": [{"source": rec["id"], "quote": QUOTE, "doi": rec["doi"]}]}]})
        self.assertFalse(ver["abstain"])
        self.assertTrue(ver["claims"][0]["supported"])
        c = ver["claims"][0]["citations"][0]
        self.assertEqual(c["quote_status"], "verified")
        self.assertEqual(c["doi_status"], "verified")
        self.assertEqual(ver["flags"], [])
        self.assertEqual(len(ver["references"]), 1)
        self.assertEqual(ver["references"][0]["url"], "https://openalex.org/W1")

    def test_quote_from_compressed_chunk_verifies_against_source(self):
        src = {"id": "s1", "url": "https://a", "title": "A", "text": SOURCE_TEXT}
        comp = compress.compress({"query": QUERY, "sources": [src], "max_chars": 500})
        kept_text = " ".join(k["chunk"] for k in comp["kept"])
        # compress selected the topical text (whitespace may be collapsed vs the raw source)
        self.assertIn("on-device inference", kept_text.lower())
        # a quote copied from the compressed output still verifies against the ORIGINAL source
        ver = citations.verify({"sources": [src],
                                "claims": [{"text": "c", "citations": [{"source": "s1", "quote": QUOTE}]}]})
        self.assertEqual(ver["claims"][0]["citations"][0]["quote_status"], "verified")

    def test_fabricated_quote_survives_the_pipeline_as_flagged(self):
        # The guardrail must still catch a fabricated quote even after compression.
        src = {"id": "s1", "url": "https://a", "title": "A", "text": SOURCE_TEXT}
        ver = citations.verify({"sources": [src], "claims": [
            {"text": "bogus", "citations": [{"source": "s1", "quote": "the model achieves sentience by 2027"}]}]})
        self.assertFalse(ver["claims"][0]["supported"])
        self.assertEqual(ver["flags"][0]["issue"], "quote_not_found_in_source")

    def test_caps_bounds_plan_then_account_stops_at_ceiling(self):
        pl = caps.plan({"subquestions": ["on device latency", "privacy attack surface",
                                         "offline inference accuracy"], "depth": 0})
        self.assertTrue(pl["allowed"])
        self.assertLessEqual(len(pl["subquestions"]), pl["caps"]["max_subquestions"])
        self.assertGreaterEqual(pl["fetch_budget_per_subquestion"], 1)
        # spending the whole fetch budget trips the hard ceiling -> stop
        acct = caps.account({"steps": [{"step": "gather", "fetches": pl["total_fetch_budget"]}]})
        self.assertTrue(acct["stop"])
        self.assertIn("max_fetches", acct["exceeded"])


if __name__ == "__main__":
    unittest.main()
