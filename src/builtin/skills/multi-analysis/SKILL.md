---
name: multi-analysis
description_zh: "对给定主题做多维度深度研究，产出结构化分析报告——覆盖现状 / 趋势 / 竞争 / 风险 / SWOT 等维度，结论前置 + 表格可视化突出。适合\"分析下 X 行业的趋势\"\"做个 Y 产品的竞品分析\"\"评估下 Z 项目的机会和风险\"；触发词：分析、研究、行业报告、竞品分析、趋势预测、SWOT、风险评估、市场调研"
description_en: "Conduct multi-dimensional in-depth research on a given topic and produce a structured analysis report covering current state / trends / competition / risk / SWOT and other dimensions, with conclusions stated upfront and tables / visualizations highlighted. Suitable for 'analyze the trend of the X industry', 'do a competitor analysis of product Y', 'evaluate the opportunities and risks of project Z'. Triggers: analysis, research, industry report, competitor analysis, trend forecast, SWOT, risk assessment, market research."
---

# multi-analysis

## When to use

- The user provides a topic / industry / product / project and asks for a formal analysis report rather than a few sentences of overview
- The user asks for structured judgements such as "current state / trend / opportunities and risks / competitor comparison / feasibility"
- The user explicitly asks for SWOT, competitor analysis, market research, industry report, or similar output forms

Not suitable for: single-fact lookups, news summaries, pure creative brainstorming — these don't need the multi-dimensional analysis flow.

## How to invoke

Proceed serially through the steps below. **Finish each step before moving to the next**, no skipping:

1. **Define analysis target and dimensions**: from the user's topic, identify the core target, geographic / time scope, and pick the 2–4 most relevant analysis dimensions (candidates: current state, trends, competitive landscape, users / customer segments, technology / policy, risks, SWOT). Drop irrelevant dimensions; too many dimensions only dilute depth.
2. **Gather real data**: pull the latest information via web search, public data sources, and industry materials; when needed, fetch the body of key pages for cross-validation. Only run targeted social-media fetches when the user **explicitly** asks for sentiment coverage — otherwise don't default to social media (high cost, noisy). Note key data sources.
3. **Denoise and organize**: compress raw materials into a structured fact base (numbers / events / quotes / sources); strip out marketing copy, duplicate info, and segments unrelated to the topic. This step organizes facts only — no judgments.
4. **Multi-dimensional analysis**: for each dimension, do deductive analysis based on the fact base — answer "what does this mean", don't just re-list the facts. Clear logic chain, evidence-backed conclusions.
5. **Self-check and refine**: review accuracy, completeness, objectivity, and logic; fill in missing dimensions, correct doubtful conclusions; if a serious problem is found, return to step 2 or 4.
6. **Output the final report**: reply to the user with **only** the report body described in "Return format". Intermediate artifacts (fact base, drafts, source-research notes) do not go into the final message.

## Return format

The final reply contains **only** a highly structured Markdown analysis report, organized as:

- Open with a `>` blockquote labeled **[Core Summary]**, 3–6 lines summarizing the key conclusions
- Body divided by analysis dimensions, one H2 heading per dimension
- Multi-dimensional comparisons and quantitative enumerations (including SWOT) → prefer **tables**
- Proportions / scores / metric comparisons → use the built-in bar-chart syntax, written directly in the body (**not** wrapped in a code block):
  :::chart-bar
  [
    {"label": "Example A", "value": 45, "unit": "%"},
    {"label": "Example B", "value": 30, "unit": "%"}
  ]
  :::
- Key findings, strategic recommendations, risk warnings → highlighted with `>` blockquotes
- Use nested lists for complex hierarchy; bold keywords and key numbers
- End with **[Conclusions and Recommendations]**, clearly organized actionable advice
- If file deliverables are produced (PDF / Markdown), state their path in one closing sentence as part of the report body

**Forbidden** in the final reply:
- Raw fact base, fetch details, source-research notes (a brief "References" sub-section may be appended at the end, but don't paste full original text)
- Drafts, version comparisons, self-check diffs
- Reasoning process, tool-call logs, search-keyword lists
- Opening pleasantries ("Below is my analysis…") and closing courtesies ("Hope this helps…")
- Meta info (time taken, step count, self-narration of the flow)

## Limitations / known issues

- **When real-time data cannot be obtained, say so explicitly**; never fabricate data, samples, or sources
- Do not do "blind analysis" based solely on the model's internal knowledge — there must be a real gathering action
- For Chinese niche vertical fields, recent hot topics, and similar scenarios, search recall may be insufficient — switch keywords, switch sources, and clearly state data sparsity
- Social-media sentiment research depends on platform login state and faces anti-scraping limits; anonymous fetches have limited recall — note this in results
- Topics that are too broad (e.g. "analyze the internet") need to be narrowed down before starting; broad topics done bluntly are necessarily empty

## Full example

**User**: Help me analyze the competitive landscape of new-energy automakers in China in 2026.

**Report output form** (excerpt):

> **[Core Summary]**
> In 2026 China's new-energy makers entered a "price war + smart-driving democratization" dual-mainline phase. The top three combined hold ~62% market share; mid-tier companies broadly see widening losses; the technology gap narrows and channel cost becomes the new dividing line.

## I. Market Status

| Maker | 2025 Sales (10k) | YoY | Gross Margin | Main Battlefield |
|---|---|---|---|---|
| A | 48 | +21% | 18% | 200–300k SUV |
| B | 32 | +9% | 12% | 300k+ Sedan |
| C | 19 | -5% | 6% | 150–200k |

:::chart-bar
[
  {"label": "A", "value": 48, "unit": "10k units"},
  {"label": "B", "value": 32, "unit": "10k units"},
  {"label": "C", "value": 19, "unit": "10k units"}
]
:::

## II. Competitive Landscape

> Top players lock in inventory; mid-tier cash flow is stressed — 2026 will likely see 1–2 exits / consolidations.

…

> **[Conclusions and Recommendations]**
> 1. Watch maker A's gross-margin trajectory after smart-driving democratization, and whether it is forced to follow with price cuts
> 2. Mid-tier players: watch cash flow; **Q2 earnings** is the key checkpoint
> 3. The window for new entrants is essentially closed unless there is a differentiated energy / form-factor breakthrough
