#!/usr/bin/env python3
"""Per-platform fetch primitives shared by `fetch.py`.

Self-contained: depends only on `requests` and (optionally) `browser_cookie3`
plus external CLIs (`xreach`, `yt-dlp`) and the local Xiaohongshu proxy.
"""
import hashlib, json, os, re, shutil, subprocess, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime

import requests

try:
    import browser_cookie3
    _BROWSER_COOKIE3_OK = True
except ImportError:
    _BROWSER_COOKIE3_OK = False

try:
    from curl_cffi import requests as curl_cffi_requests
    _CURL_CFFI_OK = True
except ImportError:
    _CURL_CFFI_OK = False

XHS_BASE = 'http://localhost:18060'
XHS_REQUEST_TIMEOUT = 70   # Slightly above the server's internal 60s timeout, so we get a 500 instead of context-canceled
XHS_DETAIL_WORKERS = 4     # Number of threads used to fetch detail concurrently
DEFAULT_YOUTUBE_META_COUNT = 8
DEFAULT_YOUTUBE_META_WORKERS = 4

# Browsers that browser_cookie3 can read from. Order = priority — first browser
# that yields cookies for the requested domain wins. Override with the
# SOCIAL_FETCH_BROWSERS env var (comma-separated) when needed.
_DEFAULT_BROWSERS = ('chrome', 'firefox', 'edge', 'safari', 'brave', 'chromium')


def _load_cookies_for_domain(domain_name: str, allowed: bool = False) -> dict:
    """Read cookies for `domain_name` from any installed browser.

    Tries each browser in `_DEFAULT_BROWSERS` order (or the env override) and
    returns the first non-empty cookie set. Returns {} if browser_cookie3 is
    not installed or no browser yielded cookies.
    """
    if not allowed or not _BROWSER_COOKIE3_OK:
        return {}

    override = os.environ.get('SOCIAL_FETCH_BROWSERS', '').strip()
    if override:
        browsers = tuple(b.strip() for b in override.split(',') if b.strip())
    else:
        browsers = _DEFAULT_BROWSERS

    for name in browsers:
        loader = getattr(browser_cookie3, name, None)
        if not callable(loader):
            continue
        try:
            cj = loader(domain_name=domain_name)
            cookies = {c.name: c.value for c in cj}
            if cookies:
                return cookies
        except Exception:
            continue
    return {}


def _get_reddit_cookies(allowed: bool = False):
    return _load_cookies_for_domain('.reddit.com', allowed=allowed)


def _get_bilibili_cookies(allowed: bool = False):
    return _load_cookies_for_domain('.bilibili.com', allowed=allowed)


# ── Bilibili Wbi signature (required since 2023) ──────────────────────

_WBI_MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

def _wbi_get_mixin_key(orig: str) -> str:
    return ''.join(orig[i] for i in _WBI_MIXIN_KEY_ENC_TAB)[:32]

def _wbi_sign_params(params: dict, img_key: str, sub_key: str) -> dict:
    mixin = _wbi_get_mixin_key(img_key + sub_key)
    params['wts'] = int(time.time())
    q = urllib.parse.urlencode(sorted(params.items(), key=lambda x: x[0]))
    params['w_rid'] = hashlib.md5((q + mixin).encode()).hexdigest()
    return params

def _bilibili_fetch_wbi_keys(session, headers, cookies, timeout=15):
    try:
        nav = session.get(
            'https://api.bilibili.com/x/web-interface/nav',
            headers=headers, cookies=cookies, timeout=timeout,
        )
        nav.encoding = 'utf-8'
        nav_data = nav.json()
        wbi = nav_data.get('data', {}).get('wbi_img', {})
        img = (wbi.get('img_url', '') or '').rsplit('/', 1)[-1].split('.')[0]
        sub = (wbi.get('sub_url', '') or '').rsplit('/', 1)[-1].split('.')[0]
        if img and sub:
            return img, sub
    except Exception:
        pass
    return None, None


def log(msg):
    ts = datetime.now().strftime('%H:%M:%S')
    print(f'[{ts}] {msg}', flush=True)


def to_int(v):
    try:
        return int(str(v).replace(',', ''))
    except Exception:
        return 0


def make_diag(name):
    return {
        'platform': name,
        'status': 'ok',
        'reason': '',
        'raw_hits': 0,
        'deduped': 0,
        'selected': 0,
        'failed': 0,
        'errors': [],
        'details': [],
    }


def add_diag(diag, **kwargs):
    for k, v in kwargs.items():
        if k == 'errors' and v:
            diag.setdefault('errors', []).append(v)
        elif k == 'detail' and v:
            diag.setdefault('details', []).append(v)
        else:
            diag[k] = v


def xreach_cmd(keyword, count=30):
    return ['xreach', 'search', keyword, '--json', '-n', str(count)]


def yt_dlp_cmd(*args):
    bin_path = shutil.which('yt-dlp')
    if bin_path:
        return [bin_path, *args]
    return [sys.executable, '-m', 'yt_dlp', *args]


def _yt_dlp_search(prefix, kw, limit=8, browser_cookies=None):
    q = f'{prefix}{limit}:{kw}'
    cmd = yt_dlp_cmd(q, '--dump-single-json', '--skip-download', '--flat-playlist')
    if browser_cookies:
        cmd = yt_dlp_cmd('--cookies-from-browser', browser_cookies, q, '--dump-single-json', '--skip-download', '--flat-playlist')
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        if r.returncode != 0 or not r.stdout.strip():
            return []
        data = json.loads(r.stdout)
        return data.get('entries', []) or []
    except Exception:
        return []


def _yt_dlp_meta(url):
    try:
        r = subprocess.run(yt_dlp_cmd(url, '--dump-json', '--skip-download'), capture_output=True, text=True, timeout=90)
        if r.returncode != 0 or not r.stdout.strip():
            return {}
        return json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        return {}


def _twitter_fetch_comments(tweet_url):
    try:
        result = subprocess.run(
            ['xreach', 'thread', tweet_url, '--json'],
            capture_output=True, text=True, timeout=90,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return []
        data = json.loads(result.stdout)
        items = data.get('items', [])
        replies = items[1:] if len(items) > 1 else []
        return [
            {'user': r.get('username', ''), 'text': r.get('text', '')}
            for r in replies
            if r.get('text')
        ]
    except Exception:
        return []


def _youtube_fetch_comments(url):
    try:
        r = subprocess.run(
            yt_dlp_cmd('--write-comments', '--dump-json', '--skip-download', url),
            capture_output=True, text=True, timeout=120,
        )
        if r.returncode != 0 or not r.stdout.strip():
            return []
        data = json.loads(r.stdout.strip().splitlines()[-1])
        comments = data.get('comments', []) or []
        return [
            {'user': c.get('author', ''), 'text': c.get('text', '')}
            for c in comments
            if c.get('text')
        ]
    except Exception:
        return []


# Xiaohongshu enum values are Chinese strings sent verbatim to the upstream
# local proxy server — do not translate.
_XHS_VALID_PUBLISH_TIMES = {'一天内', '一周内', '半年内', '不限'}
_XHS_VALID_SORTS = {'最新', '最热'}

def fetch_xhs(config):
    log('🔴 Fetching Xiaohongshu...')
    diag = make_diag('Xiaohongshu')
    seen, notes = set(), []

    publish_time = config.get('xhs_publish_time', '半年内')
    if publish_time not in _XHS_VALID_PUBLISH_TIMES:
        log(f'  ⚠️  xhs_publish_time="{publish_time}" is not a valid enum, falling back to "半年内" (valid: {sorted(_XHS_VALID_PUBLISH_TIMES)})')
        publish_time = '半年内'

    xhs_sort = config.get('xhs_sort', '最新')
    if xhs_sort not in _XHS_VALID_SORTS:
        log(f'  ⚠️  xhs_sort="{xhs_sort}" is not a valid enum, falling back to "最新" (valid: {sorted(_XHS_VALID_SORTS)})')
        xhs_sort = '最新'

    try:
        requests.get(XHS_BASE, timeout=3)
    except Exception as e:
        add_diag(diag, status='error', reason='xhs_service_unreachable', errors=str(e))
        log(f'  ❌ Xiaohongshu service unreachable: {e}')
        return [], diag

    _xhs_broken = False  # After a server error, do not retry remaining keywords
    for kw in config['xhs_keywords']:
        if _xhs_broken:
            break
        log(f'  → {kw}')
        try:
            resp = requests.post(
                f'{XHS_BASE}/api/v1/feeds/search',
                json={'keyword': kw, 'filters': {'sort_by': xhs_sort, 'note_type': '不限', 'publish_time': publish_time}},
                timeout=XHS_REQUEST_TIMEOUT,
            )
            if resp.status_code >= 500:
                _xhs_broken = True
                add_diag(diag, status='error', reason=f'xhs_search_http_{resp.status_code}',
                         failed=diag['failed'] + 1, errors=f'{kw}: HTTP {resp.status_code}')
                log(f'    ❌ HTTP {resp.status_code}, Xiaohongshu service error; skipping remaining keywords')
                break
            payload = resp.json()
            feeds = payload.get('data', {}).get('feeds', []) if payload.get('success') else []
        except requests.exceptions.Timeout:
            _xhs_broken = True
            add_diag(diag, status='error', reason='xhs_search_timeout',
                     failed=diag['failed'] + 1, errors=f'{kw}: timeout>{XHS_REQUEST_TIMEOUT}s')
            log(f'    ❌ Search timeout (>{XHS_REQUEST_TIMEOUT}s), Xiaohongshu service error; skipping remaining keywords')
            break
        except Exception as e:
            log(f'    failed: {e}')
            add_diag(diag, failed=diag['failed'] + 1, errors=f'{kw}: {e}')
            feeds = []
        add_diag(diag, raw_hits=diag['raw_hits'] + len(feeds), detail={'keyword': kw, 'raw_hits': len(feeds)})
        log(f'    {len(feeds)} items')
        for feed in feeds:
            fid = feed.get('id', '')
            if not fid or fid in seen:
                continue
            seen.add(fid)
            nc = feed.get('noteCard', {}) or {}
            user = nc.get('user', {}) or {}
            notes.append({
                'platform': 'Xiaohongshu',
                'id': fid,
                'xsec_token': feed.get('xsecToken', ''),
                'url': f"https://www.xiaohongshu.com/explore/{fid}?xsec_token={feed.get('xsecToken','')}",
                'title': nc.get('displayTitle', ''),
                'author': user.get('nickname', ''),
                'likes': to_int(nc.get('interactInfo', {}).get('likedCount', 0)),
                'collects': to_int(nc.get('interactInfo', {}).get('collectedCount', 0)),
                'comments': to_int(nc.get('interactInfo', {}).get('commentCount', 0)),
                'keyword_hit': kw,
                'content': '',
                'comments_list': [],
            })
        time.sleep(0.3)

    notes.sort(key=lambda x: (-x.get('comments', 0), -x.get('likes', 0)))
    max_detail = max(1, int(config.get('max_detail') or 30))

    def _xhs_fetch_detail(n):
        try:
            resp = requests.post(
                f'{XHS_BASE}/api/v1/feeds/detail',
                json={'feed_id': n['id'], 'xsec_token': n.get('xsec_token', '')},
                timeout=XHS_REQUEST_TIMEOUT,
            )
            j = resp.json()
            inner = j.get('data', {}).get('data', {}) if j.get('success') else {}
            note = inner.get('note', {})
            n['content'] = note.get('desc', '') or note.get('title', '')
            cdata = inner.get('comments', {})
            clist = cdata.get('list', []) if isinstance(cdata, dict) else []
            n['comments_list'] = [
                {'user': c.get('userInfo', {}).get('nickname', ''), 'text': c.get('content', '')}
                for c in clist if isinstance(c, dict)
            ]
            return n, None
        except Exception as e:
            return n, e

    detail_targets = notes[:max_detail]
    log(f'  📥 Fetching detail ({len(detail_targets)} notes, concurrency {XHS_DETAIL_WORKERS})...')
    workers = max(1, min(XHS_DETAIL_WORKERS, len(detail_targets)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_xhs_fetch_detail, n): n for n in detail_targets}
        for future in as_completed(futures):
            _, err = future.result()
            if err:
                n = futures[future]
                add_diag(diag, failed=diag['failed'] + 1, errors=f"detail:{n.get('id','')}: {err}")

    add_diag(diag, deduped=len(notes), selected=len(notes))
    if not notes and diag['status'] == 'ok':
        add_diag(diag, status='empty', reason='no_results_after_search')
    log(f"  ✅ Xiaohongshu {len(notes)} items, {sum(1 for n in notes[:max_detail] if n['content'])} with body")
    return notes, diag


def fetch_twitter(config):
    log('🔵 Fetching Twitter/X...')
    diag = make_diag('Twitter/X')
    seen, tweets = set(), []
    twitter_count = max(1, min(100, int(config.get('twitter_count', 30))))
    for kw in config['twitter_keywords']:
        log(f'  → {kw}')
        try:
            result = subprocess.run(xreach_cmd(kw, twitter_count), capture_output=True, text=True, timeout=90)
            if result.returncode == 0 and result.stdout.strip():
                items = json.loads(result.stdout).get('items', [])
                add_diag(diag, raw_hits=diag['raw_hits'] + len(items), detail={'keyword': kw, 'raw_hits': len(items)})
                log(f'    {len(items)} items')
                for item in items:
                    tid = item.get('id', '')
                    if not tid or tid in seen:
                        continue
                    seen.add(tid)
                    tweets.append({
                        'platform': 'Twitter/X', 'id': tid, 'url': f'https://x.com/i/web/status/{tid}',
                        'title': '', 'author': item.get('username', ''),
                        'likes': to_int(item.get('likes', 0)), 'collects': 0,
                        'comments': to_int(item.get('replies', 0)), 'retweets': to_int(item.get('retweets', 0)),
                        'views': to_int(item.get('views', 0)), 'keyword_hit': kw,
                        'content': (item.get('text') or ''), 'comments_list': [],
                    })
            else:
                err = (result.stderr or result.stdout or '').strip()[:200]
                add_diag(diag, failed=diag['failed'] + 1, errors=f"{kw}: {err or 'xreach returned empty'}")
                log('    xreach returned empty or error')
        except subprocess.TimeoutExpired:
            add_diag(diag, failed=diag['failed'] + 1, errors=f'{kw}: timeout')
            log('    timeout')
        except Exception as e:
            add_diag(diag, failed=diag['failed'] + 1, errors=f'{kw}: {e}')
            log(f'    failed: {e}')
        time.sleep(2)

    tweets.sort(key=lambda x: (-x.get('comments', 0), -x.get('likes', 0)))
    max_detail = max(1, int(config.get('max_detail') or 30))

    log(f'  📥 Fetching {min(len(tweets), max_detail)} tweet replies...')
    for t in tweets[:max_detail]:
        try:
            t['comments_list'] = _twitter_fetch_comments(t['url'])
        except Exception as e:
            add_diag(diag, failed=diag['failed'] + 1, errors=f"thread:{t.get('id','')}: {e}")
        time.sleep(2)

    add_diag(diag, deduped=len(tweets), selected=len(tweets))
    if not tweets and diag['status'] == 'ok':
        add_diag(diag, status='empty', reason='no_results_after_search')
    log(f'  ✅ Twitter/X {len(tweets)} items')
    return tweets, diag


_REDDIT_VALID_SORTS = {'new', 'top', 'hot', 'relevance', 'comments'}


def _reddit_get_json(urls, headers, cookies, timeout=30, retries=3, backoff=1.5):
    last_err = None
    for idx, url in enumerate(urls):
        for attempt in range(1, retries + 1):
            try:
                resp = requests.get(url, headers=headers, cookies=cookies, timeout=timeout)
                if resp.status_code == 403:
                    return resp, None
                if resp.status_code in (429, 500, 502, 503, 504):
                    last_err = RuntimeError(f'HTTP {resp.status_code}')
                    if attempt < retries:
                        time.sleep(backoff * attempt)
                        continue
                resp.raise_for_status()
                return resp, resp.json()
            except Exception as e:
                last_err = e
                if attempt < retries:
                    time.sleep(backoff * attempt)
                    continue
        if idx < len(urls) - 1:
            time.sleep(1)
    raise last_err or RuntimeError('reddit_request_failed')


def fetch_reddit(config):
    log('🟠 Fetching Reddit...')
    diag = make_diag('Reddit')
    seen, posts = set(), []
    headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'}
    cookies = _get_reddit_cookies(bool(config.get('use_browser_cookies')))
    if not cookies:
        log('  ⚠️  Reddit cookies not available; fetch success rate may drop')

    reddit_sort = config.get('reddit_sort', 'new')
    if reddit_sort not in _REDDIT_VALID_SORTS:
        log(f'  ⚠️  reddit_sort="{reddit_sort}" is not a valid enum, falling back to "new" (valid: {sorted(_REDDIT_VALID_SORTS)})')
        reddit_sort = 'new'

    for kw in config['reddit_keywords']:
        log(f'  → {kw}')
        try:
            encoded_kw = requests.utils.quote(kw)
            search_urls = [
                f"https://www.reddit.com/search.json?q={encoded_kw}&sort={reddit_sort}&t={config.get('reddit_time','month')}&limit=25",
                f"https://old.reddit.com/search.json?q={encoded_kw}&sort={reddit_sort}&t={config.get('reddit_time','month')}&limit=25",
            ]
            resp, data = _reddit_get_json(search_urls, headers, cookies, timeout=30, retries=3)
            if resp.status_code == 403:
                add_diag(diag, status='error', reason='reddit_403_blocked', failed=diag['failed'] + 1, errors=f'{kw}: HTTP 403')
                log('    HTTP 403 (blocked by Reddit)')
                continue
            items = (data or {}).get('data', {}).get('children', [])
            add_diag(diag, raw_hits=diag['raw_hits'] + len(items), detail={'keyword': kw, 'raw_hits': len(items)})
            log(f'    {len(items)} items')
            for item in items:
                d = item.get('data', {})
                pid = d.get('id', '')
                if not pid or pid in seen:
                    continue
                seen.add(pid)
                posts.append({
                    'platform': 'Reddit', 'id': pid, 'url': f"https://www.reddit.com{d.get('permalink', '')}",
                    'title': d.get('title', ''), 'author': d.get('author', ''),
                    'likes': d.get('score', 0), 'collects': 0, 'comments': d.get('num_comments', 0),
                    'keyword_hit': kw, 'content': d.get('selftext', ''), 'comments_list': [],
                    'subreddit': d.get('subreddit_name_prefixed', ''),
                })
        except Exception as e:
            add_diag(diag, failed=diag['failed'] + 1, errors=f'{kw}: {e}')
            log(f'    failed: {e}')
        time.sleep(1)

    posts.sort(key=lambda x: (-x.get('comments', 0), -x.get('likes', 0)))
    max_detail = max(1, int(config.get('max_detail') or 30))

    log(f'  📥 Fetching comments for {min(len(posts), max_detail)} posts...')
    for p in posts[:max_detail]:
        try:
            path = p['url'].replace('https://www.reddit.com', '')
            detail_urls = [
                f'https://www.reddit.com{path}.json?limit=500',
                f'https://old.reddit.com{path}.json?limit=500',
            ]
            _, cmt_data = _reddit_get_json(detail_urls, headers, cookies, timeout=20, retries=3)
            if isinstance(cmt_data, list) and len(cmt_data) > 1:
                cmts = cmt_data[1].get('data', {}).get('children', [])
                p['comments_list'] = [{'user': c['data'].get('author', ''), 'text': c['data'].get('body', '')} for c in cmts if isinstance(c.get('data'), dict) and c['data'].get('body')]
        except Exception as e:
            add_diag(diag, failed=diag['failed'] + 1, errors=f"detail:{p.get('id','')}: {e}")
        time.sleep(1)

    add_diag(diag, deduped=len(posts), selected=len(posts))
    if not posts and diag['status'] == 'ok':
        add_diag(diag, status='empty', reason='no_results_after_search')
    log(f'  ✅ Reddit {len(posts)} items')
    return posts, diag


def fetch_youtube(config):
    log('🟣 Fetching YouTube...')
    diag = make_diag('YouTube')
    seen, raw_entries = set(), []
    for kw in config['youtube_keywords']:
        log(f'  → {kw}')
        entries = _yt_dlp_search('ytsearch', kw, limit=30)
        if not entries:
            add_diag(diag, failed=diag['failed'] + 1, errors=f'{kw}: ytsearch returned empty')
        add_diag(diag, raw_hits=diag['raw_hits'] + len(entries), detail={'keyword': kw, 'raw_hits': len(entries)})
        log(f'    {len(entries)} items')
        for e in entries:
            vid = (e.get('id') or '').strip()
            if not vid or vid in seen:
                continue
            seen.add(vid)
            raw_entries.append((kw, e))
        time.sleep(1)

    max_detail = max(1, int(config.get('max_detail') or 30))
    meta_limit = max(1, int(config.get('youtube_meta_count') or min(max_detail, DEFAULT_YOUTUBE_META_COUNT)))
    meta_workers = max(1, min(8, int(config.get('youtube_meta_workers') or DEFAULT_YOUTUBE_META_WORKERS)))

    def _build_video(item):
        kw, e = item
        vid = (e.get('id') or '').strip()
        url = e.get('url') or f'https://www.youtube.com/watch?v={vid}'
        m = _yt_dlp_meta(url)
        if not m:
            return {
                'platform': 'YouTube', 'id': vid, 'url': url,
                'title': (e.get('title') or '').strip(),
                'author': '', 'likes': 0, 'collects': 0,
                'comments': 0, 'views': 0,
                'keyword_hit': kw, 'content': '', 'comments_list': [],
                '_meta_error': 'empty_meta',
            }
        return {
            'platform': 'YouTube', 'id': vid, 'url': m.get('webpage_url') or url,
            'title': (m.get('title') or e.get('title') or '').strip(),
            'author': m.get('uploader') or m.get('channel') or '',
            'likes': to_int(m.get('like_count', 0)), 'collects': 0,
            'comments': to_int(m.get('comment_count', 0)), 'views': to_int(m.get('view_count', 0)),
            'keyword_hit': kw, 'content': (m.get('description') or ''), 'comments_list': [],
        }

    videos = []
    meta_targets = raw_entries[:meta_limit]
    skipped_meta = max(0, len(raw_entries) - len(meta_targets))
    if skipped_meta:
        add_diag(diag, detail={'meta_skipped': skipped_meta, 'meta_limit': meta_limit})
    log(f'  📥 Filling metadata for {len(meta_targets)} videos (concurrency {meta_workers})...')
    with ThreadPoolExecutor(max_workers=meta_workers) as pool:
        future_map = {pool.submit(_build_video, item): item for item in meta_targets}
        for future in as_completed(future_map):
            item = future_map[future]
            kw, e = item
            vid = (e.get('id') or '').strip()
            try:
                video = future.result()
            except Exception as ex:
                add_diag(diag, failed=diag['failed'] + 1, errors=f'meta:{vid}: {ex}')
                continue
            if video.get('_meta_error'):
                add_diag(diag, failed=diag['failed'] + 1, errors=f'meta:{vid}: {video.get("_meta_error")}')
                video.pop('_meta_error', None)
            videos.append(video)

    videos.sort(key=lambda x: (-x.get('comments', 0), -x.get('likes', 0), x.get('title', '')))

    log(f'  📥 Fetching comments for {min(len(videos), max_detail)} videos...')
    for v in videos[:max_detail]:
        try:
            v['comments_list'] = _youtube_fetch_comments(v['url'])
        except Exception as e:
            add_diag(diag, failed=diag['failed'] + 1, errors=f"comments:{v.get('id','')}: {e}")
        time.sleep(2)

    add_diag(diag, deduped=len(raw_entries), selected=len(videos), detail={'meta_workers': meta_workers})
    if not videos and diag['status'] == 'ok':
        add_diag(diag, status='empty', reason='no_results_after_search')
    log(f'  ✅ YouTube {len(videos)} items (raw deduped {len(raw_entries)})')
    return videos, diag


_BILIBILI_VALID_SORTS = {'pubdate', 'totalrank', 'click', 'dm', 'stow'}

def fetch_bilibili(config):
    """Fetch Bilibili search results with Wbi signature + TLS fingerprint.

    Requires curl_cffi for TLS fingerprint emulation (falls back to requests).
    Login via browser is strongly recommended.
    """
    log('🟡 Fetching Bilibili...')
    diag = make_diag('Bilibili')
    seen, videos = set(), []

    cookies = _get_bilibili_cookies(bool(config.get('use_browser_cookies')))
    if not cookies:
        log('  ⚠️  Bilibili cookies not available; Bilibili requires login, fetch will likely fail')

    http = curl_cffi_requests if _CURL_CFFI_OK else requests
    if not _CURL_CFFI_OK:
        log('  ⚠️  curl_cffi not installed; TLS fingerprint may trigger anti-bot (pip install curl_cffi)')

    session = http.Session()
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://www.bilibili.com',
        'Origin': 'https://www.bilibili.com',
    }

    bilibili_sort = config.get('bilibili_sort', 'pubdate')
    if bilibili_sort not in _BILIBILI_VALID_SORTS:
        log(f'  ⚠️  bilibili_sort="{bilibili_sort}" is not a valid enum, falling back to "pubdate" (valid: {sorted(_BILIBILI_VALID_SORTS)})')
        bilibili_sort = 'pubdate'

    # Acquire Wbi signing keys from nav API
    img_key, sub_key = _bilibili_fetch_wbi_keys(session, headers, cookies, timeout=15)
    if not img_key:
        add_diag(diag, status='error', reason='wbi_key_fetch_failed',
                 errors='Could not obtain Wbi signing keys from nav API')
        log('  ❌ Failed to obtain Wbi signing keys')
        return [], diag

    for kw in config['bilibili_keywords']:
        log(f'  → {kw}')
        try:
            params = _wbi_sign_params({
                'search_type': 'video',
                'keyword': kw,
                'page': 1,
                'page_size': 30,
                'order': bilibili_sort,
            }, img_key, sub_key)

            _req_kw = {'headers': headers, 'cookies': cookies, 'timeout': 30}
            if _CURL_CFFI_OK:
                _req_kw['impersonate'] = 'chrome131'

            resp = session.get(
                'https://api.bilibili.com/x/web-interface/search/type',
                params=params, **_req_kw,
            )

            ct = resp.headers.get('content-type', '')
            if 'html' in ct:
                # Some logged-in browser sessions can search normally while the signed
                # request is still challenged. Warm up the web search page and retry
                # with the browser-equivalent unsigned API request before declaring
                # an anti-bot failure.
                try:
                    warm_headers = dict(headers)
                    warm_headers['Referer'] = f"https://search.bilibili.com/all?keyword={urllib.parse.quote(kw)}"
                    warm_kw = {'headers': warm_headers, 'cookies': cookies, 'timeout': 30}
                    if _CURL_CFFI_OK:
                        warm_kw['impersonate'] = 'chrome131'
                    session.get(warm_headers['Referer'], **warm_kw)
                    unsigned_params = {
                        'search_type': 'video',
                        'keyword': kw,
                        'page': 1,
                        'page_size': 30,
                        'order': bilibili_sort,
                    }
                    resp = session.get(
                        'https://api.bilibili.com/x/web-interface/search/type',
                        params=unsigned_params, **warm_kw,
                    )
                    ct = resp.headers.get('content-type', '')
                except Exception as e:
                    add_diag(diag, detail={'keyword': kw, 'fallback_error': str(e)})
                if 'html' in ct:
                    add_diag(diag, failed=diag['failed'] + 1,
                             errors=f'{kw}: anti-bot HTML page (requires browser login / IP unblocking)')
                    log('    ⚠️  Anti-bot page — login required or IP temporarily blocked')
                    continue

            data = resp.json()
            code = data.get('code')
            if code != 0:
                msg = data.get('message', f'code={code}')
                if code == -101:
                    add_diag(diag, status='error', reason='bilibili_login_required',
                             failed=diag['failed'] + 1,
                             errors=f'{kw}: login required (code -101). Log into Bilibili in browser first')
                    log('    ❌ Login required — log into bilibili.com in Chrome/Firefox first')
                    break
                add_diag(diag, failed=diag['failed'] + 1, errors=f'{kw}: {msg}')
                log(f'    API error: {msg}')
                continue

            items = data.get('data', {}).get('result', []) or []
            add_diag(diag, raw_hits=diag['raw_hits'] + len(items),
                     detail={'keyword': kw, 'raw_hits': len(items)})
            log(f'    {len(items)} items')
            for item in items:
                bvid = item.get('bvid', '')
                if not bvid or bvid in seen:
                    continue
                seen.add(bvid)
                videos.append({
                    'platform': 'Bilibili', 'id': bvid,
                    'aid': item.get('aid', 0),
                    'url': item.get('arcurl') or f'https://www.bilibili.com/video/{bvid}',
                    'title': re.sub(r'<[^>]+>', '', item.get('title', '')),
                    'author': item.get('author', ''),
                    'likes': to_int(item.get('like', 0)),
                    'collects': to_int(item.get('favorites', 0)),
                    'comments': to_int(item.get('review', 0)),
                    'views': to_int(item.get('play', 0)),
                    'published_at': item.get('pubdate', 0),
                    'keyword_hit': kw,
                    'content': (item.get('description') or ''),
                    'comments_list': [],
                })
        except Exception as e:
            add_diag(diag, failed=diag['failed'] + 1, errors=f'{kw}: {e}')
            log(f'    failed: {e}')
        time.sleep(1)

    videos.sort(key=lambda x: (-x.get('comments', 0), -x.get('likes', 0)))
    max_detail = max(1, int(config.get('max_detail') or 30))

    log(f'  📥 Fetching comments for {min(len(videos), max_detail)} videos...')
    for v in videos[:max_detail]:
        aid = v.get('aid', 0)
        if not aid:
            continue
        try:
            _cm_kw = {'headers': headers, 'cookies': cookies, 'timeout': 20}
            if _CURL_CFFI_OK:
                _cm_kw['impersonate'] = 'chrome131'
            cm_resp = session.get(
                f'https://api.bilibili.com/x/v2/reply?type=1&oid={aid}&pn=1&ps=50&sort=0',
                **_cm_kw,
            )
            cm_data = cm_resp.json()
            if cm_data.get('code') == 0:
                replies = cm_data.get('data', {}).get('replies', []) or []
                v['comments_list'] = [
                    {'user': r.get('member', {}).get('uname', ''),
                     'text': r.get('content', {}).get('message', '')}
                    for r in replies if isinstance(r, dict)
                ]
        except Exception:
            pass
        time.sleep(0.5)

    add_diag(diag, deduped=len(videos), selected=len(videos))
    if not videos and diag['status'] == 'ok':
        add_diag(diag, status='empty', reason='no_results_after_search')
    log(f'  ✅ Bilibili {len(videos)} items')
    return videos, diag
