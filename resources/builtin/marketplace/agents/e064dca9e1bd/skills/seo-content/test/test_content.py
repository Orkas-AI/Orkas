"""Unit tests for seo-content heuristics. stdlib unittest."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from content import audit_content, _count_claims, _avg_sentence_words  # noqa: E402


def crawl(page):
    return {"ok": True, "data": {"site": {}, "pages": [page]}}


CLEAN = {
    "url": "https://x.com/guide", "title": "How to set up X in five steps",
    "first_paragraph": "X is a local-first desktop client; here is the fastest way to set it up in five concrete steps.",
    "h1s": ["How to set up X"], "word_count": 800, "external_link_count": 4,
    "text_sample": ("X is a local-first desktop client. Set it up in five steps. "
                    "First install it. Then sign in. Configure your keys. Pick a model. Start working. "
                    "Each step takes under a minute and needs no server.") * 3,
}

SPAMMY = {
    "url": "https://x.com/blog", "title": "Unlock the power of synergy",
    "first_paragraph": "Intro.",  # too short → no answer-first
    "h1s": ["Welcome"], "word_count": 600, "external_link_count": 0,
    "text_sample": ("In today's fast-paced ever-evolving landscape we delve into the cutting-edge "
                    "state-of-the-art tapestry of synergy. Studies show 47% of teams leverage the power "
                    "of seamless solutions, and according to research $2 billion was spent in 2024 on this "
                    "ever-changing landscape that is a real game-changer when it comes to unlocking potential "
                    "across a wide range of plethora of options that elevate your workflow seamlessly forever and ever and ever."),
}


class CleanTest(unittest.TestCase):
    def test_clean_few_findings(self):
        r = audit_content(crawl(CLEAN))
        ids = {f["id"] for f in r["findings"]}
        self.assertNotIn("ai_tone", ids)
        self.assertNotIn("no_answer_first", ids)
        self.assertGreaterEqual(r["content_score"], 90)


class SpammyTest(unittest.TestCase):
    def setUp(self):
        self.r = audit_content(crawl(SPAMMY))
        self.ids = {f["id"] for f in self.r["findings"]}

    def test_detects_ai_tone(self):
        self.assertIn("ai_tone", self.ids)

    def test_detects_uncited_claims(self):
        self.assertIn("uncited_claims", self.ids)

    def test_detects_no_answer_first(self):
        self.assertIn("no_answer_first", self.ids)

    def test_findings_have_falsifiable_fields(self):
        for f in self.r["findings"]:
            self.assertTrue(f["leading_indicator"] and f["failure_criterion"])
            self.assertIn(f["data_tier"], ("Measured", "Estimated"))


class LookAlikeTest(unittest.TestCase):
    def test_two_ai_phrases_below_threshold(self):
        page = dict(CLEAN, text_sample="We leverage the power of cutting-edge tools. Nothing else here.")
        ids = {f["id"] for f in audit_content(crawl(page))["findings"]}
        self.assertNotIn("ai_tone", ids)  # only 2 phrases (<3)

    def test_claims_with_citations_not_flagged(self):
        page = dict(SPAMMY, external_link_count=5)
        ids = {f["id"] for f in audit_content(crawl(page))["findings"]}
        self.assertNotIn("uncited_claims", ids)

    def test_count_claims(self):
        # 47% (stat) + in 2024 (year) + 5 million (magnitude) + according to (authority) = 4
        # (avoid "$3 billion" which intentionally trips both money+magnitude — a
        #  threshold heuristic may over-count overlapping spans, which is fine.)
        self.assertEqual(_count_claims("Sales grew 47% in 2024, reaching 5 million users according to a study."), 4)


class LongSentencesTest(unittest.TestCase):
    def test_long_sentences_no_terminator(self):
        # 31 space-separated tokens, no sentence terminator → one "sentence"
        # of 31 words → avg 31.0 > 30 → long_sentences flagged.
        blob = " ".join(["word"] * 31)
        r = audit_content(crawl(dict(CLEAN, text_sample=blob)))
        ids = {f["id"] for f in r["findings"]}
        self.assertIn("long_sentences", ids)
        self.assertEqual(r["meta"]["avg_sentence_words"], 31.0)

    def test_avg_sentence_words_units(self):
        self.assertEqual(_avg_sentence_words(""), 0.0)
        self.assertEqual(_avg_sentence_words("a b c d e"), 5.0)
        # CJK terminator 。 splits two 2-word sentences → 2.5
        self.assertEqual(_avg_sentence_words("一 二 三。四 五。"), 2.5)

    def test_thirty_token_blob_not_long(self):
        # boundary: avg == 30.0 is NOT > 30 → long_sentences not flagged.
        blob = " ".join(["word"] * 30)
        ids = {f["id"] for f in audit_content(crawl(dict(CLEAN, text_sample=blob)))["findings"]}
        self.assertNotIn("long_sentences", ids)


class ThinBoundaryTest(unittest.TestCase):
    def test_thin_boundary(self):
        ids299 = {f["id"] for f in audit_content(crawl(dict(CLEAN, word_count=299)))["findings"]}
        self.assertIn("thin_for_topic", ids299)
        ids300 = {f["id"] for f in audit_content(crawl(dict(CLEAN, word_count=300)))["findings"]}
        self.assertNotIn("thin_for_topic", ids300)
        # word_count 0 is falsy → the `wc and` guard suppresses thin_for_topic.
        ids0 = {f["id"] for f in audit_content(crawl(dict(CLEAN, word_count=0)))["findings"]}
        self.assertNotIn("thin_for_topic", ids0)


class CountClaimsBoundaryTest(unittest.TestCase):
    def test_count_claims(self):
        self.assertEqual(_count_claims("It happened in 1850."), 0)   # 1850 not 19xx/20xx
        self.assertEqual(_count_claims("Released in 1999."), 1)       # year only
        # money ($3) + magnitude (3 billion) intentionally double-counted.
        self.assertEqual(_count_claims("We raised $3 billion."), 2)
        self.assertEqual(_count_claims("Version 2.0 ships with 100 new icons."), 0)


class NoAnswerFirstBoundaryTest(unittest.TestCase):
    def test_no_answer_first_boundaries(self):
        p59 = dict(CLEAN, word_count=150, first_paragraph="a" * 59)
        self.assertIn("no_answer_first", {f["id"] for f in audit_content(crawl(p59))["findings"]})
        p60 = dict(CLEAN, word_count=150, first_paragraph="a" * 60)
        self.assertNotIn("no_answer_first", {f["id"] for f in audit_content(crawl(p60))["findings"]})
        p149 = dict(CLEAN, word_count=149, first_paragraph="a" * 59)
        self.assertNotIn("no_answer_first", {f["id"] for f in audit_content(crawl(p149))["findings"]})


class TitleBodyMismatchTest(unittest.TestCase):
    def test_title_body_mismatch_fires(self):
        page = dict(CLEAN, title="Quantum widgets",
                    first_paragraph="Totally different opening.",
                    h1s=["Other heading"])
        ids = {f["id"] for f in audit_content(crawl(page))["findings"]}
        self.assertIn("title_body_mismatch", ids)


class MediumFixTest(unittest.TestCase):
    def test_ai_tone_substring_not_double_counted(self):
        # "seamless" is contained in "seamlessly"; that one cliché must count once,
        # so two distinct clichés stay under the >=3 ai_tone gate.
        page = dict(CLEAN, text_sample="Our seamlessly integrated cutting-edge tool.")
        self.assertNotIn("ai_tone", {f["id"] for f in audit_content(crawl(page))["findings"]})

    def test_title_body_mismatch_uses_word_boundaries(self):
        # Title term "guide" must not be satisfied by the body word "guidelines".
        page = dict(CLEAN, title="Guide to caching", h1s=[],
                    first_paragraph="Our guidelines for nothing relevant.", word_count=800)
        self.assertIn("title_body_mismatch", {f["id"] for f in audit_content(crawl(page))["findings"]})


if __name__ == "__main__":
    unittest.main()
