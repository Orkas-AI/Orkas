"""seo-backlink-value — deterministic valuation of a backlink offer.

Stdlib only. The skill never fetches authority or traffic data: the agent (or
the user) supplies DR/DA, monthly traffic, organic share, trend, domain age and
the seller's quote, and this script turns them into a quality gate, a market
price band, a link-type adjusted value and a verdict on the quote.

Method (mirrors the public "backlink value calculator" pattern):
1. Quality gate with veto power: zombie sites (no traffic), inflated traffic
   (organic share below 15%), link farms (high DR, no traffic) and de-indexed
   domains are "avoid" regardless of price.
2. Market band: the site is placed in one of 48 DR-tier x traffic-tier
   brackets. Observed listing prices for comparable sites, when supplied,
   give the 25th/50th/75th percentiles; otherwise an embedded reference table
   of guest-post medians is used and the band is labelled Estimated.
3. Quality refinements: high organic share +10%, traffic decline -15%, young
   domain -10%, link-heavy page -10%, topical relevance +10% / -20%.
4. Link-type multiplier on the guest-post baseline: homepage/sitewide x1.3,
   niche edit x0.7, directory x0.5, nofollow x0.4.

Public proxies: when the agent could not obtain DR or traffic from a data
provider, it may pass what free public endpoints return (Tranco popularity
rank with history, RDAP registration date, a `site:` result count). The skill
converts them into conservative tier estimates, records the source of every
metric, and labels the whole result `public_proxy`. Supplied metrics always
win over proxies.

Every number here is a heuristic; the output carries `data_tier`, per-metric
sources and notes so the agent can label it Estimated and never present it as
measured market fact.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import sys

LINK_TYPES = {
    "guest_post": 1.0,
    "homepage": 1.3,
    "niche_edit": 0.7,
    "directory": 0.5,
    "nofollow": 0.4,
}
LINK_TYPE_ALIASES = {
    "guest post": "guest_post", "guestpost": "guest_post", "gp": "guest_post", "article": "guest_post",
    "sitewide": "homepage", "site-wide": "homepage", "home": "homepage", "footer": "homepage", "sidebar": "homepage",
    "niche": "niche_edit", "link insertion": "niche_edit", "insertion": "niche_edit", "edit": "niche_edit",
    "listing": "directory", "profile": "directory",
    "no-follow": "nofollow", "no follow": "nofollow", "sponsored": "nofollow", "ugc": "nofollow",
}

DR_TIERS = [(0, 10), (10, 20), (20, 30), (30, 40), (40, 50), (50, 60), (60, 70), (70, 101)]
TRAFFIC_TIERS = [(0, 1_000), (1_000, 5_000), (5_000, 20_000), (20_000, 100_000), (100_000, 500_000), (500_000, math.inf)]

# Reference guest-post medians in USD, rows = DR tiers, cols = traffic tiers.
# Heuristic public-market shape (higher authority and traffic cost more; the
# traffic axis dominates at low DR). Comparable sites routinely differ 4x, so
# the band is p25 = 0.6 x median and p75 = 1.6 x median around these values.
REFERENCE_MEDIAN_USD = [
    [20, 35, 60, 90, 130, 180],
    [35, 55, 85, 130, 180, 250],
    [50, 80, 120, 180, 250, 340],
    [70, 110, 170, 250, 350, 470],
    [100, 160, 240, 350, 480, 650],
    [150, 230, 340, 480, 660, 900],
    [220, 330, 480, 680, 920, 1250],
    [320, 480, 700, 980, 1350, 1800],
]
REFERENCE_P25_RATIO = 0.6
REFERENCE_P75_RATIO = 1.6
MIN_OBSERVED_PRICES = 5

ZERO_TRAFFIC_MAX = 100
INFLATED_ORGANIC_SHARE_MAX = 0.15
LINK_FARM_DR_MIN = 40
LINK_FARM_TRAFFIC_MAX = 500
HIGH_ORGANIC_SHARE_MIN = 0.60
TRAFFIC_DECLINE_MAX = -0.15
YOUNG_DOMAIN_YEARS = 1.0
LINK_HEAVY_PAGE_MIN = 50

QUALITY_TIERS = [(75, "strong"), (50, "solid"), (30, "weak"), (0, "poor")]

# Tranco popularity rank -> conservative monthly-visit and authority estimates.
# Tranco lists the top million domains; the estimates sit low in each traffic
# tier. Missing ranks and ranks outside the supported top million leave
# traffic and authority unknown; absence from Tranco is not a measurement.
TRANCO_PROXY_TIERS = [
    (10_000, 750_000, 70),
    (50_000, 200_000, 55),
    (200_000, 50_000, 40),
    (500_000, 10_000, 28),
    (1_000_000, 2_500, 18),
]
TRANCO_TREND_MIN_DAYS = 14
TRANCO_TREND_CLAMP = 0.5


class InputError(ValueError):
    """Raised for a payload the calculator cannot evaluate."""


def _num(value, name: str, *, minimum=None, maximum=None):
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise InputError(f"{name} must be a number") from None
    if math.isnan(number) or math.isinf(number):
        raise InputError(f"{name} must be a finite number")
    if minimum is not None and number < minimum:
        raise InputError(f"{name} must be >= {minimum}")
    if maximum is not None and number > maximum:
        raise InputError(f"{name} must be <= {maximum}")
    return number


def _share(value, name: str):
    number = _num(value, name)
    if number is None:
        return None
    if number > 1.0:
        number = number / 100.0  # accept percentages such as 62
    if number < 0 or number > 1:
        raise InputError(f"{name} must be a share between 0 and 1 (or 0 and 100)")
    return number


def normalize_link_type(value) -> str:
    text = str(value or "guest_post").strip().lower().replace("_", " ")
    key = text.replace(" ", "_")
    if key in LINK_TYPES:
        return key
    if text in LINK_TYPE_ALIASES:
        return LINK_TYPE_ALIASES[text]
    raise InputError("link_type must be one of: " + ", ".join(LINK_TYPES))


def tier_index(value: float, tiers) -> int:
    for index, (low, high) in enumerate(tiers):
        if low <= value < high:
            return index
    return len(tiers) - 1


def tier_label(index: int, tiers, unit: str = "") -> str:
    low, high = tiers[index]
    if math.isinf(high):
        return f"{int(low):,}+{unit}"
    return f"{int(low):,}-{int(high):,}{unit}"


def percentile(sorted_values, fraction: float) -> float:
    """Nearest-rank percentile on an ascending list."""
    if not sorted_values:
        raise InputError("percentile of an empty list")
    rank = max(1, math.ceil(fraction * len(sorted_values)))
    return float(sorted_values[min(rank, len(sorted_values)) - 1])


def market_band(dr: float, traffic: float, observed_prices=None) -> dict:
    dr_index = tier_index(dr, DR_TIERS)
    traffic_index = tier_index(traffic, TRAFFIC_TIERS)
    prices = []
    for price in observed_prices or []:
        try:
            number = float(price)
        except (TypeError, ValueError):
            continue
        if number > 0 and math.isfinite(number):
            prices.append(number)
    prices.sort()
    if len(prices) >= MIN_OBSERVED_PRICES:
        band = {
            "p25": percentile(prices, 0.25),
            "median": percentile(prices, 0.50),
            "p75": percentile(prices, 0.75),
        }
        data_tier = "observed_market"
        basis = f"{len(prices)} observed listing prices supplied for comparable sites"
    else:
        median = float(REFERENCE_MEDIAN_USD[dr_index][traffic_index])
        band = {
            "p25": median * REFERENCE_P25_RATIO,
            "median": median,
            "p75": median * REFERENCE_P75_RATIO,
        }
        data_tier = "reference_table"
        basis = "embedded guest-post reference table (heuristic, Estimated)"
        if prices:
            basis += f"; {len(prices)} observed prices ignored (need at least {MIN_OBSERVED_PRICES})"
    return {
        "dr_tier": tier_label(dr_index, DR_TIERS),
        "traffic_tier": tier_label(traffic_index, TRAFFIC_TIERS, "/mo"),
        "bracket": f"DR {tier_label(dr_index, DR_TIERS)} x traffic {tier_label(traffic_index, TRAFFIC_TIERS, '/mo')}",
        "guest_post_band_usd": band,
        "data_tier": data_tier,
        "basis": basis,
    }


def quality_gate(metrics: dict) -> dict:
    dr = metrics.get("dr")
    traffic = metrics.get("monthly_traffic")
    organic = metrics.get("organic_share")
    missing = [name for name in ("dr", "monthly_traffic") if metrics.get(name) is None]
    if missing:
        return {"status": "insufficient_evidence", "reasons": [], "missing_metrics": missing}
    reasons = []
    if metrics.get("indexed") is False:
        reasons.append({"code": "deindexed", "detail": "domain reported as not indexed by Google"})
    if traffic < ZERO_TRAFFIC_MAX:
        reasons.append({"code": "zero_traffic", "detail": f"monthly traffic {int(traffic):,} is below {ZERO_TRAFFIC_MAX}: zombie site"})
    if organic is not None and organic < INFLATED_ORGANIC_SHARE_MAX and traffic >= 1_000:
        reasons.append({"code": "inflated_traffic", "detail": f"organic search share {organic:.0%} is below {INFLATED_ORGANIC_SHARE_MAX:.0%}: traffic is not search-driven"})
    if dr >= LINK_FARM_DR_MIN and traffic < LINK_FARM_TRAFFIC_MAX:
        reasons.append({"code": "link_farm", "detail": f"DR {int(dr)} with only {int(traffic):,} monthly visits: authority without an audience"})
    return {"status": "avoid" if reasons else "pass", "reasons": reasons, "missing_metrics": []}


def quality_score(metrics: dict) -> dict:
    dr = metrics["dr"]
    traffic = metrics["monthly_traffic"]
    organic = metrics.get("organic_share")
    trend = metrics.get("traffic_trend")
    age = metrics.get("domain_age_years")
    notes = []
    dr_points = 30.0 * min(dr, 100.0) / 100.0
    if traffic <= ZERO_TRAFFIC_MAX:
        traffic_points = 0.0
    else:
        traffic_points = 30.0 * min(1.0, math.log10(traffic / ZERO_TRAFFIC_MAX) / math.log10(500_000 / ZERO_TRAFFIC_MAX))
    if organic is None:
        organic_points = 10.0
        notes.append("organic_share unknown: scored at the midpoint")
    else:
        organic_points = 20.0 * organic
    if trend is None:
        trend_points = 5.0
        notes.append("traffic_trend unknown: scored at the midpoint")
    elif trend >= 0.10:
        trend_points = 10.0
    elif trend > TRAFFIC_DECLINE_MAX:
        trend_points = 7.0
    else:
        trend_points = 3.0
    if age is None:
        age_points = 5.0
        notes.append("domain_age_years unknown: scored at the midpoint")
    elif age >= 3:
        age_points = 10.0
    elif age >= YOUNG_DOMAIN_YEARS:
        age_points = 6.0
    else:
        age_points = 2.0
    score = int(round(dr_points + traffic_points + organic_points + trend_points + age_points))
    tier = next(label for floor, label in QUALITY_TIERS if score >= floor)
    return {
        "score": score,
        "tier": tier,
        "components": {
            "authority": round(dr_points, 1),
            "traffic": round(traffic_points, 1),
            "organic_share": round(organic_points, 1),
            "trend": round(trend_points, 1),
            "domain_age": round(age_points, 1),
        },
        "notes": notes,
    }


def adjustments(metrics: dict) -> list:
    out = []
    organic = metrics.get("organic_share")
    trend = metrics.get("traffic_trend")
    age = metrics.get("domain_age_years")
    outbound = metrics.get("outbound_links_on_page")
    relevance = str(metrics.get("relevance") or "").strip().lower()
    if organic is not None and organic >= HIGH_ORGANIC_SHARE_MIN:
        out.append({"code": "high_organic_share", "factor": 1.10, "detail": f"organic share {organic:.0%}"})
    if trend is not None and trend <= TRAFFIC_DECLINE_MAX:
        out.append({"code": "traffic_decline", "factor": 0.85, "detail": f"traffic trend {trend:+.0%}"})
    if age is not None and age < YOUNG_DOMAIN_YEARS:
        out.append({"code": "young_domain", "factor": 0.90, "detail": f"domain age {age:.1f} years"})
    if outbound is not None and outbound > LINK_HEAVY_PAGE_MIN:
        out.append({"code": "link_heavy_page", "factor": 0.90, "detail": f"{int(outbound)} outbound links on the page"})
    if relevance == "high":
        out.append({"code": "relevance_high", "factor": 1.10, "detail": "topically relevant to the target site"})
    elif relevance == "low":
        out.append({"code": "relevance_low", "factor": 0.80, "detail": "off-topic for the target site"})
    return out


def quote_verdict(quote, band: dict, gate_status: str) -> dict:
    if gate_status == "avoid":
        return {"verdict": "avoid", "detail": "quality gate failed; do not buy at any price"}
    if gate_status != "pass":
        return {"verdict": "insufficient_evidence", "detail": "supply DR and monthly traffic before judging the quote"}
    if quote is None:
        return {"verdict": "no_quote", "detail": f"no quote supplied; a fair offer is about ${band['median']:,.0f}, walk away above ${band['p75']:,.0f}"}
    if quote <= band["p25"]:
        return {"verdict": "bargain", "detail": f"${quote:,.0f} is at or below the 25th percentile (${band['p25']:,.0f})"}
    if quote <= band["median"]:
        return {"verdict": "fair", "detail": f"${quote:,.0f} is at or below the market median (${band['median']:,.0f})"}
    if quote <= band["p75"]:
        return {"verdict": "negotiate", "detail": f"${quote:,.0f} is above the median (${band['median']:,.0f}); counter toward it"}
    return {"verdict": "overpriced", "detail": f"${quote:,.0f} exceeds the 75th percentile (${band['p75']:,.0f}); do not buy at this price"}


def _round_band(band: dict, factor: float) -> dict:
    return {key: round(value * factor, 2) for key, value in band.items()}


def normalize_metrics(raw: dict) -> dict:
    raw = raw or {}
    indexed = raw.get("indexed")
    if isinstance(indexed, str):
        indexed = indexed.strip().lower() not in ("false", "no", "0", "deindexed")
    return {
        "dr": _num(raw.get("dr", raw.get("da")), "dr", minimum=0, maximum=100),
        "monthly_traffic": _num(raw.get("monthly_traffic", raw.get("traffic")), "monthly_traffic", minimum=0),
        "organic_share": _share(raw.get("organic_share"), "organic_share"),
        "traffic_trend": _num(raw.get("traffic_trend"), "traffic_trend", minimum=-1.0),
        "domain_age_years": _num(raw.get("domain_age_years"), "domain_age_years", minimum=0),
        "outbound_links_on_page": _num(raw.get("outbound_links_on_page"), "outbound_links_on_page", minimum=0),
        "relevance": raw.get("relevance"),
        "indexed": indexed if isinstance(indexed, bool) else None,
    }


def _parse_date(value) -> _dt.date | None:
    if not value:
        return None
    text = str(value).strip()
    for candidate in (text[:10],):
        try:
            return _dt.date.fromisoformat(candidate)
        except ValueError:
            continue
    raise InputError(f"unparseable date: {text}")


def tranco_rank_proxy(rank) -> dict:
    """Conservative traffic and authority estimates for a Tranco rank (None = unranked)."""
    rank_value = _num(rank, "tranco_rank", minimum=1)
    if rank_value is None:
        return {"monthly_traffic": None, "dr": None, "tier": "unranked (outside the Tranco top 1M)"}
    for ceiling, traffic, dr in TRANCO_PROXY_TIERS:
        if rank_value <= ceiling:
            return {"monthly_traffic": float(traffic), "dr": float(dr), "tier": f"rank <= {ceiling:,}"}
    return {"monthly_traffic": None, "dr": None, "tier": "rank > 1,000,000"}


def tranco_trend(history) -> float | None:
    """Rank movement over the supplied history as a traffic-trend proxy (rank down = improving)."""
    rows = []
    for row in history or []:
        if not isinstance(row, dict):
            continue
        try:
            day = _parse_date(row.get("date"))
            rank_value = _num(row.get("rank"), "tranco_history.rank", minimum=1)
        except InputError:
            continue
        if day is not None and rank_value is not None:
            rows.append((day, rank_value))
    if len(rows) < 2:
        return None
    rows.sort()
    (first_day, first_rank), (last_day, last_rank) = rows[0], rows[-1]
    if (last_day - first_day).days < TRANCO_TREND_MIN_DAYS:
        return None
    change = (first_rank - last_rank) / first_rank
    return max(-TRANCO_TREND_CLAMP, min(TRANCO_TREND_CLAMP, round(change, 4)))


def apply_public_proxies(metrics: dict, proxies: dict, sources: dict, today: _dt.date | None = None) -> list:
    """Fill metrics the caller did not supply from free public signals. Returns notes."""
    notes = []
    if not isinstance(proxies, dict) or not proxies:
        return notes
    today = today or _dt.date.today()
    has_rank_signal = "tranco_rank" in proxies
    if has_rank_signal:
        proxy = tranco_rank_proxy(proxies.get("tranco_rank"))
        if metrics.get("monthly_traffic") is None and proxy["monthly_traffic"] is not None:
            metrics["monthly_traffic"] = proxy["monthly_traffic"]
            sources["monthly_traffic"] = "tranco_rank_proxy"
            notes.append(f"monthly_traffic estimated from Tranco popularity ({proxy['tier']}); confirm with SimilarWeb/Semrush before relying on it")
        if metrics.get("dr") is None and proxy["dr"] is not None:
            metrics["dr"] = proxy["dr"]
            sources["dr"] = "tranco_rank_proxy"
            notes.append("dr estimated from Tranco popularity, which measures reach, not link authority; confirm DR/DA with Ahrefs/Moz before paying above the fair price")
    if metrics.get("traffic_trend") is None and proxies.get("tranco_history"):
        trend = tranco_trend(proxies.get("tranco_history"))
        if trend is not None:
            metrics["traffic_trend"] = trend
            sources["traffic_trend"] = "tranco_history_proxy"
            notes.append(f"traffic_trend {trend:+.0%} derived from Tranco rank movement")
    if metrics.get("domain_age_years") is None and proxies.get("rdap_registration"):
        registered = _parse_date(proxies.get("rdap_registration"))
        if registered is not None:
            metrics["domain_age_years"] = round(max(0.0, (today - registered).days / 365.25), 2)
            sources["domain_age_years"] = "rdap"
    if metrics.get("indexed") is None and proxies.get("site_results") is not None:
        count = _num(proxies.get("site_results"), "site_results", minimum=0)
        if count is not None and count > 0:
            metrics["indexed"] = True
            sources["indexed"] = "site_search_proxy"
        elif count == 0:
            notes.append("indexation unknown: site search returned no results, which does not establish deindexation; verify index status independently")
    if metrics.get("organic_share") is None:
        notes.append("organic_share unavailable from public signals; the inflated-traffic veto could not be checked")
    return notes


def evaluate(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise InputError("payload must be a JSON object")
    domain = str(payload.get("domain") or payload.get("url") or "").strip()
    if not domain:
        raise InputError("domain is required")
    link_type = normalize_link_type(payload.get("link_type"))
    quote = _num(payload.get("quoted_price_usd", payload.get("quote")), "quoted_price_usd", minimum=0)
    metrics = normalize_metrics(payload.get("metrics") or payload)
    declared_sources = payload.get("sources") if isinstance(payload.get("sources"), dict) else {}
    sources = {name: str(declared_sources.get(name) or "supplied") for name, value in metrics.items() if value is not None}
    today = _parse_date(payload.get("as_of")) if payload.get("as_of") else None
    proxy_notes = apply_public_proxies(metrics, payload.get("proxies"), sources, today)
    proxied = any(source.endswith("_proxy") or source == "rdap" for source in sources.values())
    gate = quality_gate(metrics)
    notes = [
        "Authority and traffic figures are inputs, not measurements made here; label them by their source (Ahrefs/Semrush/Moz/SimilarWeb/Search Console) or as Estimated.",
    ] + proxy_notes
    if link_type == "nofollow":
        notes.append("Nofollow passes no authority; its value is referral traffic and trust signals only.")
    result = {
        "domain": domain,
        "link_type": link_type,
        "type_multiplier": LINK_TYPES[link_type],
        "metrics": metrics,
        "metric_sources": sources,
        "gate": gate,
        "quality": None,
        "market": None,
        "adjustments": [],
        "value_band_usd": None,
        "quoted_price_usd": quote,
        "quote": quote_verdict(quote, {"p25": 0, "median": 0, "p75": 0}, gate["status"]),
        "data_tier": "insufficient_evidence" if gate["status"] == "insufficient_evidence" else None,
        "notes": notes,
    }
    if gate["status"] == "insufficient_evidence":
        result["notes"].append("Missing " + ", ".join(gate["missing_metrics"]) + ": ask for the site's DR/DA and monthly traffic before valuing the link.")
        return result

    quality = quality_score(metrics)
    market = market_band(metrics["dr"], metrics["monthly_traffic"], payload.get("market_prices"))
    adjust = adjustments(metrics)
    factor = LINK_TYPES[link_type]
    for item in adjust:
        factor *= item["factor"]
    band = _round_band(market["guest_post_band_usd"], factor)
    if gate["status"] == "avoid":
        quality["tier"] = "avoid"
    result.update({
        "quality": quality,
        "market": market,
        "adjustments": adjust,
        "value_band_usd": band,
        "quote": quote_verdict(quote, band, gate["status"]),
        "data_tier": "public_proxy" if proxied else market["data_tier"],
    })
    if proxied:
        result["notes"].append("Core metrics came from free public proxies: the band is Estimated; treat the median as a ceiling until DR and traffic are confirmed.")
    if gate["status"] == "avoid":
        result["notes"].append("Gate failed: the band is shown for reference only; the recommendation is to avoid this link.")
    return result


def rank(payload: dict) -> dict:
    candidates = payload.get("candidates") if isinstance(payload, dict) else None
    if not isinstance(candidates, list) or not candidates:
        raise InputError("candidates must be a non-empty list")
    shared_prices = payload.get("market_prices") if isinstance(payload, dict) else None
    rows = []
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            raise InputError(f"candidates[{index}] must be an object")
        merged = dict(candidate)
        if shared_prices and "market_prices" not in merged:
            merged["market_prices"] = shared_prices
        rows.append(evaluate(merged))

    def sort_key(row):
        gate_rank = {"pass": 0, "insufficient_evidence": 1, "avoid": 2}[row["gate"]["status"]]
        score = row["quality"]["score"] if row["quality"] else -1
        price = row["quoted_price_usd"]
        if price is None and row["value_band_usd"]:
            price = row["value_band_usd"]["median"]
        value_per_dollar = (score / price) if (price and score >= 0) else 0.0
        return (gate_rank, -value_per_dollar, -score)

    ordered = sorted(rows, key=sort_key)
    for position, row in enumerate(ordered, start=1):
        row["rank"] = position
    return {
        "candidates": ordered,
        "buy": [row["domain"] for row in ordered if row["gate"]["status"] == "pass" and row["quote"]["verdict"] in ("bargain", "fair", "no_quote")],
        "negotiate": [row["domain"] for row in ordered if row["quote"]["verdict"] == "negotiate"],
        "avoid": [row["domain"] for row in ordered if row["gate"]["status"] == "avoid" or row["quote"]["verdict"] == "overpriced"],
        "needs_metrics": [row["domain"] for row in ordered if row["gate"]["status"] == "insufficient_evidence"],
    }


def _load(path):
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Value a backlink offer from supplied metrics.")
    parser.add_argument("--op", choices=("evaluate", "rank"), default="evaluate")
    parser.add_argument("--input", default="-", help="JSON payload path, or - for stdin")
    args = parser.parse_args(argv)
    try:
        payload = _load(args.input)
        data = evaluate(payload) if args.op == "evaluate" else rank(payload)
        print(json.dumps({"ok": True, "op": args.op, "data": data}, ensure_ascii=False))
        return 0
    except (InputError, json.JSONDecodeError, OSError) as err:
        print(json.dumps({"ok": False, "op": args.op, "error": str(err)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
