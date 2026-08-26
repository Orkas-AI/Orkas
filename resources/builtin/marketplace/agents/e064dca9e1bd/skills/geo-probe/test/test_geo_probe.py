"""Unit tests for geo-probe query-gen + answer scoring. stdlib unittest."""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from geo_probe import (  # noqa: E402
    context_terms, derive_brand_domain, filter_candidates, gen_queries, score_answers,
    _mentions,
)


def texts(rows):
    return [r["query"] for r in rows]


def of_kind(rows, kind):
    return [r["query"] for r in rows if r["kind"] == kind]


def crawl(title, h1s, sd=None, url="https://orkas.ai/"):
    return {"ok": True, "data": {"site": {}, "pages": [
        {"url": url, "title": title, "h1s": h1s, "structured_data": sd or []}]}}


class QueriesTest(unittest.TestCase):
    def test_brand_from_org_schema(self):
        c = crawl("Home | Acme", ["Welcome"],
                  sd=[{"@type": "Organization", "name": "Orkas", "url": "https://orkas.ai"}])
        brand, domain = derive_brand_domain(c, None, None)
        self.assertEqual(brand, "Orkas")
        self.assertEqual(domain, "orkas.ai")

    def test_brand_from_title_when_no_schema(self):
        brand, domain = derive_brand_domain(crawl("Orkas — AI desktop client", ["Orkas"]), None, None)
        self.assertEqual(brand, "Orkas")

    def test_branded_queries_are_labelled_control_not_measurement(self):
        # A model asked "What is Orkas?" names Orkas by construction. The query
        # stays in the set to detect an entity-recognition failure, but it must
        # never be counted as competitive visibility.
        qs = gen_queries(crawl("Orkas AI agents", ["Orkas multi-agent desktop"]), "Orkas", [])
        self.assertIn("What is Orkas?", of_kind(qs, "branded"))
        self.assertTrue(of_kind(qs, "unbranded"), "the probe set must carry unbranded rows")

    def test_unbranded_rows_never_carry_the_brand(self):
        # The topic is read from title + H1 — exactly where the brand name lives.
        # Before the brand/domain exclusion the "unbranded" rows read
        # "best orkas multi-agent tools", which is a branded query wearing the
        # wrong label and would have restored the very bias this split removes.
        qs = gen_queries(crawl("Orkas — multi-agent desktop app",
                               ["Command a team of AI agents"]), "Orkas", ["Cursor"])
        for q in of_kind(qs, "unbranded"):
            self.assertNotIn("orkas", q.lower(), q)

    def test_competitor_alternatives_survives_the_length_floor(self):
        qs = gen_queries(crawl("Orkas", ["Multi-agent desktop"]), "Orkas", ["Cursor"])
        self.assertTrue(any("Cursor alternatives" in q for q in of_kind(qs, "unbranded")))

    def test_competitor_vs_query_stays_a_control(self):
        qs = gen_queries(crawl("Orkas", ["Orkas"]), "Orkas", ["Cursor"])
        self.assertTrue(any("vs Cursor" in q for q in of_kind(qs, "branded")))


class ScoreTest(unittest.TestCase):
    def test_sov_and_citation(self):
        payload = {"brand": "Orkas", "domain": "orkas.ai", "competitors": ["Cursor"], "answers": [
            {"query": "what is orkas", "mode": "retrieval", "text": "Orkas is a desktop client, see orkas.ai."},
            {"query": "best tools", "mode": "param", "text": "Cursor and others are popular."},
            {"query": "alternatives", "mode": "param", "text": "Orkas is one option."},
        ]}
        r = score_answers(payload)
        # Headline counts the two UNBRANDED rows only: "best tools" (absent) and
        # "alternatives" (mentioned). The branded "what is orkas" row is a hit by
        # construction and is reported separately.
        self.assertAlmostEqual(r["share_of_voice"], 0.5, places=2)
        self.assertEqual(r["share_of_voice_basis"], "unbranded")
        self.assertAlmostEqual(r["share_of_voice_all_answers"], 0.667, places=2)
        self.assertAlmostEqual(r["citation_rate"], 0.333, places=2)   # 1/3 cite orkas.ai
        self.assertEqual(r["competitor_share"]["Cursor"], round(1 / 3, 3))
        self.assertEqual(r["data_tier"], "Estimated")  # not all retrieval

    def test_all_retrieval_is_measured(self):
        payload = {"brand": "Orkas", "domain": "orkas.ai", "answers": [
            {"mode": "retrieval", "text": "Orkas (orkas.ai) is great."}]}
        self.assertEqual(score_answers(payload)["data_tier"], "Measured")

    def test_empty_answers_raises(self):
        with self.assertRaises(ValueError):
            score_answers({"brand": "X", "answers": []})


class DisambiguationTest(unittest.TestCase):
    def test_context_excludes_homonym(self):
        payload = {"brand": "Orkas", "domain": "orkas.ai",
                   "context_terms": ["ai", "agent", "desktop"], "answers": [
                       {"text": "Orkas are killer whales in the ocean.", "mode": "param"},   # ambiguous
                       {"text": "Orkas is an AI agent desktop client.", "mode": "param"},     # mentioned
                       {"text": "See orkas.ai for the Orkas app.", "mode": "param"},          # cited
                       {"text": "Cursor is popular.", "mode": "param"},                       # absent
                   ]}
        r = score_answers(payload)
        self.assertEqual([x["result"] for x in r["per_answer"]],
                         ["ambiguous", "mentioned", "cited", "absent"])
        self.assertEqual(r["share_of_voice"], 0.5)     # (cited + mentioned) / 4
        self.assertEqual(r["citation_rate"], 0.25)
        self.assertEqual(r["ambiguous_mentions"], 1)
        self.assertEqual(r["brand_mentions"], 2)

    def test_legacy_without_context_terms(self):
        # No context_terms -> any brand token counts (back-compat with old behavior).
        r = score_answers({"brand": "Orkas", "domain": "orkas.ai",
                           "answers": [{"text": "Orkas are whales.", "mode": "param"}]})
        self.assertEqual(r["share_of_voice"], 1.0)
        self.assertEqual(r["ambiguous_mentions"], 0)

    def test_context_word_boundary_not_substring(self):
        # 'ai' must not corroborate via 'said'/'maintain'; this answer has no real context term.
        r = score_answers({"brand": "Orkas", "domain": "orkas.ai", "context_terms": ["ai"],
                           "answers": [{"text": "He said Orkas swims and maintains speed.", "mode": "param"}]})
        self.assertEqual(r["per_answer"][0]["result"], "ambiguous")

    def test_queries_op_emits_context_terms(self):
        c = crawl("Orkas — Open-Source Multi-Agent AI Desktop Client", ["Orkas multi-agent desktop"])
        terms = context_terms(c, "Orkas", "orkas.ai")
        self.assertIn("desktop", terms)
        self.assertNotIn("orkas", terms)  # brand token excluded


class MentionTest(unittest.TestCase):
    def test_word_boundary(self):
        self.assertTrue(_mentions("I use Orkas daily", "Orkas"))
        self.assertFalse(_mentions("Xenon is an element", "X"))  # no substring false-positive


class CompetitorShareTest(unittest.TestCase):
    def test_competitor_share_word_boundary(self):
        # "Cline" hides inside "decline"/"inclined"; regex word-boundary must reject it.
        neg = score_answers({"brand": "Orkas", "domain": "orkas.ai", "competitors": ["Cline"],
                             "answers": [{"text": "Sales decline; inclined to wait.", "mode": "param"}]})
        self.assertEqual(neg["competitor_share"]["Cline"], 0.0)
        # Positive control: a real standalone token counts.
        pos = score_answers({"brand": "Orkas", "domain": "orkas.ai", "competitors": ["Cline"],
                             "answers": [{"text": "I tried Cline yesterday.", "mode": "param"}]})
        self.assertEqual(pos["competitor_share"]["Cline"], 1.0)


class ModeTierTest(unittest.TestCase):
    def test_mode_case_insensitive_tier(self):
        # mode is lowercased: a single "Retrieval" answer -> Measured tier.
        r = score_answers({"brand": "Orkas", "domain": "orkas.ai",
                           "answers": [{"text": "Orkas is great.", "mode": "Retrieval"}]})
        self.assertEqual(r["data_tier"], "Measured")
        self.assertEqual(r["per_answer"][0]["mode"], "retrieval")
        # Omitted mode key defaults to param -> Estimated tier.
        r2 = score_answers({"brand": "Orkas", "domain": "orkas.ai",
                            "answers": [{"text": "Orkas is great."}]})
        self.assertEqual(r2["data_tier"], "Estimated")
        self.assertEqual(r2["per_answer"][0]["mode"], "param")


class DomainCitationBoundaryTest(unittest.TestCase):
    def test_domain_substring_is_not_a_citation(self):
        # A domain that merely prefixes a longer host must NOT count as cited.
        # Brand "Globex" is absent so this isolates the domain-citation rule.
        r = score_answers({"brand": "Globex", "domain": "orkas.ai",
                           "answers": [{"text": "Book flights at orkas.airlines.com today.",
                                        "mode": "retrieval"}]})
        self.assertFalse(r["per_answer"][0]["domain_cited"])
        self.assertEqual(r["per_answer"][0]["result"], "absent")
        self.assertEqual(r["citation_rate"], 0.0)

    def test_real_domain_citation_still_counts(self):
        # Path/boundary-adjacent forms remain genuine citations.
        r = score_answers({"brand": "Orkas", "domain": "orkas.ai",
                           "answers": [{"text": "See orkas.ai/docs for setup.", "mode": "retrieval"}]})
        self.assertEqual(r["per_answer"][0]["result"], "cited")
        self.assertTrue(r["per_answer"][0]["domain_cited"])
        self.assertEqual(r["citation_rate"], 1.0)


if __name__ == "__main__":
    unittest.main()


class BrandedControlSplitTest(unittest.TestCase):
    """The bias this change exists to remove.

    Before the split, a probe set of 4 branded + 1 unbranded query reported a
    share of voice near 1.0 for a brand that no buyer query ever surfaces. The
    number moved with how many branded questions we happened to ask.
    """

    ANSWERS = [
        {"query": "What is Orkas?", "kind": "branded", "mode": "retrieval",
         "text": "Orkas is a desktop app, see orkas.ai"},
        {"query": "Orkas review", "kind": "branded", "mode": "retrieval",
         "text": "Orkas is solid (orkas.ai)"},
        {"query": "best multi-agent tools", "kind": "unbranded", "mode": "retrieval",
         "text": "Top picks: Cursor, Devin, Copilot."},
        {"query": "top multi-agent software 2026", "kind": "unbranded", "mode": "retrieval",
         "text": "Consider Cursor and Copilot."},
    ]

    def test_headline_excludes_branded_rows(self):
        r = score_answers({"brand": "Orkas", "domain": "orkas.ai", "answers": self.ANSWERS})
        self.assertEqual(r["share_of_voice"], 0.0)          # never named unprompted
        self.assertEqual(r["share_of_voice_all_answers"], 0.5)  # the old, inflated number
        self.assertEqual(r["branded_control"]["share_of_voice"], 1.0)
        self.assertEqual(r["unbranded"]["answers"], 2)

    def test_legacy_payload_without_kind_is_still_split(self):
        # An answers file written before `kind` existed must not fall back to the
        # inflated average; the query text itself says whether it named the brand.
        legacy = [{k: v for k, v in a.items() if k != "kind"} for a in self.ANSWERS]
        r = score_answers({"brand": "Orkas", "domain": "orkas.ai", "answers": legacy})
        self.assertEqual(r["share_of_voice"], 0.0)
        self.assertEqual(r["branded_control"]["answers"], 2)

    def test_all_branded_probe_says_so_instead_of_reporting_a_clean_score(self):
        r = score_answers({"brand": "Orkas", "domain": "orkas.ai",
                           "answers": self.ANSWERS[:2]})
        self.assertEqual(r["share_of_voice_basis"], "all_answers_no_unbranded_probe")


class FilterTest(unittest.TestCase):
    def test_every_drop_names_its_reason(self):
        res = filter_candidates([
            "best AI agent tools for teams",          # kept
            "Orkas review",                            # brand
            "best AI agent tools for teams",           # duplicate
            "GEO services",                            # too short AND bare acronym
            "ChatGPT vs Perplexity for deep research", # AI channel comparison
        ], "Orkas", "orkas.ai")
        self.assertEqual([k["query"] for k in res["kept"]], ["best AI agent tools for teams"])
        reasons = {r["query"]: r["reason"] for r in res["rejected"]}
        self.assertIn("brand", reasons["Orkas review"])
        self.assertEqual(reasons["best AI agent tools for teams"], "duplicate")
        self.assertIn("AI answer engines", reasons["ChatGPT vs Perplexity for deep research"])

    def test_domain_core_is_rejected_even_when_the_brand_name_differs(self):
        # The display brand and the domain often diverge ("Acme Corp" on
        # orkas.ai). Testing this with a brand that IS the domain core would
        # pass on the brand rule alone and never exercise this one.
        res = filter_candidates(["best orkas tooling for teams"], "Acme Corp", "orkas.ai")
        self.assertEqual(res["kept"], [])
        self.assertIn("domain core", res["rejected"][0]["reason"])

    def test_bare_ambiguous_acronym_is_rejected_but_universal_one_is_not(self):
        res = filter_candidates(
            ["best GEO services for startups", "best AI writing tools for teams"],
            "Orkas", "orkas.ai")
        self.assertEqual([k["query"] for k in res["kept"]], ["best AI writing tools for teams"])
        self.assertIn("Generative Engine Optimization", res["rejected"][0]["reason"])

    def test_expanded_acronym_passes(self):
        res = filter_candidates(
            ["best Generative Engine Optimization services for startups"], "Orkas", "orkas.ai")
        self.assertEqual(len(res["kept"]), 1)
