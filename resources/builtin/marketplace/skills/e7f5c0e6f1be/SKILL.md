---
name: social-data
description_zh: "采集和分析社媒数据：抓取小红书、X/Twitter、Reddit、YouTube、Bilibili 的公开帖子，或分析用户提供的社媒/活动数据，计算参与率、CTR、ROI、成本指标、Top/Bottom 内容和下一轮实验建议；适合\"抓一下 Reddit 上的口碑\"\"分析这批小红书讨论\"\"算一下这次活动 ROI\"；触发词：社媒数据、舆情、口碑、热度、公开帖子、社媒分析、参与率、CTR、ROI、campaign performance"
description_en: "Fetch and analyze social media data: collect public posts from Xiaohongshu, X/Twitter, Reddit, YouTube, and Bilibili, or analyze user-provided social/campaign data to calculate engagement rate, CTR, ROI, cost metrics, top/bottom content, and next experiment recommendations; For: \"fetch Reddit reputation\", \"analyze these Xiaohongshu discussions\", \"calculate campaign ROI\"; Triggers: social data, sentiment, reputation, buzz, public posts, social analytics, engagement rate, CTR, ROI, campaign performance"
description: "Fetch public social posts and analyze social/campaign metrics. Use this skill whenever the user asks to collect public social discussion, analyze social sentiment inputs, calculate engagement/CTR/ROI, compare platforms/content, or turn social samples into traceable findings."
category: "data"
---

# Social Data

Use this skill for two related jobs:

- `fetch`: collect public social posts from a specified platform and return structured, deduplicated items.
- `analyze`: calculate and interpret metrics from user-provided social posts, campaign exports, or fetched social samples.

Keep the two steps distinct. Fetching returns evidence samples; analysis turns user-provided or fetched data into metrics and recommendations.

## When To Use

- The user asks what people are saying about a brand, product, competitor, topic, or pain point on Xiaohongshu, X/Twitter, Reddit, YouTube, or Bilibili.
- The user provides social post/campaign data and asks for engagement rate, CTR, ROI, ROAS, CPC, CPE, CPM, CPA, top/bottom posts, platform comparison, or content recommendations.
- The user wants social evidence for reputation, buzz, user complaints, market feedback, campaign performance, or next content experiments.

Do not use for:

- Private messages, login-gated content, paid API bypassing, scraping restricted pages, or non-public data.
- Claiming that zero fetched results means no discussion exists.
- Treating benchmark comparisons as facts without user-provided or current benchmark context.
- Replacing platform analytics exports when the user needs complete official reporting.

## How To Call

1. Choose the mode:
   - `fetch`: user needs public posts or discussion samples.
   - `analyze`: user already has post/campaign data or wants metrics/recommendations from fetched samples.
   - `fetch_then_analyze`: user asks for a topic analysis and no data is provided.

2. For fetch mode:
   - Follow `references/fetching.md`.
   - One platform per script call: `xhs`, `twitter`, `reddit`, `youtube`, or `bilibili`.
   - Expand the user's topic into 3-8 short divergent keyword groups unless the user explicitly restricts keywords.
   - Report `diag.status`, failures, empty results, and platform dependency limits.
   - Browser cookies are off by default. Before adding `--use-browser-cookies` for Reddit or Bilibili, explicitly ask the user for permission and disclose that the script will inspect installed browser cookie stores for that platform domain. Continue anonymously when permission is absent or declined.

3. For analysis mode:
   - Follow `references/metrics.md`.
   - Validate fields before calculating.
   - Label evidence as direct calculation, limited inference, or assumption.
   - Separate organic and paid performance when possible.

4. Use scripts only when useful:
   - Fetch public samples (anonymous by default):
     `$ORKAS_NODE $ORKAS_PC_DIR/bin/run-skill.cjs social-data fetch -- <platform> <keywords> [options]`
   - Calculate metrics from JSON:
     `$ORKAS_NODE $ORKAS_PC_DIR/bin/run-skill.cjs social-data calculate_metrics -- data.json`
   - Analyze performance from JSON:
     `$ORKAS_NODE $ORKAS_PC_DIR/bin/run-skill.cjs social-data analyze_performance -- data.json`

5. Return traceable conclusions.
   - Tie claims back to item URLs, post IDs, comments, or user-provided rows.
   - Include data quality warnings and next tests.
   - Do not synthesize sample posts when fetch fails.

## Default Output

For fetched discussion:

```markdown
# Social Data Fetch Result

## Scope
- Platform:
- Topic:
- Keywords:
- Status:

## Sample Summary
- Items:
- Top repeated themes:
- Notable examples:

## Diagnostics
- Raw hits:
- Deduplicated:
- Failed:
- Limits:

## Next Analysis
- ...
```

For performance analysis:

```markdown
# Social Performance Analysis

## Bottom Line

## Data Quality
- Sample size:
- Missing fields:
- Abnormal values:
- Confidence:

## Key Metrics
| Metric | Value | Meaning | Evidence |
|---|---:|---|---|

## Top / Bottom Content
| Rank | Post | Platform | Format | Metric | Possible reason |
|---|---|---|---|---:|---|

## ROI And Cost
- Spend:
- Revenue / value:
- ROI:
- ROAS:
- CPC / CPE / CPA:

## Recommendations
1. ...
```

## External Dependencies

- Python 3 for bundled scripts.
- Fetch mode may need `requests`, `browser_cookie3`, `curl_cffi`, `xreach`, `yt-dlp`, or a local Xiaohongshu proxy depending on platform.
- Analysis mode needs user-provided JSON, table data, or exported platform/campaign metrics.

## Limits And Known Issues

- Fetch coverage varies by platform, login state, rate limits, anti-bot behavior, and local dependencies.
- Public fetches are samples, not complete platform analytics.
- Anonymous Reddit/Bilibili recall can be weak; browser login cookies may improve results only after explicit user permission and the `--use-browser-cookies` flag.
- Xiaohongshu requires an external local proxy service at `http://localhost:18060`.
- ROI estimates based on engagement value are assumptions unless the user provides real revenue, conversion value, or lead value.
- Benchmark values can become stale and should be treated as rough context, not a pass/fail truth.
