"""Unit tests for seo-keywords expansion. stdlib unittest."""

import json
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from keywords import (  # noqa: E402
    _dominant_intent, classify_intent, cluster, collect, expand, normalize,
    score_keyword,
)


def h(query, source="autocomplete"):
    return {"query": query, "source": source}


class NormalizeTest(unittest.TestCase):
    def test_case_punctuation_and_spacing_collapse_to_one_keyword(self):
        # The three surfaces return the same keyword in three shapes; if they do
        # not collapse, the pool reports one keyword as three and its
        # cross-surface corroboration bonus never fires.
        forms = ["Best AI Agent Tools", "best ai agent tools?", "  best   ai agent tools "]
        self.assertEqual({normalize(f) for f in forms}, {"best ai agent tools"})

    def test_curly_apostrophe_matches_straight(self):
        self.assertEqual(normalize("what's an ai agent"), normalize("what’s an ai agent"))


class IntentTest(unittest.TestCase):
    def test_funnel_position_wins_over_marker_count(self):
        # "best crm pricing" carries a commercial marker AND a transactional one.
        # The page that should answer it is the pricing page, so the deeper
        # intent has to win — otherwise the pool routes buyers to a listicle.
        self.assertEqual(classify_intent("best crm pricing"), "transactional")
        self.assertEqual(classify_intent("best crm tools"), "commercial")
        self.assertEqual(classify_intent("what is a crm"), "informational")
        self.assertEqual(classify_intent("crm login"), "navigational")

    def test_unclassified_is_its_own_answer(self):
        self.assertEqual(classify_intent("orange kitchen tiles"), "unclassified")


class CollectTest(unittest.TestCase):
    def test_own_brand_and_domain_are_discovery_noise(self):
        got = collect([], [h("orkas review"), h("orkas.ai pricing"), h("best agent tools")],
                      brand="Orkas", domain="orkas.ai")
        self.assertEqual([r["query"] for r in got["records"]], ["best agent tools"])
        reasons = " ".join(r["reason"] for r in got["rejected"])
        self.assertIn("own brand", reasons)

    def test_same_keyword_from_two_surfaces_is_one_record_with_both_sources(self):
        got = collect([], [h("best agent tools", "autocomplete"), h("Best Agent Tools", "paa")])
        self.assertEqual(len(got["records"]), 1)
        self.assertEqual(sorted(got["records"][0]["sources"]), ["autocomplete", "paa"])

    def test_length_bounds_reject_with_a_reason(self):
        got = collect([], [h("ai"), h(" ".join(["word"] * 13))])
        self.assertEqual(got["records"], [])
        self.assertEqual(len(got["rejected"]), 2)
        self.assertTrue(all(r["reason"] for r in got["rejected"]))


class ScoreTest(unittest.TestCase):
    def test_every_component_names_itself(self):
        score, reasons = score_keyword("best crm tools for startups", ["paa"], "commercial")
        self.assertTrue(reasons)
        self.assertTrue(any("audience/segment" in r for r in reasons))
        self.assertTrue(any("paa" in r for r in reasons))
        self.assertGreater(score, 50)

    def test_corroboration_across_surfaces_outranks_a_single_surface(self):
        one, _ = score_keyword("best crm tools", ["autocomplete"], "commercial")
        two, _ = score_keyword("best crm tools", ["autocomplete", "related"], "commercial")
        self.assertGreater(two, one)

    def test_navigational_is_penalised(self):
        nav, _ = score_keyword("acme docs login", ["autocomplete"], "navigational")
        com, _ = score_keyword("acme docs review", ["autocomplete"], "commercial")
        self.assertLess(nav, com)


class ClusterTest(unittest.TestCase):
    def build(self, queries):
        payload = {"harvested": [h(q, "related") for q in queries]}
        return expand(payload)["clusters"]

    def test_shared_topic_groups_and_unrelated_topic_does_not(self):
        clusters = self.build([
            "best crm software", "crm software pricing", "best crm software for startups",
            "best email marketing tools",
        ])
        heads = {c["head"] for c in clusters}
        self.assertEqual(len(clusters), 2, heads)
        crm = next(c for c in clusters if "crm" in c["head"])
        self.assertEqual(crm["size"], 3)

    def test_modifiers_do_not_split_one_topic(self):
        # "best X" / "top X" / "X review" are one topic shopped three ways; if
        # the modifier were part of the signature each would be its own cluster.
        clusters = self.build(["best crm software", "top crm software", "crm software review"])
        self.assertEqual(len(clusters), 1)
        self.assertEqual(clusters[0]["size"], 3)

    def test_two_word_topic_survives_its_shopping_modifiers(self):
        # The discriminating case. With three-word queries the >=2 shared-token
        # rule absorbs a stray modifier on its own, so that test passes either
        # way. Here the topic is a single content token: keep "best"/"top" in the
        # signature and the two rows share exactly one token, falling below the
        # threshold and splitting one topic into two clusters.
        clusters = self.build(["best crm", "top crm"])
        self.assertEqual(len(clusters), 1, [c["head"] for c in clusters])
        self.assertEqual(clusters[0]["size"], 2)

    def test_head_is_the_broadest_member_not_the_alphabetically_first(self):
        clusters = self.build(["best crm software for small teams", "crm software", "crm software pricing"])
        self.assertEqual(clusters[0]["head"], "crm software")


class DeterminismTest(unittest.TestCase):
    PAYLOAD = {"harvested": [h("crm software", "seed"), h("crm software login", "autocomplete")]}

    def test_dominant_intent_tie_is_resolved_by_funnel_rank_not_hash_order(self):
        # One commercial + one navigational. Counting alone leaves a tie, and the
        # obvious `max(set(...), key=count)` breaks it by set iteration order —
        # which Python randomises per process, so the same pool could report a
        # different intent on the next run.
        self.assertEqual(_dominant_intent(["commercial", "navigational"]), "commercial")
        self.assertEqual(_dominant_intent(["navigational", "commercial"]), "commercial")
        self.assertEqual(_dominant_intent(["informational", "transactional"]), "transactional")

    def test_output_is_byte_identical_under_different_hash_seeds(self):
        script = os.path.join(os.path.dirname(__file__), "..", "scripts", "keywords.py")
        outs = []
        for seed in ("0", "1", "12345"):
            env = dict(os.environ, PYTHONHASHSEED=seed)
            proc = subprocess.run([sys.executable, script], input=json.dumps(self.PAYLOAD),
                                  capture_output=True, text=True, env=env, check=True)
            outs.append(proc.stdout)
        self.assertEqual(len(set(outs)), 1, "expansion must not depend on hash seed")


class ExpandTest(unittest.TestCase):
    def test_reports_observed_not_measured(self):
        # A harvested suggestion proves a phrasing exists, never that anyone
        # searches it. Anything stronger than Observed would let a downstream
        # report present phrasing quality as demand.
        d = expand({"harvested": [h("best crm tools")]})
        self.assertEqual(d["data_tier"], "Observed")
        self.assertIn("NOT search volume", d["note"])

    def test_empty_input_raises_instead_of_returning_an_empty_pool(self):
        with self.assertRaises(ValueError):
            expand({})


if __name__ == "__main__":
    unittest.main()


class MetricsSeamTest(unittest.TestCase):
    """Volume attaches from a source that measures it, or not at all."""

    HARVEST = {"harvested": [h("best crm tools", "related"), h("crm software pricing", "paa")]}

    def rows(self, data):
        return {k["query"]: k for c in data["clusters"] for k in c["keywords"]}

    def test_measured_rows_are_tiered_individually_and_pool_reports_mixed(self):
        d = expand(dict(self.HARVEST, metrics={
            "Best CRM Tools": {"search_volume": 2400, "keyword_difficulty": 61, "source": "dataforseo"},
        }))
        rows = self.rows(d)
        self.assertEqual(rows["best crm tools"]["data_tier"], "Measured")
        self.assertEqual(rows["best crm tools"]["metrics"]["search_volume"], 2400)
        self.assertEqual(rows["crm software pricing"]["data_tier"], "Observed")
        # One measured keyword must not vouch for the unmeasured rest.
        self.assertEqual(d["data_tier"], "Mixed")
        self.assertEqual(d["summary"]["measured_rows"], 1)

    def test_metrics_key_matching_survives_provider_casing(self):
        d = expand(dict(self.HARVEST, metrics=[
            {"keyword": "  BEST   CRM Tools ", "search_volume": 10},
        ]))
        self.assertEqual(self.rows(d)["best crm tools"]["metrics"]["search_volume"], 10)

    def test_score_does_not_absorb_volume(self):
        # A blended figure would read as demand for every row, including the
        # ones nobody measured — the confusion data_tier exists to prevent.
        without = self.rows(expand(dict(self.HARVEST)))["best crm tools"]["score"]
        with_vol = self.rows(expand(dict(self.HARVEST, metrics={
            "best crm tools": {"search_volume": 99999}})))["best crm tools"]["score"]
        self.assertEqual(without, with_vol)

    def test_no_metrics_leaves_the_pool_observed(self):
        d = expand(dict(self.HARVEST))
        self.assertEqual(d["data_tier"], "Observed")
        self.assertEqual(d["summary"]["measured_rows"], 0)

    def test_fully_measured_pool_says_measured(self):
        d = expand(dict(self.HARVEST, metrics={
            "best crm tools": {"search_volume": 2400},
            "crm software pricing": {"search_volume": 300},
        }))
        self.assertEqual(d["data_tier"], "Measured")
