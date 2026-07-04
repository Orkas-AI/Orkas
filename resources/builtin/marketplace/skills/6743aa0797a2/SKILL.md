---
name: brand-research
description_zh: "研究公司、产品或品牌的公开资料，整理 Brand DNA：定位、受众、竞品、语气、定价、社交证明、来源链接和内容缺口；适合\"研究这个品牌网站\"\"生成 Brand DNA\"\"先梳理公司品牌基础\"；触发词：品牌研究、Brand DNA、公司研究、竞品、定位、品牌语气、GTM 基础、内容缺口"
description_en: "Research public information about a company, product, or brand and produce Brand DNA: positioning, audience, competitors, voice, pricing, social proof, source links, and content gaps; For: \"research this brand website\", \"generate Brand DNA\", \"prepare company brand context\"; Triggers: brand research, Brand DNA, company research, competitors, positioning, brand voice, GTM context, content gaps"
description: "Research a brand from public sources and produce a sourced Brand DNA brief. Use this skill whenever the user asks to understand a company, product, positioning, competitors, brand voice, social proof, or GTM/content context from public evidence."
category: "data"
---

# Brand Research

Use this skill to research a company, product, or brand from its website and public sources, then produce a sourced Brand DNA brief. The work is evidence collection plus synthesis; do not invent missing facts.

## When To Use

- The user provides a company URL, product URL, brand name, or company/product context and asks for brand research.
- The user wants Brand DNA, positioning, target customers, competitors, brand voice, social proof, pricing, online presence, or content gaps.
- The user needs source-backed context before GTM, SEO, GEO/AEO, content strategy, sales messaging, or competitor analysis.

Do not use for:

- Writing landing pages, ads, articles, or full content plans.
- Running a full SEO audit, website audit, or social media performance analysis.
- Investment, legal, financial, or diligence conclusions.
- Updating or publishing to the user's website.
- Making claims without source evidence.

## How To Call

1. Confirm the input.
   - Identify the company URL, company/product name, and optional one-line context.
   - If the URL or company identity is ambiguous, ask the user to confirm.
   - If the homepage is unreachable after retrying, report the access problem instead of inventing a profile.

2. Research the company website first.
   - Prioritize the homepage, about page, pricing page, product/features pages, customer/case-study pages, docs/help/integrations pages, and blog index when relevant.
   - Extract what the product does, who it serves, features, pricing model, target audience signals, integrations, social proof, and repeated messaging.
   - Keep source URLs for important claims.

3. Search public sources second.
   - Use third-party sources to clarify category, team, funding, competitors, reviews, alternatives, and user language.
   - Do not let low-quality directories override the company's own website.
   - Mark sparse, outdated, paywalled, or weak evidence.

4. Identify competitors.
   - Compile 3-5 direct or adjacent competitors when evidence is available.
   - For each, note name, URL, overlap, and apparent edge.
   - If competitors are unclear, say so and explain the missing evidence.

5. Synthesize the Brand DNA.
   - Use `references/brand-dna-template.md`.
   - Separate sourced facts from interpretation.
   - Use "Not found" or "Not disclosed" when facts cannot be verified.
   - Be opinionated in content gaps, but label them as analysis rather than fact.

6. Deliver safely.
   - By default, return the Brand DNA in the conversation.
   - Save `brand_dna.md` only when the user asks for a file or confirms saving.
   - Include top findings, evidence caveats, and suggested next uses.

## Default Output

```markdown
# Brand DNA - [Company Name]

## Overview

## What It Does

## Target Customer

## Competitors

## Differentiators

## Brand Voice

## Social Proof

## Content Gaps

## Source Notes
```

## External Dependencies

- Web access is required for public website and source research.
- Some websites may block automated access, require JavaScript rendering, or hide content behind login walls.
- Paid sources such as Crunchbase, PitchBook, Ahrefs, Semrush, G2, or Capterra may be unavailable unless the user provides access.
- No API key is required by default.

## Limits And Known Issues

- The result is only as reliable as accessible sources.
- Funding, team, pricing, and review information can be outdated, hidden, or paywalled.
- Competitor identification may be low confidence in new or ambiguous categories.
- The skill does not replace legal, financial, investment, or compliance diligence.
- The skill does not publish, edit, or modify the user's website.
