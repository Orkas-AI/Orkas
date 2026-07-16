# Fetching Public Social Posts

Use fetch mode to collect public social discussion samples for a specific platform and keyword set.

## Supported Platforms

| Platform | Script value | Notes |
|---|---|---|
| Xiaohongshu | `xhs` | Requires local proxy service at `http://localhost:18060` |
| X / Twitter | `twitter` | Requires `xreach` CLI |
| Reddit | `reddit` | Uses public JSON endpoints; cookies from browser can improve recall |
| YouTube | `youtube` | Uses `yt-dlp` |
| Bilibili | `bilibili` | Public recall improves with browser cookies |

## Command

```bash
$ORKAS_NODE $ORKAS_PC_DIR/bin/run-skill.cjs social-data fetch -- <platform> <keywords> [options]
```

Arguments:

- `<platform>`: `xhs | twitter | reddit | youtube | bilibili`.
- `<keywords>`: comma-separated keyword groups.
- `--max-detail N`: cap detail/comment fetches; deduped items still remain in output.

Platform options:

| Platform | Option | Values |
|---|---|---|
| Xiaohongshu | `--xhs-publish-time` | `一天内`, `一周内`, `半年内`, `不限` |
| Xiaohongshu | `--xhs-sort` | `最新`, `最热` |
| Twitter/X | `--twitter-count` | 1-100 |
| Reddit | `--reddit-time` | `day`, `week`, `month`, `year`, `all` |
| Reddit | `--reddit-sort` | `new`, `top`, `hot`, `relevance`, `comments` |
| Bilibili | `--bilibili-sort` | `pubdate`, `totalrank`, `click`, `dm`, `stow` |

## Keyword Strategy

Do not use only the user's raw query unless they explicitly require it. Build 3-8 short keyword groups:

- Direct product/brand/model names.
- Chinese and English variants.
- Abbreviations, nicknames, pinyin initials, or common misspellings.
- Pain point language such as "avoid", "complaint", "recommend", "compare", "how to choose".
- Competitor or category terms when the user's goal is reputation or market feedback.

Prefer multiple focused searches over one long query.

## Output Contract

Successful script output is a single JSON object:

```json
{
  "ok": true,
  "platform": "reddit",
  "count": 0,
  "items": [],
  "diag": {
    "status": "ok",
    "raw_hits": 0,
    "deduped": 0,
    "selected": 0,
    "failed": 0,
    "reason": ""
  }
}
```

Common item fields:

- `platform`
- `id`
- `url`
- `title`
- `author`
- `likes`
- `comments`
- `collects`
- `views`
- `keyword_hit`
- `content`
- `comments_list`

## Interpretation Rules

- `diag.status = "empty"` means the fetch returned no usable samples; it does not prove the topic has no discussion.
- `diag.status = "error"` means the platform call failed; report the reason and do not fabricate samples.
- Keep conclusions traceable to URLs, item IDs, titles, post text, or comments.
- When several platforms are needed, run one platform at a time so a stuck platform does not block the whole task.
- Use smaller `--max-detail` values when speed matters; 10-15 is often enough for theme discovery.

## Dependencies

- Common Python packages: `requests`, optional `browser_cookie3`, optional `curl_cffi`.
- Xiaohongshu: external local proxy service `xiaohongshu-mcp`.
- Twitter/X: `xreach` CLI.
- YouTube: `yt-dlp` CLI or Python module.
- Reddit/Bilibili: browser cookies can improve recall; otherwise anonymous fetch may be limited.
