"""seo-keywords — turn harvested search-surface suggestions into a keyword pool.

Split for the same reason as geo-probe: a Python skill cannot reach the network,
so the AGENT harvests (autocomplete / related searches / People Also Ask via
`web_search`) and this skill does the deterministic half — normalise, dedupe,
classify intent, cluster, score.

Why the split matters here specifically. The reference open-source tool for this
job (chukhraiartur/seo-keyword-research-tool) is a thin SerpApi wrapper: three
endpoints, recursive People-Also-Ask paging, and no processing at all — its
output is three flat lists of raw strings. The value it delivers is the data
source, which we cannot buy into; the value it leaves on the table is everything
below, which is free. A pool of 300 near-duplicate strings is not research.

Honesty: a harvested suggestion is evidence that a phrasing exists on the search
surface, NOT evidence of volume. Nothing here estimates volume or difficulty —
`seo-opportunity` keeps that distinction as Measured vs Estimated, and this skill
reports `Observed` so no downstream reader mistakes a suggestion for demand.

stdlib only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys

_WORD_RE = re.compile(r"[\w'’-]+", re.UNICODE)

# Dropped when computing a cluster signature: they describe how the searcher is
# shopping, not what they are shopping for, so keeping them scatters one topic
# across "best X" / "top X" / "X review".
_MODIFIERS = {
    "best", "top", "good", "great", "cheap", "cheapest", "free", "paid", "new",
    "review", "reviews", "compare", "comparison", "vs", "versus", "alternative",
    "alternatives", "guide", "tutorial", "how", "what", "why", "when", "where",
    "which", "who", "is", "are", "does", "do", "can", "should", "the", "a", "an",
    "of", "to", "in", "on", "for", "with", "and", "or", "my", "your", "you",
}
_YEAR_RE = re.compile(r"^(19|20)\d{2}$")

_TRANSACTIONAL = re.compile(
    r"\b(buy|purchase|order|price|pricing|cost|quote|discount|coupon|deal|"
    r"free trial|trial|download|install|sign ?up|subscribe)\b", re.I)
_COMMERCIAL = re.compile(
    r"\b(best|top|review|reviews|vs|versus|alternatives?|comparison|compare|"
    r"tools?|software|platforms?|apps?|services?|vendors?|providers?|solutions?)\b", re.I)
_INFORMATIONAL = re.compile(
    r"\b(what|how|why|when|where|which|who|guide|tutorial|examples?|meaning|"
    r"definition|explained|ideas|tips|checklist|template)\b", re.I)
_NAVIGATIONAL = re.compile(
    r"\b(login|log ?in|sign ?in|docs|documentation|support|contact|pricing page|"
    r"careers|status)\b", re.I)

# A suggestion carrying a real audience/segment is worth more than a head term:
# it is the phrasing a buyer with a concrete need actually types.
_SEGMENT = re.compile(
    r"\b(teams?|developers?|designers?|startups?|agencies|enterprises?|marketers?|"
    r"founders?|students?|researchers?|writers?|creators?|analysts?|freelancers?|"
    r"small business(?:es)?|beginners?|nonprofits?)\b", re.I)

SOURCES = ("autocomplete", "related", "paa", "seed")
# People-Also-Ask and related searches are rendered by the engine from observed
# result behaviour; autocomplete is prefix-driven and reaches further down the
# tail but is noisier. The weights only break ties inside a cluster.
_SOURCE_WEIGHT = {"paa": 8, "related": 6, "autocomplete": 4, "seed": 2}

MAX_WORDS = 12
MIN_WORDS = 2


def normalize(text: str) -> str:
    """Collapse a suggestion to its comparable form. Case, punctuation and inner
    whitespace vary freely across the three surfaces for what is one keyword."""
    low = str(text or "").strip().lower()
    low = low.replace("’", "'")
    low = re.sub(r"[^\w\s'-]+", " ", low, flags=re.UNICODE)
    return re.sub(r"\s+", " ", low).strip()


def classify_intent(text: str) -> str:
    """First match wins, most commercially decisive first.

    A query can carry several markers ("best crm pricing"); the one that decides
    what page should answer it is the furthest down the funnel, so transactional
    outranks commercial and commercial outranks informational.
    """
    if _NAVIGATIONAL.search(text):
        return "navigational"
    if _TRANSACTIONAL.search(text):
        return "transactional"
    if _COMMERCIAL.search(text):
        return "commercial"
    if _INFORMATIONAL.search(text):
        return "informational"
    return "unclassified"


def _content_tokens(norm: str) -> list[str]:
    out = []
    for w in _WORD_RE.findall(norm):
        if w in _MODIFIERS or _YEAR_RE.match(w) or len(w) < 3:
            continue
        out.append(w)
    return out


def score_keyword(norm: str, sources: list[str], intent: str) -> tuple[int, list[str]]:
    """0-100 on observable properties only.

    We cannot measure volume, so this scores what the phrasing itself tells us,
    and every component names itself in `reasons` — an unexplained keyword score
    is indistinguishable from a made-up one.
    """
    words = norm.split()
    wc = len(words)
    score, reasons = 40, []

    if 3 <= wc <= 7:
        score += 18
        reasons.append("+18 word-count sweet spot ({})".format(wc))
    elif wc == 2:
        score += 4
        reasons.append("+4 head term (2 words)")
    elif wc > 9:
        score -= 8
        reasons.append("-8 very long ({} words)".format(wc))

    if intent == "transactional":
        score += 16
        reasons.append("+16 transactional intent")
    elif intent == "commercial":
        score += 12
        reasons.append("+12 commercial intent")
    elif intent == "navigational":
        score -= 12
        reasons.append("-12 navigational (someone already knows the destination)")

    if _SEGMENT.search(norm):
        score += 10
        reasons.append("+10 names an audience/segment")

    best_source = max(sources, key=lambda s: _SOURCE_WEIGHT.get(s, 0)) if sources else "seed"
    weight = _SOURCE_WEIGHT.get(best_source, 0)
    score += weight
    reasons.append("+{} strongest source: {}".format(weight, best_source))

    if len(set(sources)) > 1:
        score += 6
        reasons.append("+6 corroborated across {} surfaces".format(len(set(sources))))

    return max(0, min(100, score)), reasons


def collect(seeds, harvested, brand: str = "", domain: str = "") -> dict:
    """Merge seeds + harvested rows into deduped keyword records."""
    brand_l = (brand or "").lower().strip()
    core = re.sub(r"\.[a-z]{2,}$", "", (domain or "").lower().strip())

    by_norm: dict[str, dict] = {}
    rejected: list[dict] = []

    def offer(raw, source):
        norm = normalize(raw)
        if not norm:
            rejected.append({"query": str(raw), "reason": "empty after normalization"})
            return
        wc = len(norm.split())
        if wc < MIN_WORDS:
            rejected.append({"query": norm, "reason": "too short ({} word)".format(wc)})
            return
        if wc > MAX_WORDS:
            rejected.append({"query": norm, "reason": "too long ({} words)".format(wc)})
            return
        # Own-brand queries belong to brand defence, not discovery: they are
        # already ours to lose and would dominate a pool meant to surface demand
        # we do not yet serve.
        if brand_l and brand_l in norm:
            rejected.append({"query": norm, "reason": 'own brand "{}"'.format(brand)})
            return
        if core and len(core) >= 4 and core in norm:
            rejected.append({"query": norm, "reason": 'own domain "{}"'.format(core)})
            return
        rec = by_norm.get(norm)
        if rec is None:
            by_norm[norm] = {"query": norm, "sources": [source]}
        elif source not in rec["sources"]:
            rec["sources"].append(source)

    for s in seeds or []:
        offer(s, "seed")
    for row in harvested or []:
        if isinstance(row, dict):
            offer(row.get("query") or row.get("text") or row.get("value"),
                  (row.get("source") or "autocomplete").lower())
        else:
            offer(row, "autocomplete")

    return {"records": list(by_norm.values()), "rejected": rejected}


# Tie-break order for a cluster's dominant intent, matching `classify_intent`'s
# precedence. `max(set(intents), key=intents.count)` looked equivalent but broke
# ties by set iteration order — and Python randomises string hashing per process,
# so the same pool could report a different dominant intent on the next run.
_INTENT_RANK = {"transactional": 4, "commercial": 3, "informational": 2,
                "navigational": 1, "unclassified": 0}


def _dominant_intent(intents: list[str]) -> str:
    if not intents:
        return "unclassified"
    counts: dict[str, int] = {}
    for i in intents:
        counts[i] = counts.get(i, 0) + 1
    return max(counts, key=lambda i: (counts[i], _INTENT_RANK.get(i, 0)))


def cluster(records: list[dict]) -> list[dict]:
    """Group keywords that share at least two content tokens.

    Greedy and first-match on purpose: this is a reading aid for the pool, not a
    taxonomy. Two shared content tokens is the cheapest rule that puts "best crm
    software for startups" and "crm software pricing" together while keeping
    "best crm software" apart from "best email software".
    """
    clusters: list[dict] = []
    for rec in sorted(records, key=lambda r: (-r["score"], r["query"])):
        tokens = set(rec["_tokens"])
        placed = False
        for c in clusters:
            if len(tokens & c["_tokens"]) >= 2 or (len(tokens) == 1 and tokens <= c["_tokens"]):
                c["keywords"].append(rec)
                c["_tokens"] |= tokens
                placed = True
                break
        if not placed:
            clusters.append({"_tokens": set(tokens), "keywords": [rec]})

    out = []
    for c in clusters:
        kws = c["keywords"]
        # Shortest wins (a cluster is named by its broadest member), ties broken
        # by score then text — never by `min` on the raw string alone, which
        # named a four-word cluster after "…pricing" purely because "a" sorts
        # before "b".
        head = min(kws, key=lambda r: (len(r["query"].split()), -r["score"], r["query"]))
        out.append({
            "head": head["query"],
            "dominant_intent": _dominant_intent([k["intent"] for k in kws]),
            "size": len(kws),
            "score": max(k["score"] for k in kws),
            "keywords": [{k: v for k, v in r.items() if not k.startswith("_")} for r in kws],
        })
    out.sort(key=lambda c: (-c["score"], -c["size"], c["head"]))
    return out


# Field names follow the shape every volume provider already returns (DataForSEO,
# Search Console exports, Keyword Planner), so a caller pastes rows through
# instead of translating them.
_METRIC_FIELDS = ("search_volume", "keyword_difficulty", "cpc", "competition")


def attach_metrics(records: list[dict], metrics) -> int:
    """Attach externally MEASURED volume/difficulty to matching keywords.

    Deliberately additive and deliberately not blended into `score`. Volume is
    demand; `score` is phrasing quality. Folding a measured number into a
    heuristic one produces a single figure that reads as demand for every row
    including the ones nobody measured — the exact confusion `data_tier` exists
    to prevent. A row that gets metrics is re-tiered `Measured`; the rest stay
    `Observed` and say so per row.
    """
    if not metrics:
        return 0
    by_key = {}
    if isinstance(metrics, dict):
        for k, v in metrics.items():
            by_key[normalize(k)] = v if isinstance(v, dict) else {"search_volume": v}
    else:
        for row in metrics:
            if isinstance(row, dict) and (row.get("keyword") or row.get("query")):
                by_key[normalize(row.get("keyword") or row.get("query"))] = row

    hits = 0
    for rec in records:
        row = by_key.get(rec["query"])
        if not row:
            continue
        picked = {f: row[f] for f in _METRIC_FIELDS if row.get(f) is not None}
        if not picked:
            continue
        rec["metrics"] = picked
        if row.get("source"):
            rec["metrics"]["source"] = str(row["source"])
        rec["data_tier"] = "Measured"
        hits += 1
    return hits


def expand(payload: dict, limit: int = 200) -> dict:
    seeds = payload.get("seeds") or []
    harvested = payload.get("harvested") or []
    if not seeds and not harvested:
        raise ValueError("nothing to expand: provide seeds and/or harvested rows")

    got = collect(seeds, harvested, payload.get("brand") or "", payload.get("domain") or "")
    records = got["records"]
    for rec in records:
        rec["intent"] = classify_intent(rec["query"])
        rec["score"], rec["score_reasons"] = score_keyword(rec["query"], rec["sources"], rec["intent"])
        rec["data_tier"] = "Observed"
        rec["_tokens"] = _content_tokens(rec["query"])
    measured = attach_metrics(records, payload.get("metrics"))
    records.sort(key=lambda r: (-r["score"], r["query"]))
    kept = records[:limit]

    intents: dict[str, int] = {}
    for r in kept:
        intents[r["intent"]] = intents.get(r["intent"], 0) + 1

    clusters = cluster(kept)
    measured_kept = sum(1 for r in kept if r.get("data_tier") == "Measured")
    return {
        "summary": {
            "seeds": len(seeds), "harvested_rows": len(harvested),
            "kept": len(kept), "rejected": len(got["rejected"]),
            "clusters": len(clusters), "by_intent": intents,
            "measured_rows": measured_kept,
        },
        "clusters": clusters,
        "rejected": got["rejected"],
        # Pool-level tier is the weakest row's: a pool is only fully Measured
        # when every row carries external metrics, and reporting otherwise would
        # let one measured keyword vouch for a hundred unmeasured ones.
        "data_tier": ("Measured" if kept and measured_kept == len(kept)
                      else "Mixed" if measured_kept else "Observed"),
        "note": ("Observed = these phrasings exist on the search surface the agent "
                 "harvested (autocomplete / related searches / People Also Ask). That is "
                 "NOT search volume and NOT difficulty: no row here says how many people "
                 "search it. Do not present a score as demand — it ranks phrasing quality "
                 "(intent, specificity, corroboration across surfaces), nothing more. "
                 "Rows carrying external `metrics` are tiered Measured individually; "
                 "`score` never absorbs those numbers, so a measured row and an "
                 "unmeasured one stay distinguishable. Nothing here estimates volume."),
    }


def _load(path):
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def main(argv):
    ap = argparse.ArgumentParser(prog="seo-keywords")
    ap.add_argument("--op", choices=["expand"], default="expand")
    ap.add_argument("--input", default=None, help="{seeds:[],harvested:[{query,source}],brand,domain} (default stdin)")
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    result = {"ok": True, "data": expand(_load(args.input), limit=args.limit)}
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
