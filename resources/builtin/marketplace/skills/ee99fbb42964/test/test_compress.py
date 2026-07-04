"""Unit tests for deep-research compress. stdlib unittest, no deps.

Run:  cd PC/resources/builtin/marketplace/skills/ee99fbb42964 && python3 -m unittest

Covers BOTH matching shapes (topical passages we must keep/rank) and look-alike
non-matching shapes (stopword-only or surface-word overlap that must NOT rank as
relevant; near-but-not-duplicate chunks that must NOT be de-duped) per the repo's
text-processing test rule.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import compress  # noqa: E402
from compress import (  # noqa: E402
    MAX_CHUNK_CHARS, MIN_CHUNK_CHARS, SMALL_CONTENT_CHARS,
    _dedup, _score, chunk_text, tokenize,
)

QUERY = "local first AI agent privacy"
QTERMS = set(tokenize(QUERY))   # {local, first, ai, agent, privacy}


class TokenizeAndScore(unittest.TestCase):
    def test_tokenize_drops_stopwords(self):
        self.assertEqual(set(tokenize("the AI agent and the data")), {"ai", "agent", "data"})

    def test_score_topical_beats_surface_overlap(self):
        relevant = tokenize("this local first ai agent protects user privacy on device")
        realestate = tokenize("the listing agent showed the house to prospective buyers")
        cov_rel, _ = _score(QTERMS, relevant)
        cov_re, _ = _score(QTERMS, realestate)
        self.assertGreater(cov_rel, cov_re)      # topical passage wins
        self.assertAlmostEqual(cov_re, 0.2, places=4)   # only "agent" matched (1/5)

    def test_score_zero_for_stopwords_only(self):
        cov, dens = _score(QTERMS, tokenize("the and for with is on by to"))
        self.assertEqual((cov, dens), (0.0, 0.0))

    def test_score_empty_query(self):
        self.assertEqual(_score(set(), tokenize("anything at all")), (0.0, 0.0))


class Chunking(unittest.TestCase):
    def test_paragraph_split_respects_cap(self):
        para = " ".join("Sentence number {} explains a distinct point clearly.".format(i)
                        for i in range(40))
        self.assertGreater(len(para), MAX_CHUNK_CHARS)
        chunks = chunk_text(para)
        self.assertGreaterEqual(len(chunks), 2)
        self.assertTrue(all(len(c) <= MAX_CHUNK_CHARS for c in chunks))

    def test_blank_and_tiny_fragments_dropped(self):
        text = "short.\n\n" + ("\n\n") + "x" * (MIN_CHUNK_CHARS - 1)
        self.assertEqual(chunk_text(text), [])   # both fragments below MIN_CHUNK_CHARS

    def test_paragraphs_split_on_blank_lines(self):
        a = "A" * 120
        b = "B" * 120
        self.assertEqual(chunk_text(a + "\n\n" + b), [a, b])


class Dedup(unittest.TestCase):
    def _rec(self, chunk):
        return {"source": "s", "url": None, "title": None, "chunk": chunk, "chunk_index": 0}

    def test_exact_duplicate_dropped_first_wins(self):
        c = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu"
        kept, dropped = _dedup([self._rec(c), self._rec("  ALPHA beta gamma delta epsilon zeta eta theta iota kappa lambda mu  ")])
        self.assertEqual(len(kept), 1)
        self.assertEqual(dropped, 1)
        self.assertEqual(kept[0]["chunk"], c)   # first occurrence kept verbatim

    def test_near_duplicate_dropped(self):
        base = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon"
        near = base.replace("upsilon", "phi")   # 1 of 20 tokens differ -> jaccard ~0.90
        kept, dropped = _dedup([self._rec(base), self._rec(near)])
        self.assertEqual(len(kept), 1)
        self.assertEqual(dropped, 1)

    def test_half_overlap_is_not_a_duplicate(self):
        a = "alpha beta gamma delta epsilon zeta eta theta iota kappa"
        b = "alpha beta gamma delta epsilon lorem ipsum dolor sit amet"   # ~5/15 overlap
        kept, dropped = _dedup([self._rec(a), self._rec(b)])
        self.assertEqual(len(kept), 2)
        self.assertEqual(dropped, 0)


# Distinct, topical vs off-topic vs pure-noise prose, each long enough (~750
# chars) that the total (> 2000) exercises the real compress path rather than the
# small-content skip. Built by joining sentences so spacing is single and each
# paragraph is a stable, assertable single chunk (< MAX_CHUNK_CHARS).
RELEVANT = " ".join([
    "Local-first AI agent systems keep user data on the device.",
    "They never stream the private conversation to a remote server, so privacy stays under the user's control.",
    "This local first design means the agent runs offline and the user's files are never uploaded.",
    "Researchers describe this on-device model as the core privacy guarantee of a trustworthy assistant.",
    "Because the ai agent processes prompts locally, sensitive documents remain private and are not exposed to any third party.",
    "The study reports that a local first architecture materially reduces the privacy attack surface for an autonomous agent.",
    "Keeping inference on device also removes the need to trust an operator with the raw prompt history.",
    "A local first agent can still sync encrypted state, but the plaintext never leaves the user's machine.",
    "The authors conclude that privacy and capability are not at odds when the ai agent runs where the data already lives.",
])
OFFTOPIC = " ".join([
    "The real estate agent showed the downtown house to several prospective buyers over the weekend.",
    "They negotiated the closing price and reviewed the mortgage paperwork with the bank before signing.",
    "The listing had been on the market for months, so the seller was eager to accept a reasonable offer.",
    "A home inspection team scheduled the final walkthrough for Monday morning after the appraisal cleared.",
    "The broker prepared the title transfer and the escrow documents for the county recorder that afternoon.",
    "Comparable sales in the neighborhood suggested the asking figure was slightly above market value.",
    "The buyers requested a small credit for a roof repair uncovered during the inspection contingency.",
    "Once the lender approved the financing, the parties set a closing date near the end of the month.",
])
NOISE = " ".join([
    "The chef simmered the tomato sauce for two hours, stirring in fresh basil and oregano throughout.",
    "He then plated the pasta with a generous helping of grated cheese and a slow drizzle of olive oil.",
    "A rustic loaf of sourdough came out of the wood oven with a crackling golden crust and soft crumb.",
    "Dessert was a lemon tart with a buttery shell, finished under the broiler for a caramelized top.",
    "The kitchen smelled of garlic and rosemary as the plates went out to the crowded dining room.",
    "A pot of espresso brewed slowly while the pastry cook folded butter into the laminated dough.",
    "Diners lingered over the cheese board, pairing aged gouda with quince paste and toasted walnuts.",
    "The sommelier recommended a crisp white to balance the richness of the braised short rib special.",
])


def _payload(**kw):
    base = {"query": QUERY, "sources": [
        {"id": "s1", "url": "https://a", "title": "A", "text": RELEVANT + "\n\n" + OFFTOPIC},
        {"id": "s2", "url": "https://b", "title": "B", "text": NOISE},
    ]}
    base.update(kw)
    return base


class CompressIntegration(unittest.TestCase):
    def test_runs_compress_path_not_skip(self):
        out = compress.compress(_payload())
        self.assertFalse(out["stats"]["skipped_compression"])
        self.assertGreater(out["stats"]["chars_in"], SMALL_CONTENT_CHARS)

    def test_relevant_ranked_first_and_noise_dropped(self):
        out = compress.compress(_payload())
        kept_texts = [k["chunk"] for k in out["kept"]]
        self.assertIn(RELEVANT, kept_texts)
        self.assertNotIn(NOISE, kept_texts)                 # coverage 0 -> dropped
        self.assertEqual(out["kept"][0]["chunk"], RELEVANT)  # highest coverage first
        scores = [k["score"] for k in out["kept"]]
        self.assertEqual(scores, sorted(scores, reverse=True))
        self.assertGreaterEqual(out["dropped_low_relevance"], 1)

    def test_budget_cap_keeps_only_top_chunk(self):
        out = compress.compress(_payload(max_chars=len(RELEVANT) + 20))
        self.assertEqual(out["stats"]["chunks_kept"], 1)
        self.assertEqual(out["kept"][0]["chunk"], RELEVANT)
        self.assertLessEqual(out["stats"]["chars_out"], len(RELEVANT) + 20)

    def test_per_source_cap(self):
        out = compress.compress(_payload(max_per_source=1))
        per = {}
        for k in out["kept"]:
            per[k["source"]] = per.get(k["source"], 0) + 1
        self.assertTrue(all(v <= 1 for v in per.values()))

    def test_small_content_skips_compression(self):
        out = compress.compress({"query": QUERY, "sources": [
            {"id": "s1", "url": "https://a", "title": "A", "text": "Tiny local ai agent note."}]})
        self.assertTrue(out["stats"]["skipped_compression"])
        self.assertEqual(out["kept"][0]["score"], None)
        self.assertEqual(out["kept"][0]["chunk"], "Tiny local ai agent note.")

    def test_no_query_skips_scoring(self):
        out = compress.compress({"query": "", "sources": _payload()["sources"]})
        self.assertTrue(out["stats"]["skipped_compression"])
        self.assertTrue(all(k["score"] is None for k in out["kept"]))

    def test_dedup_counted_across_sources(self):
        p = _payload()
        p["sources"].append({"id": "s3", "url": "https://c", "title": "C", "text": RELEVANT})
        out = compress.compress(p)
        self.assertGreaterEqual(out["stats"]["deduped"], 1)
        self.assertEqual(sum(1 for k in out["kept"] if k["chunk"] == RELEVANT), 1)

    def test_input_caps_are_applied_and_reported(self):
        old = (compress.MAX_SOURCES, compress.MAX_SOURCE_CHARS, compress.MAX_TOTAL_INPUT_CHARS)
        try:
            compress.MAX_SOURCES = 3
            compress.MAX_SOURCE_CHARS = 100
            compress.MAX_TOTAL_INPUT_CHARS = 250
            sources = [{"id": "s{}".format(i), "text": "x" * 120} for i in range(5)]
            out = compress.compress({"query": "", "sources": sources})
        finally:
            (compress.MAX_SOURCES,
             compress.MAX_SOURCE_CHARS,
             compress.MAX_TOTAL_INPUT_CHARS) = old

        stats = out["stats"]
        self.assertTrue(stats["input_capped"])
        self.assertEqual(stats["sources"], 5)              # legacy field: valid input sources
        self.assertEqual(stats["sources_input"], 5)
        self.assertEqual(stats["sources_considered"], 3)
        self.assertEqual(stats["sources_dropped"], 2)
        self.assertEqual(stats["sources_truncated"], 3)
        self.assertEqual(stats["chars_input_raw"], 600)
        self.assertEqual(stats["chars_in"], 250)
        self.assertEqual(stats["chars_truncated"], 350)


if __name__ == "__main__":
    unittest.main()
