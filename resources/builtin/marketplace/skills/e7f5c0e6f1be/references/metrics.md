# Social Metrics And Performance Analysis

Use analysis mode when the user provides social post data, campaign exports, ad metrics, or fetched samples that need calculation and interpretation.

## Recommended Input Fields

```json
{
  "platform": "instagram",
  "campaign_name": "launch_week",
  "total_spend": 500,
  "revenue": 1200,
  "non_marketing_costs": 700,
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
- Supplied counters and monetary fields must be finite, non-negative JSON numbers, not booleans or numeric strings. Missing or `null` fields remain unavailable; explicitly supply zero only for a known zero or an inapplicable counter.
- A positive reach is required for reach-based engagement rate; positive impressions are required for CTR and CPM. Missing or zero denominators make only the affected metric unavailable, without blocking other supported calculations.
- Dates should be parseable when time comparison is requested.
- If `reach > impressions`, `clicks > impressions`, or conversions exceed clicks, flag the data risk.
- For monetary comparisons, establish matching campaign/attribution window, currency and cost scope before preparing the input. Scripts calculate supplied records; they do not verify attribution or exchange rates.

## Monetary Sources And Return Bases

Campaign-level `total_spend`, `revenue` and `non_marketing_costs` take precedence, including explicit zero or `null`. If a field is absent, the scripts sum its post-level counterpart (`spend`, `revenue`, `non_marketing_costs`) only when every included post supplies it. Never add campaign totals to the same underlying post rows or treat a partial export as a complete total.

- `revenue` is the attributed sales amount on the declared basis. Revenue and positive spend support ROAS, not profit ROI by themselves.
- `non_marketing_costs` is the total cost attributable to that same revenue, excluding `total_spend`. Include applicable goods, fulfillment, fees and other costs in the stated scope once. An explicit zero is a supplied cost assumption; an omitted cost is unknown. The result is ROI on the declared cost scope, not automatically net company profit or incremental campaign lift.
- `conversion_value` is a separately declared value. Its `conversion_value_return_percentage` uses that value and spend; `conversion_value_basis` identifies it as user-declared. Do not silently use it as observed revenue or profit.
- Only an explicit `value_per_engagement` enables the optional interaction-value scenario. `estimated_value` and `estimated_roi_percentage` stay separate from measured-return fields and carry `estimate_basis: "user_supplied_value_per_engagement"`. No default unit value is supplied.

The two commands share the same calculations. Existing `campaign_metrics` and `roi_metrics` containers remain, but unavailable numeric results now return JSON `null` with `unavailable_reasons`; downstream prose must preserve those states. `roi_basis` identifies a computable profit-return basis. Missing values and zero spend must not become 0% ROI, infinite return or a recommendation to increase a budget. The performance command does not grade ROI or generate budget-scaling advice from a return ratio.

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
- ROI on declared costs = (revenue - non-marketing costs - spend) / spend * 100; requires all three inputs and positive spend.
- ROAS = revenue / spend.
- Declared conversion-value return = (conversion value - spend) / spend * 100; not automatically profit ROI.
- Explicit interaction-value estimate = engagements × user-supplied value per engagement. Its estimated return = (estimated value - spend) / spend * 100; always a scenario.

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
