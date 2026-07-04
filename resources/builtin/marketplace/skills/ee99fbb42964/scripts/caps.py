"""deep-research caps — deterministic budget guard + step-cost accounting.

GPT-Researcher's `deep` mode spawns a full researcher per sub-query with no hard
ceiling, so cost grows exponentially with breadth x depth. This skill is the
guardrail the agent runs so that can't happen, plus the cost bookkeeping GPT-R
does with `add_costs` keyed by `_current_step`:

  plan     — before fanning out: de-duplicate the proposed sub-questions, trim
             them to the cap, allocate a per-sub-question fetch budget, and refuse
             to recurse past max_depth. Nothing is dropped silently — trimmed and
             duplicate questions are reported back.
  account  — given the running ledger of work done (fetches / model_calls / cost
             per step), aggregate by step and by total, and say `stop: true` the
             moment any hard ceiling is crossed.

The agent supplies the numbers (it owns the loop and the model); this skill does
the deterministic arithmetic and enforcement. Overrides are clamped to absolute
ceilings so a mis-configured agent still cannot blow the budget.

stdlib only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata

# Sane defaults for one research task.
DEFAULT_CAPS = {
    "max_subquestions": 8,
    "max_fetches": 40,
    "max_fetches_per_subquestion": 8,
    "max_model_calls": 30,
    "max_depth": 2,
    "max_cost_usd": None,   # opt-in; enforced only when the agent sets it
}

# Absolute ceilings — an override may lower a cap but never raise it past these,
# so even a mis-configured agent cannot trigger the GPT-R exponential blowup.
ABSOLUTE_CAPS = {
    "max_subquestions": 20,
    "max_fetches": 100,
    "max_fetches_per_subquestion": 20,
    "max_model_calls": 100,
    "max_depth": 4,
}

NEAR_DUP_JACCARD = 0.8   # reordered / same-token sub-question rephrasings

_WORD_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z'\-]*", re.UNICODE)
_WS_RE = re.compile(r"\s+")
_STOP = {"what", "how", "why", "who", "when", "where", "which", "is", "are", "do",
         "does", "did", "the", "a", "an", "of", "to", "in", "on", "for", "and",
         "or", "can", "you", "explain", "tell", "me", "about", "give"}


def _norm_q(q: str) -> str:
    s = _WS_RE.sub(" ", unicodedata.normalize("NFKC", q)).strip().casefold()
    return s.rstrip("?!.。？！ ").strip()


def _tok(q: str) -> list:
    return [w for w in (m.group(0).lower() for m in _WORD_RE.finditer(q or ""))
            if len(w) >= 2 and w not in _STOP]


def _num(v) -> float:
    """Coerce to a non-negative finite number; garbage / negatives / NaN -> 0."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return f if f >= 0 and f == f else 0.0


def effective_caps(overrides) -> dict:
    caps = dict(DEFAULT_CAPS)
    if isinstance(overrides, dict):
        caps.update({k: v for k, v in overrides.items() if v is not None})
    for k, absolute in ABSOLUTE_CAPS.items():
        val = caps.get(k)
        caps[k] = min(int(val), absolute) if isinstance(val, (int, float)) else absolute
    for k in ("max_subquestions", "max_fetches", "max_fetches_per_subquestion", "max_model_calls"):
        caps[k] = max(1, int(caps[k]))
    caps["max_depth"] = max(0, int(caps["max_depth"]))
    if caps.get("max_cost_usd") is not None:
        caps["max_cost_usd"] = max(0.0, float(caps["max_cost_usd"]))
    return caps


def _dedup_questions(qs: list) -> tuple:
    kept, kept_tok, dropped = [], [], []
    seen = set()
    for q in qs:
        key = _norm_q(q)
        if not key or key in seen:
            dropped.append(q)
            continue
        toks = set(_tok(q))
        near = False
        for prev in kept_tok:
            if toks and prev and len(toks & prev) / len(toks | prev) >= NEAR_DUP_JACCARD:
                near = True
                break
        if near:
            dropped.append(q)
            continue
        seen.add(key)
        kept.append(q.strip())
        kept_tok.append(toks)
    return kept, dropped


def plan(payload: dict) -> dict:
    caps = effective_caps(payload.get("caps"))
    depth = int(_num(payload.get("depth")))
    raw = [q for q in (payload.get("subquestions") or []) if isinstance(q, str) and q.strip()]

    kept, dup = _dedup_questions(raw)
    over_cap = []
    if len(kept) > caps["max_subquestions"]:
        over_cap = kept[caps["max_subquestions"]:]
        kept = kept[:caps["max_subquestions"]]

    n = len(kept) or 1
    per_subq = min(caps["max_fetches_per_subquestion"], max(1, caps["max_fetches"] // n))
    allowed = depth <= caps["max_depth"]
    return {
        "allowed": allowed,
        "reason": None if allowed else "max_depth_exceeded",
        "depth": depth,
        "subquestions": kept,
        "fetch_budget_per_subquestion": per_subq,
        "total_fetch_budget": caps["max_fetches"],
        "dropped": {"duplicates": dup, "over_cap": over_cap},
        "caps": caps,
    }


def account(payload: dict) -> dict:
    caps = effective_caps(payload.get("caps"))
    steps = payload.get("steps") or []
    by_step = {}
    totals = {"fetches": 0, "model_calls": 0, "cost_usd": 0.0}
    for s in steps:
        if not isinstance(s, dict):
            continue
        name = str(s.get("step") or "?")
        agg = by_step.setdefault(name, {"fetches": 0, "model_calls": 0, "cost_usd": 0.0})
        for k in ("fetches", "model_calls"):
            v = int(_num(s.get(k)))
            agg[k] += v
            totals[k] += v
        c = _num(s.get("cost_usd"))
        agg["cost_usd"] = round(agg["cost_usd"] + c, 6)
        totals["cost_usd"] = round(totals["cost_usd"] + c, 6)

    exceeded = []
    if totals["fetches"] >= caps["max_fetches"]:
        exceeded.append("max_fetches")
    if totals["model_calls"] >= caps["max_model_calls"]:
        exceeded.append("max_model_calls")
    if caps.get("max_cost_usd") is not None and totals["cost_usd"] >= caps["max_cost_usd"]:
        exceeded.append("max_cost_usd")

    remaining = {"fetches": max(0, caps["max_fetches"] - totals["fetches"]),
                 "model_calls": max(0, caps["max_model_calls"] - totals["model_calls"])}
    if caps.get("max_cost_usd") is not None:
        remaining["cost_usd"] = round(max(0.0, caps["max_cost_usd"] - totals["cost_usd"]), 6)

    return {"totals": totals, "by_step": by_step, "remaining": remaining,
            "exceeded": exceeded, "stop": bool(exceeded), "caps": caps}


def _load(path):
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def main(argv):
    ap = argparse.ArgumentParser(prog="deep-research/caps")
    ap.add_argument("--op", choices=["plan", "account"], required=True)
    ap.add_argument("--input", default=None, help="payload JSON (default stdin)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    payload = _load(args.input)
    if not isinstance(payload, dict):
        raise ValueError("input must be a JSON object")
    data = plan(payload) if args.op == "plan" else account(payload)

    result = {"ok": True, "data": data}
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False)
    return result


if __name__ == "__main__":
    try:
        out = main(sys.argv[1:])
    except (ValueError, OSError, json.JSONDecodeError) as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(out, ensure_ascii=False))
