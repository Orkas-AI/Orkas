import json
import sys
from typing import Dict, List, Any


BENCHMARKS = {
    "facebook": {"engagement_rate": 0.09, "ctr": 0.90},
    "instagram": {"engagement_rate": 1.22, "ctr": 0.22},
    "twitter": {"engagement_rate": 0.045, "ctr": 1.64},
    "x": {"engagement_rate": 0.045, "ctr": 1.64},
    "linkedin": {"engagement_rate": 0.54, "ctr": 0.39},
    "tiktok": {"engagement_rate": 5.96, "ctr": 1.00},
}


def safe_divide(numerator: float, denominator: float, default: float = 0.0) -> float:
    return default if denominator == 0 else numerator / denominator


def calculate_metrics(data: Dict[str, Any]) -> Dict[str, Any]:
    posts = data.get("posts", [])
    total_likes = sum(p.get("likes", 0) or 0 for p in posts)
    total_comments = sum(p.get("comments", 0) or 0 for p in posts)
    total_shares = sum(p.get("shares", 0) or 0 for p in posts)
    total_saves = sum(p.get("saves", 0) or 0 for p in posts)
    total_reach = sum(p.get("reach", 0) or 0 for p in posts)
    total_impressions = sum(p.get("impressions", 0) or 0 for p in posts)
    total_clicks = sum(p.get("clicks", 0) or 0 for p in posts)
    total_engagements = total_likes + total_comments + total_shares + total_saves
    campaign_metrics = {
        "platform": data.get("platform", "unknown"),
        "total_posts": len(posts),
        "total_engagements": total_engagements,
        "total_reach": total_reach,
        "total_impressions": total_impressions,
        "total_clicks": total_clicks,
        "avg_engagement_rate": round(safe_divide(total_engagements, total_reach) * 100, 2),
        "ctr": round(safe_divide(total_clicks, total_impressions) * 100, 2),
    }
    spend = data.get("total_spend", 0) or 0
    total_value = total_engagements * 2.5
    roi_metrics = {
        "total_spend": round(float(spend), 2),
        "cost_per_engagement": round(safe_divide(spend, total_engagements), 2),
        "cost_per_click": round(safe_divide(spend, total_clicks), 2),
        "estimated_value": round(total_value, 2),
        "roi_percentage": round(safe_divide(total_value - spend, spend) * 100, 2),
    }
    return {"campaign_metrics": campaign_metrics, "roi_metrics": roi_metrics}


def benchmark_performance(campaign_metrics: Dict[str, Any]) -> Dict[str, str]:
    platform = str(campaign_metrics.get("platform", "unknown")).lower()
    benchmarks = BENCHMARKS.get(platform, {})
    if not benchmarks:
        return {"status": "no_benchmark_available"}
    engagement_rate = campaign_metrics.get("avg_engagement_rate", 0) or 0
    ctr = campaign_metrics.get("ctr", 0) or 0
    be = benchmarks["engagement_rate"]
    bc = benchmarks["ctr"]
    return {
        "engagement_status": "excellent" if engagement_rate >= be * 1.5 else "good" if engagement_rate >= be else "below_average",
        "engagement_benchmark": f"{be}%",
        "engagement_actual": f"{engagement_rate:.2f}%",
        "ctr_status": "excellent" if ctr >= bc * 1.5 else "good" if ctr >= bc else "below_average",
        "ctr_benchmark": f"{bc}%",
        "ctr_actual": f"{ctr:.2f}%",
    }


def recommendations(campaign_metrics: Dict[str, Any], roi_metrics: Dict[str, Any]) -> List[str]:
    recs = []
    engagement_rate = campaign_metrics.get("avg_engagement_rate", 0) or 0
    ctr = campaign_metrics.get("ctr", 0) or 0
    cpc = roi_metrics.get("cost_per_click", 0) or 0
    roi = roi_metrics.get("roi_percentage", 0) or 0
    if engagement_rate < 1.0:
        recs.append("参与率偏低：测试更强钩子、互动提问、视觉质量和发布时间。")
    if ctr < 0.5:
        recs.append("CTR 偏低：优化标题、CTA 和内容与受众需求的匹配度。")
    if cpc > 1.0:
        recs.append(f"CPC 偏高（{cpc:.2f}）：建议优化受众、素材和出价策略。")
    if roi < 100:
        recs.append(f"ROI 偏低（{roi:.1f}%）：建议复盘转化路径、降低成本或调整目标人群。")
    elif roi > 200:
        recs.append(f"ROI 较好（{roi:.1f}%）：可小幅放大预算并复制高表现内容元素。")
    if (campaign_metrics.get("total_posts", 0) or 0) < 10:
        recs.append("样本量较小：建议增加数据量后再做强结论。")
    return recs or ["当前指标整体可接受，建议继续做小幅 A/B 测试。"]


def validate(data: Dict[str, Any]) -> List[str]:
    errors = []
    posts = data.get("posts", [])
    if not isinstance(posts, list) or not posts:
        errors.append("posts must be a non-empty array")
    for i, post in enumerate(posts):
        if (post.get("reach", 0) or 0) <= 0:
            errors.append(f"posts[{i}].reach must be > 0")
    return errors


def main(argv: List[str]) -> Dict[str, Any]:
    if not argv:
        return {"ok": False, "error": "missing input json path", "details": {}}
    with open(argv[0], "r", encoding="utf-8") as f:
        data = json.load(f)
    errors = validate(data)
    if errors:
        return {"ok": False, "error": "invalid input", "details": {"errors": errors}}
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
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)