import sys

from social_metrics_core import (
    calculate_campaign_metrics, calculate_metrics, engagement_rate,
    input_error, is_number, load_input, safe_divide, validate,
)


class SocialMediaMetricsCalculator:
    def __init__(self, campaign_data):
        self.data = campaign_data
        data = campaign_data if isinstance(campaign_data, dict) else {}
        self.platform = data.get("platform", "unknown")
        self.posts = data.get("posts", [])
        self.total_spend = data.get("total_spend")

    safe_divide = staticmethod(safe_divide)
    calculate_engagement_rate = staticmethod(engagement_rate)

    def calculate_ctr(self, clicks, impressions):
        value = safe_divide(clicks, impressions)
        return round(value * 100, 2) if value is not None and is_number(value * 100) else None

    def validate(self):
        return validate(self.data)

    def calculate_campaign_metrics(self):
        return calculate_campaign_metrics(self.posts, self.platform)

    def calculate_roi_metrics(self):
        return calculate_metrics(self.data)["roi_metrics"]

    def identify_top_posts(self, metric="engagement_rate", limit=5):
        posts = [dict(post, engagement_rate=engagement_rate(post)) for post in self.posts]
        ranked = [post for post in posts if is_number(post.get(metric))]
        return sorted(ranked, key=lambda post: post[metric], reverse=True)[:limit]

    def analyze_all(self):
        errors = self.validate()
        if errors:
            return input_error(errors)
        return {"ok": True, **calculate_metrics(self.data), "top_posts": self.identify_top_posts()}


def load_json(path):
    return load_input([path])


def main(argv):
    try:
        data = load_input(argv)
    except ValueError as error:
        return input_error([str(error)])
    return SocialMediaMetricsCalculator(data).analyze_all()


if __name__ == "__main__":
    import json

    result = main(sys.argv[1:])
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    sys.exit(0 if result.get("ok") else 1)
