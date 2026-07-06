"""seo-crawl — fetch a URL (SSRF-guarded) and extract on-page SEO/GEO fields.

stdlib only. Output is JSON on stdout: {"ok": true, "data": {...}} on success,
{"ok": false, "error": "..."} on stderr + non-zero exit on failure.

Field set mirrors open-seo's `page-analyzer.ts` (~30 on-page fields), extended
with the structured-data / hreflang / lang / viewport signals the technical and
GEO audits consume downstream. Parsing is pure-function (`extract_fields`) so it
is unit-testable against HTML fixtures without network access.

Connections are pinned to a pre-validated public IP (see url_safety.py), and
every redirect hop is re-validated before it is followed — closing the
DNS-rebinding window.
"""

from __future__ import annotations

import argparse
import gzip
from html import unescape
import http.client
import json
import os
import re
import socket
import ssl
import sys
import time
import zlib
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit, urlunsplit

from url_safety import (
    URLSafetyError, assert_proxy_target_safe, parse_and_check_scheme,
    resolve_and_pin, validate_url_strict,
)

DEFAULT_UA = "OrkasSEOBot/1.0 (+https://orkas.ai; SEO/GEO diagnostics)"
DEFAULT_TIMEOUT = 20.0
MAX_REDIRECTS = 5
MAX_BODY_BYTES = 5 * 1024 * 1024  # 5 MB cap; SEO pages are small, guard runaways.

_WORD_RE = re.compile(r"\b[\w'-]+\b", re.UNICODE)
_RAW_ANCHOR_HREF_RE = re.compile(
    r"<a\b[^>]*\bhref\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s\"'=<>`]+))",
    re.IGNORECASE,
)
_SKIP_TEXT_TAGS = {"script", "style", "noscript", "template", "head", "svg"}
_HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}


# ─────────────────────────────────────────────────────────────────────────
# Fetch layer — IP-pinned connections + manual redirect validation
# ─────────────────────────────────────────────────────────────────────────

class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, pinned_ip, **kw):
        super().__init__(host, **kw)
        self._pinned_ip = pinned_ip

    def connect(self):  # connect to the validated IP; Host header stays = self.host
        self.sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, pinned_ip, **kw):
        super().__init__(host, **kw)
        self._pinned_ip = pinned_ip

    def connect(self):  # dial the pinned IP, but keep SNI + cert check on self.host
        sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _decode_body(raw: bytes, encoding: str) -> bytes:
    enc = (encoding or "").lower().strip()
    try:
        if enc == "gzip":
            return gzip.decompress(raw)
        if enc == "deflate":
            try:
                return zlib.decompress(raw)
            except zlib.error:
                return zlib.decompress(raw, -zlib.MAX_WBITS)
    except (OSError, zlib.error):
        return raw
    return raw


def _charset_from_content_type(ct: str) -> str | None:
    m = re.search(r"charset=([\w\-]+)", ct or "", re.IGNORECASE)
    return m.group(1) if m else None


def _no_proxy_match(host: str, no_proxy: str) -> bool:
    host = host.lower()
    for entry in (no_proxy or "").split(","):
        e = entry.strip().lower().lstrip("*").lstrip(".")
        if e and (host == e or host.endswith("." + e) or host.endswith(e)):
            return True
    return False


def _proxy_for(scheme: str, host: str):
    """System HTTP(S) proxy for (scheme, host), honoring NO_PROXY. Returns
    (proxy_host, proxy_port) or None. Lets the crawler work where DNS is
    fake-ip'd (Clash/Surge) — the proxy resolves the real target."""
    no_proxy = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
    if _no_proxy_match(host, no_proxy):
        return None
    raw = (os.environ.get(scheme.upper() + "_PROXY") or os.environ.get(scheme + "_proxy")
           or os.environ.get("ALL_PROXY") or os.environ.get("all_proxy"))
    if not raw:
        return None
    pr = urlsplit(raw if "://" in raw else "http://" + raw)
    if not pr.hostname:
        return None
    return (pr.hostname, pr.port or 80)


def _fetch_once(url: str, timeout: float, ua: str) -> dict:
    """One HTTP request to a validated target. No redirect following.

    Direct path pins the connection to a validated public IP. When a system
    proxy is configured, route through it (CONNECT tunnel for https) and let
    the proxy resolve the target — local DNS is skipped on this path."""
    normalized, scheme, host, port, literal_ip = parse_and_check_scheme(url)
    parts = urlsplit(normalized)
    selector = parts.path or "/"
    if parts.query:
        selector += "?" + parts.query

    proxy = _proxy_for(scheme, host)
    req_target = selector
    if proxy:
        # The proxy resolves the target, so we can't IP-pin; best-effort reject
        # a hostname that locally resolves to a real internal address (SSRF).
        if literal_ip is None:
            assert_proxy_target_safe(host, port)
        phost, pport = proxy
        if scheme == "https":
            ctx = ssl.create_default_context()
            conn = http.client.HTTPSConnection(phost, pport, timeout=timeout, context=ctx)
            conn.set_tunnel(host, port)
        else:
            conn = http.client.HTTPConnection(phost, pport, timeout=timeout)
            req_target = urlunsplit((scheme, parts.netloc, selector, "", ""))  # absolute-form for proxy
        pinned_ip = "proxy:{}:{}".format(phost, pport)
    else:
        pinned_ip = literal_ip if literal_ip is not None else resolve_and_pin(host, port)
        if scheme == "https":
            ctx = ssl.create_default_context()
            conn = _PinnedHTTPSConnection(host, pinned_ip, port=port, timeout=timeout, context=ctx)
        else:
            conn = _PinnedHTTPConnection(host, pinned_ip, port=port, timeout=timeout)

    try:
        conn.request("GET", req_target, headers={
            "Host": host,
            "User-Agent": ua,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Encoding": "gzip, deflate, identity",
            "Connection": "close",
        })
        resp = conn.getresponse()
        raw = resp.read(MAX_BODY_BYTES + 1)
        headers = {k.lower(): v for k, v in resp.getheaders()}
        status = resp.status
        location = resp.getheader("Location")
    finally:
        conn.close()

    truncated = len(raw) > MAX_BODY_BYTES
    if truncated:
        raw = raw[:MAX_BODY_BYTES]
    body = _decode_body(raw, headers.get("content-encoding", ""))
    charset = _charset_from_content_type(headers.get("content-type", "")) or "utf-8"
    try:
        text = body.decode(charset, errors="replace")
    except (LookupError, UnicodeDecodeError):
        text = body.decode("utf-8", errors="replace")

    return {
        "final_url": normalized,
        "status": status,
        "headers": headers,
        "location": location,
        "html": text,
        "truncated": truncated,
        "content_type": headers.get("content-type", ""),
        "pinned_ip": pinned_ip,
    }


def fetch(url: str, timeout: float = DEFAULT_TIMEOUT, ua: str = DEFAULT_UA,
          max_redirects: int = MAX_REDIRECTS) -> dict:
    """Fetch with manual, re-validated redirect following. Returns the final
    response plus the redirect chain and total elapsed time."""
    chain: list[dict] = []
    current = url
    started = time.monotonic()
    for _ in range(max_redirects + 1):
        hop = _fetch_once(current, timeout, ua)
        if 300 <= hop["status"] < 400 and hop["location"]:
            nxt = urljoin(hop["final_url"], hop["location"])
            chain.append({"url": hop["final_url"], "status": hop["status"], "location": nxt})
            current = nxt
            continue
        hop["response_time_ms"] = int((time.monotonic() - started) * 1000)
        hop["redirect_chain"] = chain
        return hop
    raise URLSafetyError(f"too many redirects (>{max_redirects})")


# ─────────────────────────────────────────────────────────────────────────
# Parse layer — pure, unit-testable
# ─────────────────────────────────────────────────────────────────────────

class _PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.html_lang = None
        self.title_parts: list[str] = []
        self.metas: list[dict] = []
        self.links: list[dict] = []
        self.headings: list[dict] = []   # {level, text}
        self.images: list[dict] = []      # {src, alt}
        self.anchors: list[str] = []
        self.jsonld_raw: list[str] = []
        self._text_parts: list[str] = []
        self._skip_depth = 0
        self._in_title = False
        self._heading_level = 0
        self._heading_buf: list[str] = []
        self._in_jsonld = False
        self._jsonld_buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "html" and "lang" in a:
            self.html_lang = a["lang"].strip() or None
        elif tag == "title":
            self._in_title = True
        elif tag == "meta":
            self.metas.append(a)
        elif tag == "link":
            self.links.append(a)
        elif tag == "img":
            self.images.append({"src": a.get("src", ""), "alt": a.get("alt", None) if "alt" in a else None})
        elif tag == "a" and "href" in a:
            self.anchors.append(a["href"])
        elif tag in _HEADING_TAGS:
            self._heading_level = int(tag[1])
            self._heading_buf = []
        elif tag == "script":
            t = a.get("type", "").lower()
            if t == "application/ld+json":
                self._in_jsonld = True
                self._jsonld_buf = []
        if tag in _SKIP_TEXT_TAGS:
            self._skip_depth += 1

    def handle_startendtag(self, tag, attrs):
        # void/self-closing forms (e.g. <meta .../>, <img .../>, <link .../>)
        self.handle_starttag(tag, attrs)
        if tag in _SKIP_TEXT_TAGS:
            self._skip_depth -= 1
        if tag in _HEADING_TAGS:
            self._heading_level = 0

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "script":
            if self._in_jsonld:
                self.jsonld_raw.append("".join(self._jsonld_buf))
                self._in_jsonld = False
        elif tag in _HEADING_TAGS and self._heading_level:
            self.headings.append({"level": self._heading_level, "text": "".join(self._heading_buf).strip()})
            self._heading_level = 0
        if tag in _SKIP_TEXT_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._in_title:
            self.title_parts.append(data)
        if self._in_jsonld:
            self._jsonld_buf.append(data)
        if self._heading_level:
            self._heading_buf.append(data)
        if self._skip_depth == 0:
            self._text_parts.append(data)

    def visible_text(self) -> str:
        return " ".join("".join(self._text_parts).split())


def _norm(s):
    return " ".join(s.split()).strip() if s else ""


def _meta_get(metas, *, name=None, prop=None, http_equiv=None):
    for m in metas:
        if name and m.get("name", "").lower() == name.lower():
            return m.get("content", "").strip()
        if prop and m.get("property", "").lower() == prop.lower():
            return m.get("content", "").strip()
        if http_equiv and m.get("http-equiv", "").lower() == http_equiv.lower():
            return m.get("content", "").strip()
    return None


def _raw_anchor_hrefs(html: str) -> list[str]:
    """Best-effort href fallback for badly nested HTML that traps tags in text."""
    return [unescape(next(v for v in m.groups() if v is not None)) for m in _RAW_ANCHOR_HREF_RE.finditer(html or "")]


def extract_fields(html: str, page_url: str, *, status: int = 200,
                   response_time_ms: int = 0, redirect_chain=None,
                   headers=None, fetched_at: str = "") -> dict:
    """Pure extraction of on-page fields from an HTML string."""
    headers = headers or {}
    redirect_chain = redirect_chain or []
    p = _PageParser()
    try:
        p.feed(html or "")
    except Exception:
        pass  # best-effort on malformed markup

    origin = "{0.scheme}://{0.netloc}".format(urlsplit(page_url))

    # canonical / hreflang / icons from <link>
    canonical = None
    hreflangs = []
    for ln in p.links:
        rel = ln.get("rel", "").lower()
        if "canonical" in rel and ln.get("href"):
            canonical = urljoin(page_url, ln["href"].strip())
        if "alternate" in rel and ln.get("hreflang"):
            hreflangs.append({"hreflang": ln["hreflang"].strip(),
                              "href": urljoin(page_url, ln.get("href", "").strip())})

    # links split by origin
    internal, external = [], []
    anchors = p.anchors or _raw_anchor_hrefs(html or "")
    for href in anchors:
        href = href.strip()
        if not href or href.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
            continue
        absu = urljoin(page_url, href)
        sp = urlsplit(absu)
        if sp.scheme not in ("http", "https"):
            continue
        target_origin = "{0.scheme}://{0.netloc}".format(sp)
        (internal if target_origin == origin else external).append(absu)

    # images / alt coverage
    images = [{"src": urljoin(page_url, im["src"].strip()) if im["src"] else "", "alt": im["alt"]}
              for im in p.images]
    missing_alt = sum(1 for im in p.images if im["alt"] is None or not str(im["alt"]).strip())

    # structured data
    jsonld_objs, jsonld_types = [], []
    for raw in p.jsonld_raw:
        try:
            obj = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            continue
        jsonld_objs.append(obj)
        for node in obj if isinstance(obj, list) else [obj]:
            if isinstance(node, dict):
                t = node.get("@type")
                if isinstance(t, list):
                    jsonld_types.extend(str(x) for x in t)
                elif t:
                    jsonld_types.append(str(t))

    meta_charset = next((m.get("charset", "").strip() for m in p.metas if m.get("charset")), None)
    charset = _charset_from_content_type(headers.get("content-type", "")) or meta_charset
    meta_robots = _meta_get(p.metas, name="robots")
    title = _norm("".join(p.title_parts))
    h1s = [h["text"] for h in p.headings if h["level"] == 1]
    heading_order = [h["level"] for h in p.headings]
    text = p.visible_text()
    word_count = len(_WORD_RE.findall(text))

    noindex = bool(meta_robots and "noindex" in meta_robots.lower())
    is_indexable = (status == 200) and not noindex

    return {
        "url": page_url,
        "final_url": page_url,
        "status_code": status,
        "redirect_chain": redirect_chain,
        "response_time_ms": response_time_ms,
        "fetched_at": fetched_at,
        "https": urlsplit(page_url).scheme == "https",
        "content_type": headers.get("content-type", ""),
        "lang": p.html_lang,
        "title": title,
        "title_length": len(title),
        "meta_description": _meta_get(p.metas, name="description"),
        "meta_robots": meta_robots,
        "canonical": canonical,
        "og_title": _meta_get(p.metas, prop="og:title"),
        "og_description": _meta_get(p.metas, prop="og:description"),
        "og_image": _meta_get(p.metas, prop="og:image"),
        "twitter_card": _meta_get(p.metas, name="twitter:card"),
        "viewport": _meta_get(p.metas, name="viewport"),
        "charset": charset,
        "h1s": h1s,
        "h1_count": len(h1s),
        "h2_count": sum(1 for h in p.headings if h["level"] == 2),
        "heading_order": heading_order,
        "word_count": word_count,
        "images_total": len(images),
        "images_missing_alt": missing_alt,
        "images": images[:200],
        "internal_link_count": len(internal),
        "external_link_count": len(external),
        "internal_links": sorted(set(internal))[:500],
        "external_links": sorted(set(external))[:500],
        "has_structured_data": len(jsonld_objs) > 0,
        "structured_data_types": jsonld_types,
        "structured_data": jsonld_objs[:50],
        "hreflang_tags": hreflangs,
        "is_indexable": is_indexable,
        "noindex": noindex,
        "first_paragraph": _first_sentence(text),
        "text_length": len(text),
        "text_sample": text[:20000],
    }


def _first_sentence(text: str, limit: int = 320) -> str:
    t = text.strip()
    return t[:limit]


# ─────────────────────────────────────────────────────────────────────────
# Site-level context (robots.txt) + CLI entry
# ─────────────────────────────────────────────────────────────────────────

def fetch_robots(origin: str, timeout: float, ua: str) -> dict:
    try:
        hop = fetch(urljoin(origin + "/", "robots.txt"), timeout=timeout, ua=ua)
    except (URLSafetyError, OSError, ssl.SSLError) as e:
        return {"status": None, "error": str(e), "exists": False, "sitemaps": [], "text": ""}
    text = hop["html"] if hop["status"] == 200 else ""
    sitemaps = re.findall(r"(?im)^\s*sitemap:\s*(\S+)", text)
    return {"status": hop["status"], "exists": hop["status"] == 200,
            "sitemaps": sitemaps, "text": text[:20000]}


def crawl_file(path: str, base_url: str | None = None) -> dict:
    """Extract fields from a LOCAL HTML file (no fetch) — used by apply mode to
    re-test an edited source file without a running server."""
    fetched_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with open(path, encoding="utf-8", errors="replace") as fh:
        html = fh.read()
    base = base_url or "http://localhost/"
    page = extract_fields(html, base, status=200, fetched_at=fetched_at)
    page["requested_url"] = "file://" + path
    page["source"] = "file"
    origin = "{0.scheme}://{0.netloc}".format(urlsplit(base))
    return {"site": {"origin": origin, "fetched_at": fetched_at, "source": "file"}, "pages": [page]}


def crawl_url(url: str, timeout: float, ua: str, with_robots: bool = True) -> dict:
    fetched_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    hop = fetch(url, timeout=timeout, ua=ua)
    page = extract_fields(
        hop["html"], hop["final_url"], status=hop["status"],
        response_time_ms=hop["response_time_ms"], redirect_chain=hop["redirect_chain"],
        headers=hop["headers"], fetched_at=fetched_at,
    )
    page["requested_url"] = url
    page["truncated"] = hop.get("truncated", False)
    origin = "{0.scheme}://{0.netloc}".format(urlsplit(hop["final_url"]))
    site = {"origin": origin, "fetched_at": fetched_at}
    if with_robots:
        site["robots"] = fetch_robots(origin, timeout, ua)
    return {"site": site, "pages": [page]}


def main(argv):
    ap = argparse.ArgumentParser(prog="seo-crawl")
    ap.add_argument("url", nargs="?", default=None, help="URL to fetch (omit when using --file)")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    ap.add_argument("--user-agent", default=DEFAULT_UA)
    ap.add_argument("--no-robots", action="store_true")
    ap.add_argument("--file", default=None, help="read HTML from a local file instead of fetching")
    ap.add_argument("--base-url", default=None, help="base URL for link resolution with --file")
    ap.add_argument("--out", default=None, help="write full JSON here; stdout then carries a compact summary")
    args = ap.parse_args(argv)
    if args.file:
        data = crawl_file(args.file, args.base_url)
    else:
        if not args.url:
            raise ValueError("provide a URL (or --file <path>)")
        data = crawl_url(args.url, timeout=args.timeout, ua=args.user_agent,
                         with_robots=not args.no_robots)
    result = {"ok": True, "data": data}
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False)
        pg = data["pages"][0]
        return {"ok": True, "out": args.out, "summary": {
            "url": pg["url"], "status_code": pg["status_code"], "title": pg["title"],
            "word_count": pg["word_count"], "is_indexable": pg["is_indexable"],
            "structured_data_types": pg["structured_data_types"],
            "internal_link_count": pg["internal_link_count"]}}
    return result


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except (URLSafetyError, OSError, ssl.SSLError, ValueError) as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False))
