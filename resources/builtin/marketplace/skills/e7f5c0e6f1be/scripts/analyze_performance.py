import json
import sys
from typing import Dict, List, Any

from social_metrics_core import calculate_metrics, input_error, load_input, validate


BENCHMARKS = {
    "facebook": {"engagement_rate": 0.09, "ctr": 0.90},
    "instagram": {"engagement_rate": 1.22, "ctr": 0.22},
    "twitter": {"engagement_rate": 0.045, "ctr": 1.64},
    "x": {"engagement_rate": 0.045, "ctr": 1.64},
    "linkedin": {"engagement_rate": 0.54, "ctr": 0.39},
    "tiktok": {"engagement_rate": 5.96, "ctr": 1.00},
}


def benchmark_performance(campaign_metrics: Dict[str, Any]) -> Dict[str, str]:
    platform = str(campaign_metrics.get("platform", "unknown")).lower()
    benchmarks = BENCHMARKS.get(platform, {})
    if not benchmarks:
        return {"status": "no_benchmark_available"}
    engagement_rate = campaign_metrics.get("avg_engagement_rate")
    ctr = campaign_metrics.get("ctr")
    be = benchmarks["engagement_rate"]
    bc = benchmarks["ctr"]
    result = {"reference_status": "generic_unverified"}
    if engagement_rate is not None:
        result.update({
            "engagement_status": "excellent" if engagement_rate >= be * 1.5 else "good" if engagement_rate >= be else "below_average",
            "engagement_benchmark": f"{be}%",
            "engagement_actual": f"{engagement_rate:.2f}%",
        })
    if ctr is not None:
        result.update({
            "ctr_status": "excellent" if ctr >= bc * 1.5 else "good" if ctr >= bc else "below_average",
            "ctr_benchmark": f"{bc}%",
            "ctr_actual": f"{ctr:.2f}%",
        })
    return result


def recommendations(campaign_metrics: Dict[str, Any], roi_metrics: Dict[str, Any]) -> List[str]:
    recs = []
    engagement_rate = campaign_metrics.get("avg_engagement_rate")
    ctr = campaign_metrics.get("ctr")
    cpc = roi_metrics.get("cost_per_click")
    if engagement_rate is not None and engagement_rate < 1.0:
        recs.append("Low engagement: test the hook, interaction prompt, visual or posting time.")
    if ctr is not None and ctr < 0.5:
        recs.append("Low CTR: review the headline, CTA and audience match.")
    if cpc is not None and cpc > 1.0:
        recs.append(f"Cost per click is {cpc:.2f}; compare targeting, creative and bidding with comparable history.")
    if campaign_metrics["total_posts"] < 10:
        recs.append("Small sample: collect more evidence before drawing strong conclusions.")
    # Return calculations do not establish incremental lift or a scaling decision.
    return recs


def main(argv: List[str]) -> Dict[str, Any]:
    try:
        data = load_input(argv)
    except ValueError as error:
        return input_error([str(error)])
    errors = validate(data)
    if errors:
        return input_error(errors)
    metrics = calculate_metrics(data)
    campaign_metrics = metrics["campaign_metrics"]
    roi_metrics = metrics["roi_metrics"]
    return {
        "ok": True,
        "campaign_metrics": campaign_metrics,
        "roi_metrics": roi_metrics,
        "benchmark_comparison": benchmark_performance(campaign_metrics),
        "recommendations": recommendations(campaign_metrics, roi_metrics),
    }


if __name__ == "__main__":
    result = main(sys.argv[1:])
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    sys.exit(0 if result.get("ok") else 1)