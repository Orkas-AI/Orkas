"""SSRF / DNS-rebinding protection for the SEO/GEO crawler (stdlib only).

Clean-room reimplementation of the protection approach in claude-seo's
`scripts/url_safety.py` (MIT). No third-party dependencies.

The threat: a target URL (or a redirect it returns) resolves to a private,
loopback, link-local, or cloud-metadata address, letting an attacker pull
internal data through our fetcher. Defenses, layered:

  1. Scheme allow-list (http / https only).
  2. Reject literal-IP hosts that are not public; reject obfuscated IPv4
     (decimal / hex / octal forms of 127.0.0.1 etc.).
  3. Resolve the hostname and require EVERY resolved address to be public
     unicast — a mixed public/private result is treated as hostile.
  4. Pin the connection to the validated IP (see crawl.py's pinned
     http.client connections) so a second DNS lookup at connect time cannot
     rebind us to a private address.
  5. Re-run the full check on every redirect hop before following it.

Residual limitation: TTL-0 rebinding between getaddrinfo() here and the OS
resolver inside create_connection() is closed by IP pinning at the call
site; this module supplies the pinned IP, the caller must use it.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlsplit, urlunsplit


class URLSafetyError(Exception):
    """Raised when a URL fails an SSRF/scheme/host safety check."""


_ALLOWED_SCHEMES = ("http", "https")
_DEFAULT_PORT = {"http": 80, "https": 443}

# Obfuscated IPv4 literals (decimal int, hex, octal, or mixed dotted) are a
# classic SSRF bypass. We don't try to decode every form; we flag hosts that
# look like a bare number / hex blob and let socket.inet_aton canonicalize.
_BARE_NUMBER_RE = re.compile(r"^(0x[0-9a-fA-F]+|[0-9]+)$")


def is_safe_ip(ip_str: str) -> bool:
    """True iff `ip_str` is a public unicast IPv4/IPv6 address.

    Rejects private, loopback, link-local (incl. 169.254.169.254 cloud
    metadata), multicast, reserved, and unspecified ranges.
    """
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    if (ip.is_private or ip.is_loopback or ip.is_link_local
            or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
        return False
    # IPv4-mapped / 6to4 / Teredo can smuggle a private v4 inside a v6 host.
    if isinstance(ip, ipaddress.IPv6Address):
        embedded = ip.ipv4_mapped or ip.sixtofour
        teredo = ip.teredo  # (server, client) tuple or None
        if teredo:
            embedded = embedded or teredo[1]
        if embedded is not None and not is_safe_ip(str(embedded)):
            return False
    return True


def _canonical_ipv4(host: str) -> str | None:
    """If `host` is an IPv4 literal in any (incl. obfuscated) form, return the
    canonical dotted-quad; else None. Uses inet_aton, which accepts decimal,
    hex, octal, and short dotted forms — the exact bypass surface we must
    canonicalize before range-checking."""
    if _BARE_NUMBER_RE.match(host) or host.count(".") <= 3:
        try:
            packed = socket.inet_aton(host)
        except OSError:
            return None
        return socket.inet_ntoa(packed)
    return None


def normalize_hostname(host: str) -> str:
    """Lowercase, strip a trailing FQDN dot and surrounding IPv6 brackets."""
    h = host.strip().lower()
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    if h.endswith(".") and not h.endswith(".."):
        h = h[:-1]
    return h


def _resolve_all(host: str, port: int) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise URLSafetyError(f"DNS resolution failed for {host!r}: {e}") from e
    addrs = []
    for info in infos:
        ip = info[4][0]
        if ip not in addrs:
            addrs.append(ip)
    if not addrs:
        raise URLSafetyError(f"no addresses resolved for {host!r}")
    return addrs


def parse_and_check_scheme(url: str) -> tuple[str, str, str, int, str | None]:
    """Validate scheme/host/port and check any literal-IP host WITHOUT DNS.

    Returns (normalized_url, scheme, host, port, literal_ip_or_None). The
    no-DNS split lets the proxy fetch path (proxy resolves the target) skip
    local DNS — which in fake-ip proxy environments returns a reserved
    198.18.0.0/15 address that would otherwise be rejected here.
    """
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    if scheme not in _ALLOWED_SCHEMES:
        raise URLSafetyError(f"scheme {scheme!r} not allowed (http/https only)")
    host = normalize_hostname(parts.hostname or "")
    if not host:
        raise URLSafetyError("URL has no host")
    port = parts.port or _DEFAULT_PORT[scheme]
    if not (0 < port < 65536):
        raise URLSafetyError(f"invalid port {port}")

    canon_v4 = _canonical_ipv4(host)
    literal_ip = canon_v4 or (host if _is_ip_literal(host) else None)
    if literal_ip is not None and not is_safe_ip(literal_ip):
        raise URLSafetyError(f"host resolves to non-public address {literal_ip}")

    normalized = urlunsplit((scheme, parts.netloc, parts.path or "/", parts.query, ""))
    return normalized, scheme, host, port, literal_ip


def resolve_and_pin(host: str, port: int) -> str:
    """Resolve `host` and require EVERY address be public; return the pinned IP.
    Direct (no-proxy) fetch path only. Raises URLSafetyError on any private hit."""
    addrs = _resolve_all(host, port)
    for ip in addrs:
        if not is_safe_ip(ip):
            raise URLSafetyError(
                f"host {host!r} resolves to non-public address {ip} "
                "(possible SSRF / DNS-rebinding)"
            )
    return addrs[0]


# Fake-ip placeholder range used by Clash/Surge etc. Local DNS returns these
# (non-routable) addresses; only the proxy knows the real target, so we cannot
# validate them locally and must trust the proxy for hosts that resolve here.
_FAKEIP_NET = ipaddress.ip_network("198.18.0.0/15")


def assert_proxy_target_safe(host: str, port: int) -> None:
    """Best-effort SSRF check for the PROXY path (the proxy, not us, resolves
    the target). If local DNS resolves the host to a private/loopback/metadata
    address that is NOT a fake-ip placeholder, treat it as a likely internal
    SSRF attempt and refuse. Unresolvable-locally or fake-ip → trust the proxy.
    No-op for hosts that resolve to public IPs."""
    try:
        addrs = _resolve_all(host, port)
    except URLSafetyError:
        return  # can't resolve locally (e.g. fake-ip-only) → proxy resolves it
    for ip in addrs:
        if is_safe_ip(ip):
            continue
        try:
            if ipaddress.ip_address(ip) in _FAKEIP_NET:
                continue  # fake-ip placeholder; cannot validate, trust the proxy
        except ValueError:
            continue
        raise URLSafetyError(
            f"proxy target {host!r} resolves to non-public {ip} "
            "(likely internal SSRF); refusing"
        )


def validate_url_strict(url: str) -> tuple[str, str, int, str]:
    """Validate scheme + host and resolve to a pinned public IP (direct path).

    Returns (normalized_url, pinned_ip, port, host).
    """
    normalized, scheme, host, port, literal_ip = parse_and_check_scheme(url)
    pinned = literal_ip if literal_ip is not None else resolve_and_pin(host, port)
    return normalized, pinned, port, host


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False
