#!/usr/bin/env python3
"""Single-platform fetch entry — invoked via run-skill.cjs.

Usage:
    python fetch.py <platform> <keywords> [options]

  platform   = xhs | twitter | reddit | youtube | bilibili
  keywords   = comma-separated, e.g. "iphone 15,苹果15,iphone15"

Common option:
  --max-detail N      per-platform detail/comment cap (default 30)

Per-platform options:
  --xhs-publish-time {一天内|一周内|半年内|不限}        default 半年内 (last 6 months)
  --xhs-sort {最新|最热}                                default 最新 (newest)
  --twitter-count N                                     default 30
  --reddit-time {day|week|month|year|all}               default month
  --reddit-sort {new|top|hot|relevance|comments}        default new
  --bilibili-sort {pubdate|totalrank|click|dm|stow}     default pubdate

Note: --xhs-* enum values are kept as Chinese strings because the upstream
Xiaohongshu local proxy expects them verbatim. Pass them as-is.

Output (stdout, single line JSON):
  {"ok": true, "platform": "xhs", "count": N, "items": [...], "diag": {...}}
On failure (stderr + exit 1):
  {"ok": false, "error": "<msg>", "platform": "..."}
"""
import argparse
import json
import sys

from social_fetch_core import (
    fetch_xhs, fetch_twitter, fetch_reddit, fetch_youtube, fetch_bilibili,
)

FETCHERS = {
    'xhs': fetch_xhs,
    'twitter': fetch_twitter,
    'reddit': fetch_reddit,
    'youtube': fetch_youtube,
    'bilibili': fetch_bilibili,
}


def main(argv):
    p = argparse.ArgumentParser(prog='fetch.py')
    p.add_argument('platform', choices=list(FETCHERS))
    p.add_argument('keywords', help='comma-separated search keywords')
    p.add_argument('--max-detail', type=int, default=30)
    # xhs
    p.add_argument('--xhs-publish-time', default='半年内')
    p.add_argument('--xhs-sort', default='最新')
    # twitter
    p.add_argument('--twitter-count', type=int, default=30)
    # reddit
    p.add_argument('--reddit-time', default='month')
    p.add_argument('--reddit-sort', default='new')
    # bilibili
    p.add_argument('--bilibili-sort', default='pubdate')

    args = p.parse_args(argv)

    keywords = [k.strip() for k in args.keywords.split(',') if k.strip()]
    if not keywords:
        raise SystemExit(json.dumps({'ok': False, 'error': 'no keywords supplied'}))

    config = {
        f'{args.platform}_keywords': keywords,
        'max_detail': args.max_detail,
        'xhs_publish_time': args.xhs_publish_time,
        'xhs_sort': args.xhs_sort,
        'twitter_count': args.twitter_count,
        'reddit_time': args.reddit_time,
        'reddit_sort': args.reddit_sort,
        'bilibili_sort': args.bilibili_sort,
    }

    items, diag = FETCHERS[args.platform](config)
    out = {
        'ok': True,
        'platform': args.platform,
        'count': len(items),
        'items': items,
        'diag': diag,
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except SystemExit:
        raise
    except Exception as e:
        err = {'ok': False, 'error': f'{type(e).__name__}: {e}'}
        print(json.dumps(err, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
