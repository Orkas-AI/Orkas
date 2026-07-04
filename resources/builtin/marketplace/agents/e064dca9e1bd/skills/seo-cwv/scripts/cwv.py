"""seo-cwv — Core Web Vitals via Google PageSpeed Insights (free, no OAuth).

stdlib only. Calls PSI v5 (keyless, or a free key via --key / ORKAS_PAGESPEED_KEY)
and parses BOTH lab (Lighthouse) and field (CrUX real-user) metrics. Field data
is Measured (real users); lab data is Estimated (synthetic). Emits
performance-dimension findings that feed `seo-report --add`.

The target host is the fixed Google API endpoint (not user-controlled), so no
SSRF guard is needed here; urllib's default opener honors HTTP(S)_PROXY.

Thresholds (Google): LCP good ≤2500ms / poor >4000ms · CLS good ≤0.10 / poor
>0.25 · INP good ≤200ms / poor >500ms.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
DEFAULT_TIMEOUT = 60  # PSI runs a synthetic Lighthouse pass; it is slow but single-shot.


def fetch_psi(url: str, strategy: str = "mobile", key: str | None = None,
              timeout: float = DEFAULT_TIMEOUT) -> dict:
    params = [("url", url), ("strategy", strategy), ("category", "performance")]
    if key:
        params.append(("key", key))
    full = PSI_ENDPOINT + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(full, headers={"User-Agent": "OrkasSEOBot/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # default opener → honors proxy env
        return json.loads(resp.read().decode("utf-8", "replace"))


def _audit_ms(lh: dict, audit_id: str):
    a = (lh.get("audits") or {}).get(audit_id) or {}
    v = a.get("numericValue")
    return round(v) if isinstance(v, (int, float)) else None


def _crux(le: dict, metric: str, divide: float = 1.0):
    m = (le.get("metrics") or {}).get(metric) or {}
    p = m.get("percentile")
    if not isinstance(p, (int, float)):
        return None
    return round(p / divide, 3) if divide != 1 else p


def parse_psi(resp: dict, strategy: str) -> dict:
    lh = resp.get("lighthouseResult") or {}
    le = resp.get("loadingExperience") or {}
    score = ((lh.get("categories") or {}).get("performance") or {}).get("score")
    perf = round(score * 100) if isinstance(score, (int, float)) else None

    lab = {
        "lcp_ms": _audit_ms(lh, "largest-contentful-paint"),
        "cls": (lambda v: round(v, 3) if v is not None else None)(
            ((lh.get("audits") or {}).get("cumulative-layout-shift") or {}).get("numericValue")),
        "tbt_ms": _audit_ms(lh, "total-blocking-time"),
        "fcp_ms": _audit_ms(lh, "first-contentful-paint"),
        "si_ms": _audit_ms(lh, "speed-index"),
    }
    field = {
        "lcp_ms": _crux(le, "LARGEST_CONTENTFUL_PAINT_MS"),
        "cls": _crux(le, "CUMULATIVE_LAYOUT_SHIFT_SCORE", divide=100.0),
        "inp_ms": _crux(le, "INTERACTION_TO_NEXT_PAINT_MS") or _crux(le, "INTERACTION_TO_NEXT_PAINT"),
        "fcp_ms": _crux(le, "FIRST_CONTENTFUL_PAINT_MS"),
        "overall_category": le.get("overall_category"),
        "has_field_data": bool(le.get("metrics")),
    }

    findings = _findings(lab, field, perf, strategy)
    return {"strategy": strategy, "performance_score": perf, "lab": lab, "field": field,
            "findings": findings, "summary": {"total": len(findings)},
            "meta": {"url": resp.get("id"), "field_data": field["has_field_data"]}}


def _findings(lab: dict, field: dict, perf, strategy: str) -> list[dict]:
    out = []

    def add(fid, sev, title, evidence, rec, lead, fail, tier):
        out.append({"id": fid, "dimension": "performance", "severity": sev, "title": title,
                    "evidence": evidence, "recommendation": rec, "leading_indicator": lead,
                    "failure_criterion": fail, "data_tier": tier})

    def pick(metric):
        # Prefer the real-user (CrUX) value per metric; fall back to the lab value
        # when that specific metric is absent from field data. A global use_field
        # flag masked a poor lab metric whenever CrUX carried only some metrics.
        fv = field.get(metric)
        if isinstance(fv, (int, float)):
            return fv, "CrUX field ({})".format(strategy), "Measured"
        lv = lab.get(metric)
        if isinstance(lv, (int, float)):
            return lv, "lab ({})".format(strategy), "Estimated"
        return None, None, None

    lcp, src, tier = pick("lcp_ms")
    if lcp is not None:
        if lcp > 4000:
            add("lcp_poor", "high", "LCP is poor", "{}: LCP {}ms".format(src, lcp),
                "Optimize the largest content paint (image/CDN/render-blocking) to ≤2500ms.",
                "LCP ≤2500ms on re-measure", "LCP still >4000ms", tier)
        elif lcp > 2500:
            add("lcp_needs_improve", "medium", "LCP needs improvement", "{}: LCP {}ms".format(src, lcp),
                "Bring LCP to ≤2500ms (preload hero, compress images, reduce TTFB).",
                "LCP ≤2500ms", "LCP still >2500ms", tier)

    cls, src, tier = pick("cls")
    if cls is not None:
        if cls > 0.25:
            add("cls_poor", "high", "CLS is poor", "{}: CLS {}".format(src, cls),
                "Reserve space for images/ads/embeds and avoid layout shifts; target ≤0.10.",
                "CLS ≤0.10", "CLS still >0.25", tier)
        elif cls > 0.10:
            add("cls_needs_improve", "medium", "CLS needs improvement", "{}: CLS {}".format(src, cls),
                "Set explicit dimensions to reduce layout shift; target ≤0.10.",
                "CLS ≤0.10", "CLS still >0.10", tier)

    inp = field["inp_ms"]
    if isinstance(inp, (int, float)):
        if inp > 500:
            add("inp_poor", "high", "INP is poor", "CrUX field: INP {}ms".format(inp),
                "Reduce main-thread work / long tasks to bring INP ≤200ms.",
                "INP ≤200ms", "INP still >500ms", "Measured")
        elif inp > 200:
            add("inp_needs_improve", "medium", "INP needs improvement", "CrUX field: INP {}ms".format(inp),
                "Trim JS execution and input handlers; target INP ≤200ms.",
                "INP ≤200ms", "INP still >200ms", "Measured")

    if isinstance(perf, (int, float)):
        if perf < 50:
            add("perf_score_low", "medium", "Low Lighthouse performance score",
                "lab ({}): performance {}".format(strategy, perf),
                "Address the top Lighthouse opportunities (render-blocking, image size, TBT).",
                "performance score ≥50", "score still <50", "Estimated")
        elif perf < 90:
            add("perf_score_mid", "low", "Performance score below 90",
                "lab ({}): performance {}".format(strategy, perf),
                "Tighten the remaining Lighthouse opportunities toward 90+.",
                "performance score ≥90", "score still <90", "Estimated")
    return out


def main(argv):
    ap = argparse.ArgumentParser(prog="seo-cwv")
    ap.add_argument("url")
    ap.add_argument("--strategy", choices=["mobile", "desktop"], default="mobile")
    ap.add_argument("--key", default=None, help="PageSpeed API key (else ORKAS_PAGESPEED_KEY env)")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)
    key = args.key or os.environ.get("ORKAS_PAGESPEED_KEY")
    resp = fetch_psi(args.url, args.strategy, key, args.timeout)
    if "error" in resp:
        msg = (resp.get("error") or {}).get("message") or "PageSpeed API error"
        raise ValueError(msg)
    result = {"ok": True, "data": parse_psi(resp, args.strategy)}
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False)
    return result


if __name__ == "__main__":
    try:
        out = main(sys.argv[1:])
    except (ValueError, OSError, json.JSONDecodeError) as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(out, ensure_ascii=False))
