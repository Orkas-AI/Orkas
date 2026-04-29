---
name: social-fetch
description_zh: "抓取小红书 / Twitter X / Reddit / YouTube / Bilibili 上指定关键词的公开帖子，去重后返回结构化结果（标题 / 正文 / 互动数 / URL），供下游做情绪 / 趋势分析。适合\"分析一下小红书最近的 X 话题\"\"看看 Reddit 上对产品 Y 的口碑\"\"找几条 Bilibili 上 Z 的高赞视频\"；触发词：抓一下、找一下、分析、舆情、热度、口碑、讨论、竞品反馈"
description_en: "Fetch public posts on Xiaohongshu / Twitter/X / Reddit / YouTube / Bilibili that match given keywords and return deduplicated structured results (title, body, engagement counts, URL) for downstream sentiment / trend analysis. Suitable for 'analyze the latest X discussion on Xiaohongshu', 'check the Reddit reputation of product Y', 'find a few high-upvote Bilibili videos about Z'. Triggers: fetch, find, analyze, sentiment, buzz, reputation, discussion, competitor feedback."
---

# Social-fetch skill

Fetch public content for given keywords on a single platform, deduplicate, and return `items` (structured) + `diag` (collection status). Each call runs **one** platform — multi-platform needs are dispatched by the caller across multiple invocations.

## When to use

- "Analyze the discussion of *X* on Xiaohongshu" / "Are people on Reddit complaining about *Y*?"
- Research the real reviews, sentiment, or competitor reputation of a brand / product / topic on a given platform
- Monitor industry hotspots and high-frequency user complaints to add primary material to an analysis report

**Don't do**: DMs, login-gated content, non-public data, platforms that require a paid API.

## How to invoke

Single entry point:

```bash
$ORKAS_NODE $ORKAS_PC_DIR/bin/run-skill.cjs social-fetch fetch -- <platform> <keywords> [options]
```

Arguments:

- `<platform>` ∈ `xhs | twitter | reddit | youtube | bilibili` (one platform per call)
- `<keywords>`: comma-separated, 3–8 divergent short keyword groups (see **Keyword strategy**)
- `--max-detail N` (default 30): cap on detail / comment fetches; only controls request count — **all deduped items go into the result**
- Per-platform options (defaults used if omitted):

| Platform | Option | Valid values / default |
|---|---|---|
| Xiaohongshu | `--xhs-publish-time` | `一天内` (last day) / `一周内` (last week) / `半年内` (last 6 months, default) / `不限` (unlimited) |
|  | `--xhs-sort` | `最新` (newest, default) / `最热` (hottest) |
| Twitter/X | `--twitter-count` | 1–100, default 30 |
| Reddit | `--reddit-time` | `day` / `week` / `month` (default) / `year` / `all` |
|  | `--reddit-sort` | `new` (default) / `top` / `hot` / `relevance` / `comments` |
| Bilibili | `--bilibili-sort` | `pubdate` (default) / `totalrank` / `click` / `dm` / `stow` |
| YouTube | (no platform options) | — |

> Note: the Xiaohongshu enum values are Chinese strings because the upstream local proxy expects them verbatim — pass them as-is.

## Return format

Success (single line of JSON on stdout):
```json
{"ok": true, "platform": "xhs", "count": 27, "items": [{...}, ...], "diag": {...}}
```

`items[]` fields (aligned across platforms): `title` / `text` (body excerpt) / `comments` (array of comment excerpts) / `engagement` (likes / comments / collects etc.) / `published_at` / `url`.

`diag`: `{name, status: 'ok'|'empty'|'error', raw_hits, selected, failed, reason?, errors?, detail[]}` — records raw recall, deduped count, and failure reasons.

Failure (stderr + non-zero exit code):
```json
{"ok": false, "error": "TypeError: ..."}
```

## External dependencies

| Platform | Dependency | Behavior when missing |
|---|---|---|
| Xiaohongshu | Local proxy `http://localhost:18060` | `diag.reason=xhs_service_unreachable`, items=[] |
| Twitter/X | `xreach` CLI (`npm i -g xreach-cli`) | items=[] |
| Reddit | Python `requests` + cookies auto-loaded from any installed browser via `browser_cookie3` | Anonymous fetch works but recall is limited |
| YouTube | `yt-dlp` CLI (`pip install yt-dlp`) | items=[] |
| Bilibili | `requests` + same cookie source as Reddit | Anonymous recall is limited |

Common: `pip install requests browser_cookie3`.

**Strongly recommended to log in to Reddit / Bilibili in your regular browser** — anonymous recall is unstable; see below.

## Browser login state (Reddit / Bilibili)

Just log in once in any installed browser; `browser_cookie3` reads cookies directly from the browser's profile. No extra setup or external CLI required.

Default browser priority: `chrome → firefox → edge → safari → brave → chromium` — the first one that has a matching cookie wins.

Override the order (or restrict to a single browser) with the `SOCIAL_FETCH_BROWSERS` env var (comma-separated):

```bash
SOCIAL_FETCH_BROWSERS=firefox,chrome python fetch.py reddit "..."
```

If neither `browser_cookie3` is installed nor any of the listed browsers yields cookies for the target domain, the fetch falls back to anonymous mode.

## Keyword strategy (core rule)

**Never** use the user's raw query as a search term. Extract and diverge keywords first; use 3–8 short keyword groups to maximize recall.

| Strategy | Applies when | How |
|---|---|---|
| Direct core terms | The user gave a clear proper noun or model number | Use the term as-is |
| Synonyms / colloquial | Brand / product research and other open-ended topics | Add nicknames, abbreviations, pinyin initials |
| Scenario / pain points | Looking for a specific use case or comparison | Add "avoid / recommend / compare / how to choose" |
| Bilingual (CN/EN) | Concept discussed in both Chinese and English communities | Add the English equivalent |

Single keyword length: 2–12 Chinese chars / 1–4 English words. **Prefer many keywords with many searches over too-narrow keywords yielding zero results.**

## Limits / known issues

- **One platform per call** — 5-platform needs require the caller to dispatch 5 calls (avoids one stuck platform blocking the others)
- **Zero data ≠ signal**: when `diag.status=='empty'`, do not infer "no one is discussing" from "nothing returned"
- **Don't fabricate on fetch failure**: when `status=='error'`, faithfully report `reason`; don't synthesize samples
- **Xiaohongshu proxy service**: only valid on local macOS (`localhost:18060`); without the proxy this platform errors directly
- **YouTube subtitles / comments**: depend on yt-dlp; some videos can't return subtitles (private / restricted / no auto-subtitles)
- **Reddit / Bilibili anonymous fetch**: recall is significantly lower than logged-in; log in via your regular browser (see above) for stable use
- **Cross-platform paths**: cookie reads go through `browser_cookie3`, which finds the right profile per-OS automatically; the `xhs` proxy path has only been tested on macOS

## Full examples

```bash
# 1. Top monthly Reddit discussions related to "claude code"
$ORKAS_NODE $ORKAS_PC_DIR/bin/run-skill.cjs social-fetch fetch -- \
    reddit "claude code,claude cli,anthropic cli" \
    --reddit-sort top --reddit-time month --max-detail 20

# Output (truncated)
# {"ok":true,"platform":"reddit","count":18,"items":[
#   {"title":"Claude Code is way better than ...", "url":"https://reddit.com/...",
#    "engagement":{"upvotes":342,"comments":87}, "comments":["...","..."], ...},
#   ...
# ], "diag":{"name":"Reddit","status":"ok","raw_hits":31,"selected":18,...}}
```

```bash
# 2. Last-week Xiaohongshu discussion about AirPods
$ORKAS_NODE $ORKAS_PC_DIR/bin/run-skill.cjs social-fetch fetch -- \
    xhs "AirPods,airpods4,苹果耳机,无线耳机怎么选" \
    --xhs-publish-time 一周内 --xhs-sort 最热
```

## Rules

- **Keywords must diverge**: unless the user explicitly restricts the query, automatically extend to synonyms / colloquial / bilingual variants
- **Conclusions must be traceable**: analysis output must point back to specific samples in `items[]`; don't be vague
- **Restrain `max_detail`**: when performance-sensitive, 10–15 covers most scenarios
- **Don't replicate platform logic outside `fetch.py`**: all platform details are centralized in `social_fetch_core.py`
