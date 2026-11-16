---
name: social-writer
description_zh: 社媒内容创作的统一入口：支持中文平台成稿、国际平台单帖、已有稿优化、内容日历、评论/差评/危机回应草案；覆盖小红书、公众号、知乎、抖音/快手、微博、X、LinkedIn、Instagram、TikTok；适合“写小红书”“优化公众号”“排内容日历”“这条差评怎么回”
description_en: Unified social content skill for Chinese platform drafts, global single posts, existing-draft optimization, content calendars, and comment/complaint/crisis response drafts across Xiaohongshu, WeChat, Zhihu, Douyin/Kuaishou, Weibo, X, LinkedIn, Instagram, and TikTok.
---

# Social Writer

## When to Use

Use this skill when the user wants to create, improve, plan, or respond with social media content.

Use for:

- creating Chinese social drafts for Xiaohongshu, WeChat Official Account, Zhihu, Douyin/Kuaishou, Weibo, and similar platforms.
- creating global single posts for X, LinkedIn, Instagram, TikTok, and similar platforms.
- optimizing an existing social draft before posting.
- planning weekly, monthly, or campaign content calendars.
- drafting replies to negative comments, complaints, misunderstandings, and public social issues.

Do not use this skill to operate platform backends, save drafts, click publish, upload media, or perform final legal/public-relations approval.

## Choose The Mode

| Mode | Use when | Output |
|---|---|---|
| `create` | user wants a new post, note, answer, article, caption, or script | platform-native draft |
| `optimize` | user has an existing draft | score, diagnosis, rewrites, checklist |
| `calendar` | user wants a week/month/campaign plan | content calendar with topics and production needs |
| `respond` | user asks how to reply to comments, complaints, or crisis content | risk level, response draft, escalation plan |

## Workflow

1. Identify platform and mode:
   - Chinese platforms: Xiaohongshu, WeChat Official Account, Zhihu, Douyin/Kuaishou, Weibo, Bilibili.
   - Global platforms: X, LinkedIn, Instagram, TikTok.
   - If no platform is specified, use a platform-neutral writing default. Ask only when a missing choice materially changes the requested content; platform/account selection for external editor work is separate.
2. Confirm content inputs:
   - topic, audience, goal, brand voice, source material, product claims, forbidden claims, media availability, and desired action.
   - for existing drafts: current title, body, cover/visual description, tags, and performance data if available.
   - for calendars: date range, cadence, pillars, key dates, resource constraints, review capacity.
   - for responses: original comment/complaint, context, platform, history, support facts, and risk indicators.
3. Run a fact and safety pass:
   - do not invent personal experience, customer reviews, test results, screenshots, income, health results, legal outcomes, or third-party endorsements.
   - mark data, claims, prices, policies, and references that need verification.
   - high-risk domains need human review.
4. Generate platform-native output:
   - Xiaohongshu: title, cover text, hook, short sections, save/comment CTA, 5-10 tags.
   - WeChat: title, opening, 3-5 sections, full body, closing, share/follow CTA.
   - Zhihu: answer directly, reason carefully, include evidence and caveats, avoid hard-sell tone.
   - Douyin/Kuaishou/TikTok: first 1-3 seconds, spoken script, screen text, scene notes, caption, tags.
   - Weibo/X: concise point, clear hook, native topic/tag use, low-friction interaction.
   - LinkedIn: first two lines, story or insight, transferable lesson, CTA, 3-5 tags if useful.
   - Instagram: visual-first caption, save/share CTA, relevant hashtags.
5. For `optimize`:
   - score title/first screen, visual/cover, structure, platform fit, interaction/CTA.
   - identify the top 3 issues and give concrete rewrites.
6. For `calendar`:
   - balance pillars, platform rhythm, key dates, flexible slots, and production capacity.
   - create specific topics, not vague labels.
   - Distinguish a topic calendar from a requested set of finished posts. When the user asks for seven posts or other complete content, deliver every requested draft as well as its placement; a table of topics is not a substitute.
7. For `respond`:
   - classify as complaint, fair criticism, misunderstanding, bad-faith attack, coordinated attack, or legal/safety/privacy/regulatory issue.
   - rate severity: low, medium, high, critical.
   - draft only for human approval; do not publish.

## Return Formats

Output rules (all modes):

- Emit the draft as the reply body directly. Never wrap the whole reply in a triple-backtick fence — the fenced templates below show structure only; do not reproduce their outer fence.
- Social posts are plain text. Do not put triple-backtick code fences in the body: platforms such as X, LinkedIn, Instagram, Xiaohongshu, and Weibo render the backticks literally, and a fence inside the reply also breaks the surrounding rendering. Show diagrams or step flows as plain lines with arrows (e.g. `routine work → local compute`), not as a fenced code block.

For new social content:

```markdown
## Draft: [platform]

### Title / Hook Options
1. ...
2. ...
3. ...

### Body / Script / Caption
...

### CTA
...

### Tags
...

### Visual Or Video Suggestions
- ...

### Needs Verification
- ...
```

For optimization:

```markdown
# Optimization Report: [platform]

## Score
| Dimension | Score / 10 | Notes |
|---|---:|---|

## Top Issues
1. ...
2. ...
3. ...

## Rewrites
- Title:
- Opening:
- CTA:

## Publish Checklist
- [ ] ...
```

For calendar:

```markdown
# Social Calendar: [date range]

## Overview
- Platforms:
- Cadence:
- Pillar mix:
- Main assumptions:

## Plan
| Date | Platform | Pillar | Format | Topic / hook | Target action | Assets |
|---|---|---|---|---|---|---|

## Flexible Slots
- ...

## Production Risks
- ...
```

For response/crisis:

```markdown
# Response Plan

## Assessment
Type:
Severity:
Need to respond:
Main risks:

## Draft Reply
...

## Escalation
- Owner:
- Questions:
- Forbidden automatic actions:

## Monitoring
- ...
```

## Dependencies

- No external tool is required by default.
- Current trends, platform rules, pricing, policies, public facts, and competitor posts require separate lookup when they matter.
- Brand voice, product claims, account performance, and approved statements should come from the user or source files.

## Limits

- Do not promise reach, interaction, ranking, conversion, followers, revenue, or moderation results.
- Do not fabricate experience, reviews, evidence, or platform data.
- Do not publish, schedule, save drafts, or operate platform UI. Return the finished content and media requirements for a separately requested preparation step.
- Crisis, legal, refund, privacy, safety, regulatory, media, and minors-related content requires human approval.
