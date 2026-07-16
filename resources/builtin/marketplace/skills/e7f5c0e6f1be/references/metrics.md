# Social Metrics And Performance Analysis

Use analysis mode when the user provides social post data, campaign exports, ad metrics, or fetched samples that need calculation and interpretation.

## Recommended Input Fields

```json
{
  "platform": "instagram",
  "campaign_name": "launch_week",
  "total_spend": 500,
  "revenue": 1200,
  "conversion_value": 1200,
  "posts": [
    {
      "post_id": "post_001",
      "date": "2026-05-01",
      "platform": "instagram",
      "format": "carousel",
      "pillar": "education",
      "likes": 342,
      "comments": 28,
      "shares": 15,
      "saves": 45,
      "reach": 5200,
      "impressions": 8500,
      "clicks": 120,
      "spend": 100,
      "conversions": 8,
      "revenue": 300
    }
  ]
}
```

## Validation

- `posts` must be a non-empty array for script-based calculations.
- `reach > 0` is required for reach-based engagement rate.
- `impressions > 0` is required for CTR and CPM.
- Interactions, clicks, spend, conversions, and revenue must not be negative.
- Dates should be parseable when time comparison is requested.
- If `reach > impressions`, `clicks > impressions`, or conversions exceed clicks, flag the data risk.
- If ROI is requested without spend or value, state the missing field or assumption.

## Core Formulas

- Total engagements = likes + comments + shares + saves.
- Engagement rate by reach = total engagements / reach * 100.
- Engagement rate by impressions = total engagements / impressions * 100.
- CTR = clicks / impressions * 100.
- Save rate = saves / reach * 100.
- Share rate = shares / reach * 100.
- Comment rate = comments / reach * 100.
- CPC = spend / clicks.
- CPE = spend / total engagements.
- CPM = spend / impressions * 1000.
- CPA = spend / conversions.
- ROI = (value - spend) / spend * 100.
- ROAS = revenue / spend.

## Script Commands

Calculate core campaign metrics:

```bash
$ORKAS_NODE $ORKAS_PC_DIR/bin/run-skill.cjs social-data calculate_metrics -- data.json
```

Analyze metrics, benchmark comparison, and recommendations:

```bash
$ORKAS_NODE $ORKAS_PC_DIR/bin/run-skill.cjs social-data analyze_performance -- data.json
```

## Interpretation

- Use user-provided historical or industry benchmark data first.
- If using generic benchmark values from a script, label them as rough and possibly stale.
- Separate paid and organic performance when fields allow it.
- Rank Top/Bottom content by the user's goal:
  - Awareness: reach, impressions, share rate.
  - Engagement: engagement rate, comments, saves.
  - Traffic: CTR, clicks, CPC.
  - Conversion: CPA, ROI, ROAS.
- Distinguish evidence levels:
  - Direct calculation: computed from user data.
  - Limited inference: supported by data but sample is small or fields are missing.
  - Assumption: depends on benchmark, estimated value, or incomplete attribution.

## Recommendations

Tie recommendations to evidence:

- What to scale or repeat.
- What to stop or revise.
- Which variable to test next: hook, format, cover, CTA, posting time, audience, keyword, creator, or platform.
- What data to collect next if confidence is low.
