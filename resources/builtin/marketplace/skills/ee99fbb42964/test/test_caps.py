"""Unit tests for deep-research caps. stdlib unittest, no deps.

Run:  cd PC/resources/builtin/marketplace/skills/ee99fbb42964 && python3 -m unittest

Covers hard-cap enforcement, step-cost aggregation, and BOTH matching shapes
(duplicate / reordered sub-questions that must collapse) and look-alike
non-matching shapes (distinct sub-questions that must NOT collapse) per the
repo's text-processing test rule.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import caps  # noqa: E402
from caps import ABSOLUTE_CAPS, DEFAULT_CAPS, _num, account, effective_caps, plan  # noqa: E402


class EffectiveCaps(unittest.TestCase):
    def test_defaults(self):
        c = effective_caps(None)
        self.assertEqual(c["max_subquestions"], DEFAULT_CAPS["max_subquestions"])
        self.assertIsNone(c["max_cost_usd"])

    def test_override_lowers(self):
        self.assertEqual(effective_caps({"max_subquestions": 3})["max_subquestions"], 3)

    def test_override_cannot_exceed_absolute(self):
        c = effective_caps({"max_fetches": 1000, "max_depth": 99, "max_subquestions": 50})
        self.assertEqual(c["max_fetches"], ABSOLUTE_CAPS["max_fetches"])
        self.assertEqual(c["max_depth"], ABSOLUTE_CAPS["max_depth"])
        self.assertEqual(c["max_subquestions"], ABSOLUTE_CAPS["max_subquestions"])

    def test_counts_floored_at_one(self):
        self.assertEqual(effective_caps({"max_fetches": 0})["max_fetches"], 1)

    def test_cost_cap_passthrough(self):
        self.assertEqual(effective_caps({"max_cost_usd": 0.25})["max_cost_usd"], 0.25)


# Genuinely distinct sub-questions (disjoint content words, so dedup does not
# collapse them — the earlier bug was fixtures whose only difference was a
# single-digit index that tokenization drops).
POOL = [
    "encryption at rest guarantees", "network latency impact benchmarks",
    "offline inference accuracy tradeoffs", "battery power consumption profile",
    "user consent flow design", "data retention policy limits",
    "third party audit findings", "open source licensing terms",
    "memory footprint ceiling", "cross device state sync",
    "prompt injection defense mechanisms", "regulatory compliance jurisdiction scope",
]


class Plan(unittest.TestCase):
    def test_exact_duplicate_questions_collapse(self):
        out = plan({"subquestions": ["What is X?", "what is x", "How does Y work?"]})
        self.assertEqual(out["subquestions"], ["What is X?", "How does Y work?"])
        self.assertEqual(out["dropped"]["duplicates"], ["what is x"])

    def test_reordered_tokens_are_near_duplicate(self):
        out = plan({"subquestions": ["local first ai agent privacy model",
                                     "privacy model local first ai agent"]})
        self.assertEqual(len(out["subquestions"]), 1)

    def test_distinct_questions_are_kept(self):
        out = plan({"subquestions": ["local first ai agent privacy",
                                     "cloud server latency cost tradeoff"]})
        self.assertEqual(len(out["subquestions"]), 2)
        self.assertEqual(out["dropped"]["duplicates"], [])

    def test_trim_over_cap_reported(self):
        out = plan({"subquestions": list(POOL)})   # 12 distinct
        self.assertEqual(len(out["subquestions"]), DEFAULT_CAPS["max_subquestions"])
        self.assertEqual(len(out["dropped"]["over_cap"]), len(POOL) - DEFAULT_CAPS["max_subquestions"])

    def test_fetch_budget_allocation(self):
        self.assertEqual(plan({"subquestions": POOL[:8]})["fetch_budget_per_subquestion"], 5)  # 40//8
        self.assertEqual(plan({"subquestions": POOL[:2]})["fetch_budget_per_subquestion"], 8)  # min(8, 40//2)

    def test_depth_guard(self):
        out = plan({"subquestions": ["a topic here"], "depth": 3, "caps": {"max_depth": 2}})
        self.assertFalse(out["allowed"])
        self.assertEqual(out["reason"], "max_depth_exceeded")

    def test_depth_within_limit_allowed(self):
        self.assertTrue(plan({"subquestions": ["a topic here"], "depth": 1})["allowed"])


class Account(unittest.TestCase):
    def test_aggregate_by_step(self):
        out = account({"steps": [
            {"step": "gather", "fetches": 3, "model_calls": 1, "cost_usd": 0.01},
            {"step": "gather", "fetches": 2, "model_calls": 1, "cost_usd": 0.02},
            {"step": "synth", "model_calls": 2, "cost_usd": 0.05},
        ]})
        self.assertEqual(out["by_step"]["gather"]["fetches"], 5)
        self.assertEqual(out["by_step"]["gather"]["model_calls"], 2)
        self.assertEqual(out["totals"]["fetches"], 5)
        self.assertEqual(out["totals"]["model_calls"], 4)
        self.assertAlmostEqual(out["totals"]["cost_usd"], 0.08, places=6)

    def test_stop_when_fetches_exceeded(self):
        out = account({"steps": [{"step": "g", "fetches": 40}]})
        self.assertTrue(out["stop"])
        self.assertIn("max_fetches", out["exceeded"])
        self.assertEqual(out["remaining"]["fetches"], 0)

    def test_stop_when_cost_exceeded_only_if_set(self):
        steps = [{"step": "g", "cost_usd": 0.5}]
        self.assertFalse(account({"steps": steps})["stop"])                       # no cost cap set
        out = account({"steps": steps, "caps": {"max_cost_usd": 0.1}})
        self.assertTrue(out["stop"])
        self.assertIn("max_cost_usd", out["exceeded"])
        self.assertEqual(out["remaining"]["cost_usd"], 0.0)

    def test_no_stop_under_caps(self):
        out = account({"steps": [{"step": "g", "fetches": 3, "model_calls": 2}]})
        self.assertFalse(out["stop"])
        self.assertEqual(out["exceeded"], [])
        self.assertEqual(out["remaining"]["fetches"], DEFAULT_CAPS["max_fetches"] - 3)

    def test_garbage_counts_coerced(self):
        out = account({"steps": [{"step": "g", "fetches": -5, "model_calls": "oops", "cost_usd": None}]})
        self.assertEqual(out["totals"], {"fetches": 0, "model_calls": 0, "cost_usd": 0.0})

    def test_num_coercion(self):
        self.assertEqual(_num(-3), 0.0)
        self.assertEqual(_num("x"), 0.0)
        self.assertEqual(_num(float("nan")), 0.0)
        self.assertEqual(_num(2.5), 2.5)


if __name__ == "__main__":
    unittest.main()
