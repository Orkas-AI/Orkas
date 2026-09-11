"""Unit tests for deep-research caps. stdlib unittest, no deps.

Run:  cd PC/resources/builtin/marketplace/skills/ee99fbb42964 && python3 -m unittest

Covers hard-cap enforcement, step-cost aggregation, and BOTH matching shapes
(duplicate / reordered sub-questions that must collapse) and look-alike
non-matching shapes (distinct sub-questions that must NOT collapse) per the
repo's text-processing test rule.
"""

import os
import sys
import tempfile
import unittest
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import caps  # noqa: E402
from caps import (  # noqa: E402
    ABSOLUTE_CAPS,
    DEFAULT_CAPS,
    _num,
    account,
    account_from_files,
    effective_caps,
    plan,
)


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

    def test_unknown_cap_field_is_rejected_with_allowed_fields(self):
        with self.assertRaisesRegex(ValueError, r"unknown caps field\(s\).*allowed fields"):
            effective_caps({"unexpected_limit": 8})


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
    def test_explicit_fetch_caps_control_the_returned_budget(self):
        out = plan({
            "subquestions": ["desktop application comparison"],
            "caps": {"max_fetches": 8, "max_fetches_per_subquestion": 8},
        })
        self.assertEqual(out["total_fetch_budget"], 8)
        self.assertEqual(out["fetch_budget_per_subquestion"], 8)

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

    def test_budget_boundary_reports_spent_not_overrun(self):
        # 39/40 keeps going; 40/40 stops and is NOT an overrun — the old field
        # name reported a compliant 4/4 run as `exceeded` and an independent
        # judge docked it (2026-08-09 E2E). 41/40 was never covered at all, so
        # the one case that IS an overrun had no test.
        under = account({"steps": [{"step": "g", "fetches": 39}]})
        self.assertFalse(under["stop"])
        self.assertEqual(under["limits_reached"], [])
        self.assertEqual(under["remaining"]["fetches"], 1)

        spent = account({"steps": [{"step": "g", "fetches": 40}]})
        self.assertTrue(spent["stop"])
        self.assertIn("max_fetches", spent["limits_reached"])
        self.assertEqual(spent["remaining"]["fetches"], 0)
        # Spent, not overspent: the caller tells the two apart from totals vs
        # caps, which is why no extra field carries it.
        self.assertEqual(spent["totals"]["fetches"], spent["caps"]["max_fetches"])

        over = account({"steps": [{"step": "g", "fetches": 41}]})
        self.assertTrue(over["stop"])
        self.assertIn("max_fetches", over["limits_reached"])
        self.assertEqual(over["remaining"]["fetches"], 0)
        self.assertGreater(over["totals"]["fetches"], over["caps"]["max_fetches"])

    def test_stop_when_cost_exceeded_only_if_set(self):
        steps = [{"step": "g", "cost_usd": 0.5}]
        self.assertFalse(account({"steps": steps})["stop"])                       # no cost cap set
        out = account({"steps": steps, "caps": {"max_cost_usd": 0.1}})
        self.assertTrue(out["stop"])
        self.assertIn("max_cost_usd", out["limits_reached"])
        self.assertEqual(out["remaining"]["cost_usd"], 0.0)

    def test_no_stop_under_caps(self):
        out = account({"steps": [{"step": "g", "fetches": 3, "model_calls": 2}]})
        self.assertFalse(out["stop"])
        self.assertEqual(out["limits_reached"], [])
        self.assertEqual(out["remaining"]["fetches"], DEFAULT_CAPS["max_fetches"] - 3)

    def test_garbage_counts_coerced(self):
        out = account({"steps": [{"step": "g", "fetches": -5, "model_calls": "oops", "cost_usd": None}]})
        self.assertEqual(out["totals"], {"fetches": 0, "model_calls": 0, "cost_usd": 0.0})

    def test_num_coercion(self):
        self.assertEqual(_num(-3), 0.0)
        self.assertEqual(_num("x"), 0.0)
        self.assertEqual(_num(float("nan")), 0.0)
        self.assertEqual(_num(2.5), 2.5)


class FileBackedAccount(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.plan_path = os.path.join(self.tmp.name, "caps_plan.json")
        self.ledger_path = os.path.join(self.tmp.name, "fetch_ledger.jsonl")
        with open(self.plan_path, "w", encoding="utf-8") as fh:
            json.dump({"ok": True, "data": {"caps": {
                "max_fetches": 8,
                "max_fetches_per_subquestion": 8,
            }}}, fh)

    def tearDown(self):
        self.tmp.cleanup()

    def write_ledger(self, rows):
        with open(self.ledger_path, "w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row) + "\n")

    def test_counts_persisted_rows_and_reports_remaining_budget(self):
        self.write_ledger([{"status": "ok", "url": f"https://example.com/{i}"}
                           for i in range(7)])
        out = account_from_files(self.plan_path, self.ledger_path)
        self.assertEqual(out["totals"]["fetches"], 7)
        self.assertEqual(out["remaining"]["fetches"], 1)
        self.assertFalse(out["stop"])

    def test_failures_and_cached_attempts_consume_the_budget(self):
        rows = [{"status": "ok", "url": f"https://example.com/{i}"}
                for i in range(6)]
        rows.extend([
            {"status": "failed", "url": "https://example.com/failed"},
            {"status": "cached", "url": "https://example.com/cached"},
        ])
        self.write_ledger(rows)
        out = account_from_files(self.plan_path, self.ledger_path)
        self.assertEqual(out["totals"]["fetches"], 8)
        self.assertEqual(out["remaining"]["fetches"], 0)
        self.assertTrue(out["stop"])
        self.assertIn("max_fetches", out["limits_reached"])

    def test_search_rows_do_not_consume_a_fetch_budget(self):
        self.write_ledger([
            {"kind": "search", "query": "official privacy documentation", "status": "ok"},
            {"kind": "query", "query": "official pricing", "status": "failed"},
            {"query": "legacy discovery row", "status": "ok"},
            {"kind": "fetch", "canonical_url": "https://example.com/privacy", "status": "ok"},
            {"canonical_url": "https://example.com/pricing", "status": "failed"},
        ])
        out = account_from_files(self.plan_path, self.ledger_path)
        self.assertEqual(out["totals"]["fetches"], 2)
        self.assertEqual(out["remaining"]["fetches"], 6)
        self.assertFalse(out["stop"])

    def test_cli_file_mode_writes_the_account_result(self):
        self.write_ledger([{"status": "ok"} for _ in range(8)])
        out_path = os.path.join(self.tmp.name, "account_output.json")
        result = caps.main([
            "--op", "account",
            "--plan", self.plan_path,
            "--fetch-ledger", self.ledger_path,
            "--out", out_path,
        ])
        with open(out_path, encoding="utf-8") as fh:
            persisted = json.load(fh)
        self.assertEqual(result, persisted)
        self.assertTrue(persisted["data"]["stop"])

    def test_malformed_ledger_row_is_rejected_with_line_number(self):
        with open(self.ledger_path, "w", encoding="utf-8") as fh:
            fh.write('{"status":"ok"}\nnot-json\n')
        with self.assertRaisesRegex(ValueError, r"line 2 is not valid JSON"):
            account_from_files(self.plan_path, self.ledger_path)

    def test_plan_without_effective_caps_is_rejected(self):
        with open(self.plan_path, "w", encoding="utf-8") as fh:
            json.dump({"ok": True, "data": {"total_fetch_budget": 8}}, fh)
        self.write_ledger([])
        with self.assertRaisesRegex(ValueError, r"data must contain a caps object"):
            account_from_files(self.plan_path, self.ledger_path)


if __name__ == "__main__":
    unittest.main()


class CjkPlan(unittest.TestCase):
    """CJK bigram tokens: without them two pure-Chinese rephrasings produced
    empty token sets and the near-dup Jaccard check was silently skipped."""

    def test_chinese_near_duplicate_subquestions_collapse(self):
        out = plan({"subquestions": ["中国新能源汽车的出口趋势分析",
                                     "分析中国新能源汽车的出口趋势"]})
        self.assertEqual(len(out["subquestions"]), 1)
        self.assertEqual(len(out["dropped"]["duplicates"]), 1)

    def test_distinct_chinese_subquestions_are_kept(self):
        out = plan({"subquestions": ["中国新能源汽车的出口趋势",
                                     "欧洲电池回收政策的合规成本"]})
        self.assertEqual(len(out["subquestions"]), 2)
        self.assertEqual(out["dropped"]["duplicates"], [])
