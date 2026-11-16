"""Shared, offline calculations for the two social-analysis entrypoints."""

import json
import math
from itertools import chain


ENGAGEMENT_FIELDS = ("likes", "comments", "shares", "saves")
POST_FIELDS = (*ENGAGEMENT_FIELDS, "reach", "impressions", "clicks", "conversions",
               "spend", "revenue", "non_marketing_costs")
CAMPAIGN_FIELDS = ("total_spend", "revenue", "non_marketing_costs",
                   "conversion_value", "value_per_engagement")


def is_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def validate(data):
    if not isinstance(data, dict):
        return ["input must be an object"]
    errors = []
    posts = data.get("posts")
    if not isinstance(posts, list) or not posts:
        return ["posts must be a non-empty array"]
    records = chain([("campaign", data, CAMPAIGN_FIELDS)],
                    ((f"posts[{i}]", row, POST_FIELDS) for i, row in enumerate(posts)))
    for label, record, fields in records:
        if not isinstance(record, dict):
            errors.append(f"{label} must be an object")
            continue
        for field in fields:
            value = record.get(field)
            if value is not None and (not is_number(value) or value < 0):
                errors.append(f"{label}.{field} must be a finite non-negative number")
    return errors


def input_error(errors):
    return {"ok": False, "error": "invalid input", "details": {"errors": errors}}


def finite_json_number(text):
    value = float(text)
    if not is_number(value):
        raise ValueError("non-finite JSON number")
    return value


def load_input(argv):
    if not argv:
        raise ValueError("missing input JSON path")
    try:
        with open(argv[0], encoding="utf-8") as source:
            return json.load(source, parse_float=finite_json_number, parse_constant=finite_json_number)
    except (OSError, ValueError):
        raise ValueError("unable to read input JSON") from None


def total(posts, fields):
    # An incomplete export cannot establish a complete numerator or denominator.
    result = 0
    for row in posts:
        for field in fields:
            value = row.get(field)
            if value is None:
                return None
            result += value
    return result if is_number(result) else None


def safe_divide(numerator, denominator, default=None):
    if numerator is None or denominator is None or denominator == 0:
        return default
    result = numerator / denominator
    return result if is_number(result) else default


def ratio(name, numerator, denominator, inputs, reasons, multiplier=1):
    missing = [field for field, value in inputs.items() if value is None]
    if missing:
        reasons[name] = "missing: " + ", ".join(missing)
        return None
    if denominator == 0:
        reasons[name] = "zero denominator: " + list(inputs)[-1]
        return None
    value = safe_divide(numerator, denominator)
    value = value * multiplier if value is not None else None
    if not is_number(value):
        reasons[name] = "result is outside the finite numeric range"
        return None
    return round(value, 2)


def calculate_campaign_metrics(posts, platform="unknown"):
    engagements = total(posts, ENGAGEMENT_FIELDS)
    reach = total(posts, ("reach",))
    impressions = total(posts, ("impressions",))
    clicks = total(posts, ("clicks",))
    reasons = {}
    return {
        "platform": platform,
        "total_posts": len(posts),
        "total_engagements": engagements,
        "total_reach": reach,
        "total_impressions": impressions,
        "total_clicks": clicks,
        "avg_engagement_rate": ratio("avg_engagement_rate", engagements, reach,
                                     {"engagements": engagements, "reach": reach}, reasons, 100),
        "ctr": ratio("ctr", clicks, impressions,
                     {"clicks": clicks, "impressions": impressions}, reasons, 100),
        "unavailable_reasons": reasons,
    }


def money_source(data, field, post_field):
    # An explicit campaign total wins, including zero. Never add it to its rows.
    if field in data:
        return data[field]
    return total(data["posts"], (post_field,))


def calculate_metrics(data):
    campaign = calculate_campaign_metrics(data["posts"], data.get("platform", "unknown"))
    spend = money_source(data, "total_spend", "spend")
    revenue = money_source(data, "revenue", "revenue")
    costs = money_source(data, "non_marketing_costs", "non_marketing_costs")
    conversion_value = data.get("conversion_value")
    unit_value = data.get("value_per_engagement")
    engagements = campaign["total_engagements"]
    clicks = campaign["total_clicks"]
    estimated = engagements * unit_value if engagements is not None and unit_value is not None else None
    if estimated is not None and not is_number(estimated):
        estimated = None
    reasons = {}
    profit = revenue - costs - spend if all(value is not None for value in (revenue, costs, spend)) else None
    roi = ratio("roi_percentage", profit, spend,
                {"revenue": revenue, "non_marketing_costs": costs, "total_spend": spend}, reasons, 100)
    return {
        "campaign_metrics": campaign,
        "roi_metrics": {
            "total_spend": spend,
            "revenue": revenue,
            "non_marketing_costs": costs,
            "conversion_value": conversion_value,
            "conversion_value_basis": "user_declared_conversion_value" if conversion_value is not None else None,
            "cost_per_engagement": ratio("cost_per_engagement", spend, engagements,
                                         {"total_spend": spend, "engagements": engagements}, reasons),
            "cost_per_click": ratio("cost_per_click", spend, clicks,
                                    {"total_spend": spend, "clicks": clicks}, reasons),
            "roas": ratio("roas", revenue, spend,
                          {"revenue": revenue, "total_spend": spend}, reasons),
            "roi_percentage": roi,
            "roi_basis": "revenue_less_non_marketing_costs" if roi is not None else None,
            "conversion_value_return_percentage": ratio(
                "conversion_value_return_percentage",
                conversion_value - spend if conversion_value is not None and spend is not None else None,
                spend, {"conversion_value": conversion_value, "total_spend": spend}, reasons, 100),
            "estimated_value": estimated,
            "estimated_roi_percentage": ratio(
                "estimated_roi_percentage", estimated - spend if estimated is not None and spend is not None else None,
                spend, {"estimated_value": estimated, "total_spend": spend}, reasons, 100),
            "estimate_basis": "user_supplied_value_per_engagement" if unit_value is not None else None,
            "unavailable_reasons": reasons,
        },
    }


def engagement_rate(post):
    value = safe_divide(total([post], ENGAGEMENT_FIELDS), post.get("reach"))
    return round(value * 100, 2) if value is not None and is_number(value * 100) else None
