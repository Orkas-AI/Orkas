import json
import sys
from typing import Dict, List, Any


class SocialMediaMetricsCalculator:
    def __init__(self, campaign_data: Dict[str, Any]):
        self.platform = campaign_data.get("platform", "unknown")
        self.posts = campaign_data.get("posts", [])
        self.total_spend = campaign_data.get("total_spend", 0) or 0

    def safe_divide(self, numerator: float, denominator: float, default: float = 0.0) -> float:
        return default if denominator == 0 else numerator / denominator

    def calculate_engagement_rate(self, post: Dict[str, Any]) -> float:
        likes = post.get("likes", 0) or 0
        comments = post.get("comments", 0) or 0
        shares = post.get("shares", 0) or 0
        saves = post.get("saves", 0) or 0
        reach = post.get("reach", 0) or 0
        return round(self.safe_divide(likes + comments + shares + saves, reach) * 100, 2)

    def calculate_ctr(self, clicks: int, impressions: int) -> float:
        return round(self.safe_divide(clicks or 0, impressions or 0) * 100, 2)

    def validate(self) -> List[str]:
        errors = []
        if not isinstance(self.posts, list) or not self.posts:
            errors.append("posts must be a non-empty array")
        for i, post in enumerate(self.posts):
            if (post.get("reach", 0) or 0) <= 0:
                errors.append(f"posts[{i}].reach must be > 0")
            for field in ["likes", "comments", "shares", "saves", "clicks", "impressions"]:
                if (post.get(field, 0) or 0) < 0:
                    errors.append(f"posts[{i}].{field} must be non-negative")
        if self.total_spend < 0:
            errors.append("total_spend must be non-negative")
        return errors

    def calculate_campaign_metrics(self) -> Dict[str, Any]:
        total_likes = sum(post.get("likes", 0) or 0 for post in self.posts)
        total_comments = sum(post.get("comments", 0) or 0 for post in self.posts)
        total_shares = sum(post.get("shares", 0) or 0 for post in self.posts)
        total_saves = sum(post.get("saves", 0) or 0 for post in self.posts)
        total_reach = sum(post.get("reach", 0) or 0 for post in self.posts)
        total_impressions = sum(post.get("impressions", 0) or 0 for post in self.posts)
        total_clicks = sum(post.get("clicks", 0) or 0 for post in self.posts)
        total_engagements = total_likes + total_comments + total_shares + total_saves
        return {
            "platform": self.platform,
            "total_posts": len(self.posts),
            "total_engagements": total_engagements,
            "total_reach": total_reach,
            "total_impressions": total_impressions,
            "total_clicks": total_clicks,
            "avg_engagement_rate": round(self.safe_divide(total_engagements, total_reach) * 100, 2),
            "ctr": self.calculate_ctr(total_clicks, total_impressions),
        }

    def calculate_roi_metrics(self) -> Dict[str, float]:
        metrics = self.calculate_campaign_metrics()
        total_engagements = metrics["total_engagements"]
        total_clicks = metrics["total_clicks"]
        avg_value_per_engagement = 2.50
        total_value = total_engagements * avg_value_per_engagement
        return {
            "total_spend": round(float(self.total_spend), 2),
            "cost_per_engagement": round(self.safe_divide(self.total_spend, total_engagements), 2),
            "cost_per_click": round(self.safe_divide(self.total_spend, total_clicks), 2),
            "estimated_value": round(total_value, 2),
            "roi_percentage": round(self.safe_divide(total_value - self.total_spend, self.total_spend) * 100, 2),
        }

    def identify_top_posts(self, metric: str = "engagement_rate", limit: int = 5) -> List[Dict[str, Any]]:
        posts_with_metrics = []
        for post in self.posts:
            item = dict(post)
            item["engagement_rate"] = self.calculate_engagement_rate(post)
            posts_with_metrics.append(item)
        return sorted(posts_with_metrics, key=lambda x: x.get(metric, 0) or 0, reverse=True)[:limit]

    def analyze_all(self) -> Dict[str, Any]:
        errors = self.validate()
        if errors:
            return {"ok": False, "error": "invalid input", "details": {"errors": errors}}
        return {
            "ok": True,
            "campaign_metrics": self.calculate_campaign_metrics(),
            "roi_metrics": self.calculate_roi_metrics(),
            "top_posts": self.identify_top_posts(),
        }


def load_json(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main(argv: List[str]) -> Dict[str, Any]:
    if not argv:
        return {"ok": False, "error": "missing input json path", "details": {}}
    return SocialMediaMetricsCalculator(load_json(argv[0])).analyze_all()


if __name__ == "__main__":
    result = main(sys.argv[1:])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)