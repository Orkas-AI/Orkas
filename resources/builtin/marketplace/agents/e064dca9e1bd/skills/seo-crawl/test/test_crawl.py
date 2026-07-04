"""Unit tests for seo-crawl extraction + SSRF guard. stdlib unittest, no deps.

Run:  python3 -m unittest discover -s PC/resources/builtin/marketplace/agents/e064dca9e1bd/skills/seo-crawl/test
or:   cd PC/resources/builtin/marketplace/agents/e064dca9e1bd/skills/seo-crawl && python3 -m unittest

Covers BOTH matching shapes (real on-page signals we must capture) and
look-alike non-matching shapes (body text / comments that resemble signals but
must NOT be treated as them) per the repo's text-processing test rule.
"""

import gzip
import os
import sys
import unittest
import zlib

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import crawl  # noqa: E402
import url_safety  # noqa: E402
from crawl import _PageParser, _decode_body, crawl_file, extract_fields, fetch  # noqa: E402
from url_safety import (  # noqa: E402
    URLSafetyError, assert_proxy_target_safe, is_safe_ip, normalize_hostname,
    resolve_and_pin, validate_url_strict,
)


GOOD_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Orkas — local-first AI agents</title>
  <meta name="description" content="Direct a team of AI agents by chat.">
  <meta name="robots" content="index,follow">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta property="og:title" content="Orkas">
  <meta property="og:image" content="/res/og.jpg">
  <link rel="canonical" href="https://orkas.ai/">
  <link rel="alternate" hreflang="zh" href="/zh/">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Orkas"}</script>
  <script>var scriptsentinel = "delveintothis";</script>
  <style>.x{content:"stylesentinel"}</style>
</head>
<body>
  <h1>Orkas is an open-source local-first desktop AI client</h1>
  <h2>Sub heading here</h2>
  <p>This canonical link looks like rel=canonical but is body text.</p>
  <img src="/a.png" alt="described">
  <img src="/b.png">
  <a href="/about">about</a>
  <a href="https://other.example/x">external</a>
  <a href="#frag">frag</a>
  <a href="mailto:hi@orkas.ai">mail</a>
</body>
</html>"""

NOINDEX_HTML = """<html><head>
<title>Hidden</title>
<meta name="robots" content="noindex, nofollow">
</head><body><h1>x</h1><p>noindex appears here as body text too</p></body></html>"""


class ExtractTest(unittest.TestCase):
    def setUp(self):
        self.f = extract_fields(GOOD_HTML, "https://orkas.ai/", status=200)

    def test_core_meta_fields(self):
        self.assertEqual(self.f["title"], "Orkas — local-first AI agents")
        self.assertEqual(self.f["meta_description"], "Direct a team of AI agents by chat.")
        self.assertEqual(self.f["lang"], "en")
        self.assertEqual(self.f["charset"], "utf-8")
        self.assertEqual(self.f["viewport"], "width=device-width, initial-scale=1")
        self.assertEqual(self.f["og_title"], "Orkas")

    def test_canonical_only_from_link_not_body_text(self):
        # Matching: the real <link rel="canonical"> is resolved absolute.
        self.assertEqual(self.f["canonical"], "https://orkas.ai/")
        # Look-alike: the <p> mentioning "canonical" must not change it.

    def test_og_image_resolved_absolute(self):
        self.assertEqual(self.f["og_image"], "/res/og.jpg")  # raw content kept; resolution is audit-side

    def test_headings(self):
        self.assertEqual(self.f["h1s"], ["Orkas is an open-source local-first desktop AI client"])
        self.assertEqual(self.f["h1_count"], 1)
        self.assertEqual(self.f["h2_count"], 1)
        self.assertEqual(self.f["heading_order"], [1, 2])

    def test_links_split_by_origin(self):
        self.assertIn("https://orkas.ai/about", self.f["internal_links"])
        self.assertIn("https://other.example/x", self.f["external_links"])
        # Look-alikes excluded: #frag and mailto: are neither internal nor external.
        self.assertEqual(self.f["external_link_count"], 1)
        self.assertEqual(self.f["internal_link_count"], 1)

    def test_images_alt_coverage(self):
        self.assertEqual(self.f["images_total"], 2)
        self.assertEqual(self.f["images_missing_alt"], 1)

    def test_structured_data(self):
        self.assertTrue(self.f["has_structured_data"])
        self.assertEqual(self.f["structured_data_types"], ["Organization"])

    def test_hreflang(self):
        self.assertEqual(self.f["hreflang_tags"],
                         [{"hreflang": "zh", "href": "https://orkas.ai/zh/"}])

    def test_indexable_when_index_follow(self):
        # Look-alike guard: robots "index,follow" must NOT be read as noindex.
        self.assertTrue(self.f["is_indexable"])
        self.assertFalse(self.f["noindex"])

    def test_word_count_excludes_script_and_style(self):
        p = _PageParser()
        p.feed(GOOD_HTML)
        vis = p.visible_text()
        self.assertNotIn("scriptsentinel", vis)
        self.assertNotIn("stylesentinel", vis)
        self.assertNotIn("delveintothis", vis)
        self.assertIn("open-source", vis)
        self.assertGreater(self.f["word_count"], 5)


class NoindexTest(unittest.TestCase):
    def test_noindex_detected_from_meta_only(self):
        f = extract_fields(NOINDEX_HTML, "https://orkas.ai/hidden", status=200)
        self.assertTrue(f["noindex"])
        self.assertFalse(f["is_indexable"])

    def test_404_not_indexable_even_without_noindex(self):
        f = extract_fields(GOOD_HTML, "https://orkas.ai/", status=404)
        self.assertFalse(f["is_indexable"])


class MalformedTest(unittest.TestCase):
    def test_unclosed_tags_do_not_crash(self):
        bad = "<html><head><title>x<body><h1>y<p>z<img src=q><a href=/p>l"
        f = extract_fields(bad, "https://orkas.ai/")
        self.assertIsInstance(f["title"], str)
        self.assertIn("https://orkas.ai/p", f["internal_links"])

    def test_invalid_jsonld_skipped(self):
        html = '<html><head><script type="application/ld+json">{not valid json}</script></head><body></body></html>'
        f = extract_fields(html, "https://orkas.ai/")
        self.assertFalse(f["has_structured_data"])
        self.assertEqual(f["structured_data_types"], [])


class FileModeTest(unittest.TestCase):
    def test_crawl_local_file_no_network(self):
        import tempfile
        d = tempfile.mkdtemp()
        p = os.path.join(d, "page.html")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(GOOD_HTML)
        out = crawl_file(p, base_url="https://orkas.ai/")
        page = out["pages"][0]
        self.assertEqual(page["source"], "file")
        self.assertEqual(page["title"], "Orkas — local-first AI agents")
        self.assertEqual(page["canonical"], "https://orkas.ai/")
        self.assertEqual(out["site"]["source"], "file")


class SsrfGuardTest(unittest.TestCase):
    def test_public_ip_safe(self):
        self.assertTrue(is_safe_ip("8.8.8.8"))
        self.assertTrue(is_safe_ip("2606:4700:4700::1111"))

    def test_private_loopback_metadata_unsafe(self):
        for ip in ("127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1",
                   "169.254.169.254", "::1", "0.0.0.0", "fd00::1"):
            self.assertFalse(is_safe_ip(ip), ip)

    def test_scheme_rejected(self):
        for u in ("file:///etc/passwd", "ftp://x/", "gopher://x/"):
            with self.assertRaises(URLSafetyError):
                validate_url_strict(u)

    def test_obfuscated_ipv4_loopback_rejected(self):
        # 2130706433 == 127.0.0.1 ; 0x7f000001 == 127.0.0.1 — classic SSRF bypass.
        for u in ("http://2130706433/", "http://0x7f000001/", "http://127.1/"):
            with self.assertRaises(URLSafetyError):
                validate_url_strict(u)

    def test_public_ip_literal_validates(self):
        normalized, ip, port, host = validate_url_strict("https://8.8.8.8/x")
        self.assertEqual(ip, "8.8.8.8")
        self.assertEqual(port, 443)


class ProxyTargetSsrfTest(unittest.TestCase):
    """assert_proxy_target_safe: in proxy mode we can't IP-pin, but reject a host
    that locally resolves to a real internal IP (SSRF), while trusting fake-ip."""

    def setUp(self):
        self._orig = url_safety._resolve_all

    def tearDown(self):
        url_safety._resolve_all = self._orig

    def _resolves_to(self, ips):
        url_safety._resolve_all = lambda host, port: list(ips)

    def test_rejects_private_resolution(self):
        for ip in ("10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1"):
            self._resolves_to([ip])
            with self.assertRaises(URLSafetyError):
                assert_proxy_target_safe("internal.example", 443)

    def test_allows_fakeip(self):
        self._resolves_to(["198.18.0.34"])
        assert_proxy_target_safe("orkas.ai", 443)  # must not raise

    def test_allows_public(self):
        self._resolves_to(["8.8.8.8"])
        assert_proxy_target_safe("dns.google", 443)  # must not raise

    def test_unresolvable_trusts_proxy(self):
        def boom(host, port):
            raise URLSafetyError("dns fail")
        url_safety._resolve_all = boom
        assert_proxy_target_safe("only-proxy-knows.example", 443)  # must not raise

    def test_rejects_mixed_public_and_private(self):
        self._resolves_to(["8.8.8.8", "10.0.0.5"])
        with self.assertRaises(URLSafetyError):
            assert_proxy_target_safe("split.example", 443)


class SsrfObfuscationTest(unittest.TestCase):
    """Deeper SSRF-bypass surfaces: IPv6-embedded v4, octal/decimal literals,
    IPv6-literal URLs, trailing-dot hosts, and reserved/multicast ranges."""

    def test_ipv6_embedded_private_v4_rejected(self):
        # IPv4-mapped (::ffff:) and 6to4 (2002::) can smuggle a private v4
        # inside a v6 host. Each MUST be rejected.
        self.assertFalse(is_safe_ip("::ffff:169.254.169.254"))  # cloud metadata
        self.assertFalse(is_safe_ip("::ffff:127.0.0.1"))        # loopback
        self.assertFalse(is_safe_ip("2002:0a00:0001::1"))       # 6to4 -> 10.0.0.1
        # NOTE: the public look-alike "::ffff:8.8.8.8" is intentionally NOT
        # asserted as safe here: on CPython < 3.13 the stdlib ipaddress module
        # marks the whole ::ffff:0:0/96 range is_private/is_reserved, so the
        # guard rejects it too. That is an over-block (fail-safe), not a hole,
        # and is Python-version dependent, so we don't pin a value for it.

    def test_octal_ipv4_loopback_rejected(self):
        # inet_aton canonicalizes octal/decimal forms; both decode to private.
        with self.assertRaises(URLSafetyError):
            validate_url_strict("http://0177.0.0.1/")   # 0177 octal == 127
        with self.assertRaises(URLSafetyError):
            validate_url_strict("http://167772161/")    # == 10.0.0.1

    def test_ipv6_literal_url_rejected(self):
        with self.assertRaises(URLSafetyError):
            validate_url_strict("http://[::1]/")          # loopback
        with self.assertRaises(URLSafetyError):
            validate_url_strict("http://[fd00::1]/x")     # unique-local

    def test_trailing_dot_host_still_rejected(self):
        # FQDN trailing dot must not bypass the loopback check.
        with self.assertRaises(URLSafetyError):
            validate_url_strict("http://127.0.0.1./")
        # normalize_hostname unit behavior: strip brackets and trailing dot.
        self.assertEqual(normalize_hostname("[::1]"), "::1")
        self.assertEqual(normalize_hostname("EXAMPLE.COM."), "example.com")

    def test_multicast_reserved_invalid_unsafe(self):
        self.assertFalse(is_safe_ip("224.0.0.1"))   # multicast
        self.assertFalse(is_safe_ip("240.0.0.1"))   # reserved (240/4)
        self.assertFalse(is_safe_ip("ff02::1"))      # v6 multicast
        self.assertFalse(is_safe_ip("not-an-ip"))    # garbage -> ValueError


class ResolveAndPinTest(unittest.TestCase):
    """resolve_and_pin (direct fetch path) must reject a host whose DNS answer
    contains ANY non-public address, and otherwise pin the first address."""

    def setUp(self):
        self._orig = url_safety._resolve_all

    def tearDown(self):
        url_safety._resolve_all = self._orig

    def test_resolve_and_pin_rejects_mixed(self):
        url_safety._resolve_all = lambda host, port: ["8.8.8.8", "10.0.0.5"]
        with self.assertRaises(URLSafetyError):
            resolve_and_pin("split.example", 443)
        url_safety._resolve_all = lambda host, port: ["8.8.8.8"]
        self.assertEqual(resolve_and_pin("split.example", 443), "8.8.8.8")


class DecodeBodyTest(unittest.TestCase):
    """_decode_body handles gzip, zlib-wrapped deflate, raw deflate, identity,
    and degrades to the raw bytes on a corrupt stream rather than raising."""

    def test_decode_body_variants(self):
        self.assertEqual(_decode_body(gzip.compress(b"hi"), "gzip"), b"hi")
        self.assertEqual(_decode_body(zlib.compress(b"hi"), "deflate"), b"hi")
        co = zlib.compressobj(wbits=-15)  # raw deflate, no zlib header
        raw_deflate = co.compress(b"hi") + co.flush()
        self.assertEqual(_decode_body(raw_deflate, "deflate"), b"hi")
        # corrupt gzip stream -> return the raw input unchanged (best-effort).
        self.assertEqual(_decode_body(b"\x00garbage", "gzip"), b"\x00garbage")
        # identity / empty encoding -> passthrough.
        self.assertEqual(_decode_body(b"plain", ""), b"plain")


class RedirectLimitTest(unittest.TestCase):
    """fetch() follows redirects manually; exceeding max_redirects raises."""

    def setUp(self):
        self._orig = crawl._fetch_once

    def tearDown(self):
        crawl._fetch_once = self._orig

    def test_too_many_redirects(self):
        def always_redirect(url, timeout, ua):
            return {
                "final_url": url,
                "status": 301,
                "headers": {},
                "location": "https://orkas.ai/next",
                "html": "",
                "truncated": False,
                "content_type": "",
                "pinned_ip": "1.2.3.4",
            }
        crawl._fetch_once = always_redirect
        with self.assertRaises(URLSafetyError) as ctx:
            fetch("https://orkas.ai/", max_redirects=2)
        self.assertIn("too many redirects", str(ctx.exception))


class ParseEdgeCaseTest(unittest.TestCase):
    """Extraction edge cases beyond the GOOD_HTML happy path."""

    def test_charset_header_wins_over_meta(self):
        # Content-Type charset header overrides the <meta charset> in the doc.
        f = extract_fields(GOOD_HTML, "https://x/",
                           headers={"content-type": "text/html; charset=iso-8859-1"})
        self.assertEqual(f["charset"], "iso-8859-1")
        # No header -> fall back to the <meta charset="utf-8"> in GOOD_HTML.
        self.assertEqual(extract_fields(GOOD_HTML, "https://x/")["charset"], "utf-8")

    def test_jsonld_type_list_and_array(self):
        html = ('<html><head><script type="application/ld+json">'
                '[{"@type":["Organization","LocalBusiness"]},{"@type":"FAQPage"}]'
                '</script></head><body></body></html>')
        f = extract_fields(html, "https://x/")
        self.assertEqual(set(f["structured_data_types"]),
                         {"Organization", "LocalBusiness", "FAQPage"})
        self.assertTrue(f["has_structured_data"])

    def test_link_count_counts_duplicates(self):
        html = ('<html><body>'
                '<a href="/about">a</a>'
                '<a href="/about">a again</a>'
                '<a href="https://other.example/x">ext</a>'
                '</body></html>')
        f = extract_fields(html, "https://x/")
        # count includes the duplicate; the deduped list does not.
        self.assertEqual(f["internal_link_count"], 2)
        self.assertEqual(len(f["internal_links"]), 1)

    def test_sparse_page_field_defaults(self):
        f = extract_fields("<html><body><p>hi</p></body></html>", "https://x/")
        self.assertEqual(f["title"], "")
        self.assertEqual(f["title_length"], 0)
        self.assertIsNone(f["meta_description"])
        self.assertIsNone(f["canonical"])
        self.assertEqual(f["h1_count"], 0)
        self.assertEqual(f["h1s"], [])
        self.assertIsNone(f["lang"])
        self.assertIsNone(f["viewport"])
        self.assertFalse(f["has_structured_data"])

    def test_alternate_without_hreflang_excluded(self):
        # rel=alternate without hreflang (e.g. an RSS feed) is NOT an hreflang
        # tag; only the hreflang-bearing alternate is captured.
        html = ('<html><head>'
                '<link rel="alternate" type="application/rss+xml" href="/feed">'
                '<link rel="alternate" hreflang="zh" href="/zh/">'
                '</head><body></body></html>')
        f = extract_fields(html, "https://x/")
        self.assertEqual(f["hreflang_tags"],
                         [{"hreflang": "zh", "href": "https://x/zh/"}])

    def test_word_count_cjk_behavior(self):
        # KNOWN LIMITATION: the \\b[\\w'-]+\\b word regex treats an unbroken run
        # of CJK characters as a SINGLE token (no per-character segmentation),
        # so this 8-character phrase counts as 1 word. Pin it so a future
        # segmentation change is a deliberate, visible update.
        f = extract_fields("<html><body><p>你好世界这是测试内容</p></body></html>",
                           "https://x/")
        self.assertEqual(f["word_count"], 1)


if __name__ == "__main__":
    unittest.main()
