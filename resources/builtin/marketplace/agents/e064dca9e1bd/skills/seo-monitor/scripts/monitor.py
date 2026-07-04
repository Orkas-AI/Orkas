"""seo-monitor — baseline snapshot + drift comparison.

stdlib only. Two ops:
  snapshot  — distill a seo-crawl JSON (+ optional health/geo scores) into a
              compact, comparable baseline snapshot (content hash + key fields).
  compare   — diff a current snapshot against a baseline and emit drift
              findings (regressions / changes), severity-ranked.

Clean-room of claude-seo's drift rule engine. Deterministic; the same two
snapshots always produce the same findings (so monitoring runs are stable).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys

_SEV_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}


def _data_page(crawl_obj: dict) -> tuple[dict, dict]:
    data = crawl_obj.get("data", crawl_obj) if isinstance(crawl_obj, dict) else {}
    pages = data.get("pages") or []
    if not pages:
        raise ValueError("crawl JSON has no pages")
    return pages[0], (data.get("site") or {})


def _aggregate_gsc(gsc_obj) -> dict | None:
    """Distill a Google Search Console `query_search_analytics` result into compact totals.

    Accepts the `gsearch-console` adapter output (`{rows:[{keys,clicks,impressions,ctr,position}],
    startDate, endDate, ...}`), a `{ok, data: ...}` envelope, or a bare list of rows. Position is
    impression-weighted (GSC's own averaging semantics) so a low-impression row cannot swing it.

    Returns None when there are no usable rows / zero impressions, so a freshly-connected property
    with no data does not fabricate an all-zero baseline that would later look like a regression.
    """
    if isinstance(gsc_obj, dict):
        gsc_obj = gsc_obj.get("data", gsc_obj)
    if isinstance(gsc_obj, dict):
        rows = gsc_obj.get("rows") or []
        start, end = gsc_obj.get("startDate"), gsc_obj.get("endDate")
    elif isinstance(gsc_obj, list):
        rows, start, end = gsc_obj, None, None
    else:
        return None
    clicks = imps = pos_sum = pos_weight = 0.0
    for r in rows:
        if not isinstance(r, dict):
            continue
        i = float(r.get("impressions") or 0)
        clicks += float(r.get("clicks") or 0)
        imps += i
        p = r.get("position")
        if isinstance(p, (int, float)) and i > 0:
            pos_sum += float(p) * i
            pos_weight += i
    if not rows or imps <= 0:
        return None
    return {
        "clicks": int(round(clicks)),
        "impressions": int(round(imps)),
        "ctr": round(clicks / imps, 4),
        "position": round(pos_sum / pos_weight, 2) if pos_weight else None,
        "rows": len(rows),
        "start": start,
        "end": end,
    }


def _aggregate_bing(bing_obj) -> dict | None:
    """Distill Bing Webmaster rows (GetPageStats / GetQueryStats output, via the bing-webmaster
    adapter) into the same compact totals as _aggregate_gsc. Bing uses capitalized field names
    (Clicks / Impressions / AvgImpressionPosition); position is impression-weighted. Returns None
    when there are no usable rows / zero impressions."""
    if isinstance(bing_obj, dict):
        bing_obj = bing_obj.get("data", bing_obj)
    if isinstance(bing_obj, dict):
        rows = bing_obj.get("rows") or []
    elif isinstance(bing_obj, list):
        rows = bing_obj
    else:
        return None
    clicks = imps = pos_sum = pos_weight = 0.0
    for r in rows:
        if not isinstance(r, dict):
            continue
        i = float(r.get("Impressions", r.get("impressions", 0)) or 0)
        clicks += float(r.get("Clicks", r.get("clicks", 0)) or 0)
        imps += i
        p = r.get("AvgImpressionPosition", r.get("AvgClickPosition"))
        if isinstance(p, (int, float)) and i > 0:
            pos_sum += float(p) * i
            pos_weight += i
    if not rows or imps <= 0:
        return None
    return {
        "clicks": int(round(clicks)),
        "impressions": int(round(imps)),
        "ctr": round(clicks / imps, 4),
        "position": round(pos_sum / pos_weight, 2) if pos_weight else None,
        "rows": len(rows),
    }


def make_snapshot(crawl_obj: dict, health: float | None = None, geo: float | None = None,
                  gsc=None, bing=None) -> dict:
    page, site = _data_page(crawl_obj)
    text = page.get("text_sample") or ""
    return {
        "url": page.get("url"),
        "fetched_at": site.get("fetched_at") or page.get("fetched_at"),
        "status_code": page.get("status_code"),
        "title": page.get("title"),
        "meta_description": page.get("meta_description"),
        "canonical": page.get("canonical"),
        "noindex": bool(page.get("noindex")),
        "is_indexable": bool(page.get("is_indexable", True)),
        "h1s": page.get("h1s") or [],
        "h2_count": page.get("h2_count", 0),
        "og_title": page.get("og_title"),
        "og_image": page.get("og_image"),
        "structured_data_types": sorted(page.get("structured_data_types") or []),
        "word_count": page.get("word_count", 0),
        "content_hash": hashlib.sha256(text.encode("utf-8", "replace")).hexdigest(),
        "health_score": health,
        "geo_score": geo,
        # Real Search Console performance for this URL, when the agent supplied it. None when GSC
        # is not connected / has no data — drift rules below only fire when BOTH sides carry it.
        "gsc": _aggregate_gsc(gsc) if gsc is not None else None,
        # Bing Webmaster performance for this URL (same idea; the Bing index powers ChatGPT/Copilot).
        "bing": _aggregate_bing(bing) if bing is not None else None,
    }


def _sim(a: str, b: str) -> float:
    """Cheap token Jaccard similarity for H1/title change magnitude."""
    ta, tb = set((a or "").lower().split()), set((b or "").lower().split())
    if not ta and not tb:
        return 1.0
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _search_perf_drift(source, label, b_perf, c_perf, add, with_position=True):
    """Drift rules for a search-performance source (GSC / Bing). Same thresholds for both — only
    the finding-id prefix (`{source}_*`), the human label, and which snapshot field feeds in
    differ. Fires only when BOTH snapshots carry the source's aggregate; traffic deltas are
    floored on the baseline sample so a near-zero-traffic page (a 1→0 swing = -100%) cannot
    manufacture a regression. `with_position=False` skips the position rule — Bing's average-
    position scale is ambiguous, but its click/impression COUNTS are unambiguous."""
    if not (isinstance(b_perf, dict) and isinstance(c_perf, dict)):
        return
    bi, ci = b_perf.get("impressions") or 0, c_perf.get("impressions") or 0
    bc, cc = b_perf.get("clicks") or 0, c_perf.get("clicks") or 0
    if bi >= 50 and ci < bi * 0.7:
        add(f"{source}_impressions_dropped", "high" if ci < bi * 0.5 else "medium",
            f"Search impressions dropped ({label})", bi, ci,
            "Investigate lost visibility — a ranking slip, deindexing, or seasonality.",
            "impressions recover toward baseline", "impressions stay down")
    if bc >= 20 and cc < bc * 0.7:
        add(f"{source}_clicks_dropped", "high" if cc < bc * 0.5 else "medium",
            f"Search clicks dropped ({label})", bc, cc,
            "Check ranking/CTR — a title or snippet regression, or a position slip.",
            "clicks recover toward baseline", "clicks stay down")
    if not with_position:
        return
    bp, cp = b_perf.get("position"), c_perf.get("position")
    # Position is 1-based and lower is better, so a larger average position is a real slip.
    if isinstance(bp, (int, float)) and isinstance(cp, (int, float)) and bi >= 20 and cp - bp >= 1.5:
        add(f"{source}_position_worsened", "high" if cp - bp >= 3 else "medium",
            f"Average search position worsened ({label})", bp, cp,
            "A ranking slip — review content freshness, competition, and on-page targeting.",
            "average position improves toward baseline", "average position stays worse")


def compare(baseline: dict, current: dict) -> dict:
    findings: list[dict] = []

    def add(fid, sev, title, before, after, rec, lead, fail):
        findings.append({"id": fid, "dimension": "drift", "severity": sev, "title": title,
                         "evidence": "before={!r} → after={!r}".format(before, after),
                         "recommendation": rec, "leading_indicator": lead,
                         "failure_criterion": fail, "data_tier": "Measured"})

    b, c = baseline, current
    # status / indexability
    if b.get("status_code") == 200 and (c.get("status_code") or 0) >= 400:
        add("status_code_error", "critical", "Page went from 200 to an error",
            b.get("status_code"), c.get("status_code"),
            "Restore a 200 response for this live URL.", "page returns 200 again", "still erroring")
    if not b.get("noindex") and c.get("noindex"):
        add("noindex_added", "critical", "noindex was added",
            False, True, "Remove the noindex if this page should stay indexed.",
            "noindex removed; page re-eligible", "still noindex")
    if b.get("is_indexable") and not c.get("is_indexable"):
        add("indexability_lost", "critical", "Page is no longer indexable",
            True, False, "Investigate what made the page non-indexable.",
            "indexable again", "still blocked")
    # schema
    bt, ct = b.get("structured_data_types") or [], c.get("structured_data_types") or []
    if bt and not ct:
        add("schema_removed", "critical", "All structured data was removed",
            bt, ct, "Restore the JSON-LD; lost markup loses rich-result/citation eligibility.",
            "structured data restored", "still absent")
    elif "structured_data_types" in b and bt != ct and ct:
        add("schema_modified", "low", "Structured-data types changed",
            bt, ct, "Confirm the schema change is intentional and matches the page.",
            "schema types match intent", "unintended schema change persists")
    # canonical
    if b.get("canonical") and not c.get("canonical"):
        add("canonical_removed", "high", "Canonical was removed",
            b.get("canonical"), None, "Restore a self-referential canonical.",
            "canonical present again", "still missing")
    elif "canonical" in b and b.get("canonical") != c.get("canonical"):
        add("canonical_changed", "high", "Canonical URL changed",
            b.get("canonical"), c.get("canonical"), "Confirm the new canonical is intended.",
            "canonical resolves as intended", "unintended canonical persists")
    # title
    if b.get("title") and not c.get("title"):
        add("title_removed", "high", "Title was removed", b.get("title"), None,
            "Restore the <title>.", "title present again", "still missing")
    elif "title" in b and b.get("title") != c.get("title"):
        add("title_changed", "medium", "Title changed", b.get("title"), c.get("title"),
            "Confirm the title change is intended and still targets the query.",
            "title change is intentional", "unintended title regression")
    # meta description
    if "meta_description" in b and (b.get("meta_description") or "") != (c.get("meta_description") or ""):
        add("meta_description_changed", "low", "Meta description changed",
            b.get("meta_description"), c.get("meta_description"),
            "Confirm the new description reads well as a snippet.", "snippet still good", "regressed")
    # H1
    bh1, ch1 = " ".join(b.get("h1s") or []), " ".join(c.get("h1s") or [])
    if bh1 and not ch1:
        add("h1_removed", "high", "H1 was removed", bh1, None, "Restore a single descriptive H1.",
            "H1 present again", "still missing")
    elif bh1 and ch1 and _sim(bh1, ch1) < 0.5:
        add("h1_changed", "medium", "H1 changed significantly", bh1, ch1,
            "Confirm the H1 change is intended.", "H1 still on-topic", "unintended H1 change")
    # OG
    for k, lbl in (("og_title", "og:title"), ("og_image", "og:image")):
        if b.get(k) and not c.get(k):
            add("og_removed", "low", "{} was removed".format(lbl), b.get(k), None,
                "Restore the Open Graph tag for social/citation cards.", "tag restored", "still missing")
    # structure / content
    if (b.get("h2_count") or 0) - (c.get("h2_count") or 0) >= 3:
        add("h2_structure_changed", "low", "H2 sections dropped sharply",
            b.get("h2_count"), c.get("h2_count"), "Confirm the structure change is intended.",
            "structure intentional", "unintended loss of sections")
    bw, cw = b.get("word_count") or 0, c.get("word_count") or 0
    if bw and cw < bw * 0.6:
        add("word_count_dropped", "medium", "Content shrank >40%",
            bw, cw, "Confirm the content reduction is intended; large losses hurt ranking/citation.",
            "content restored or change intentional", "unintended content loss persists")
    if "content_hash" in b and b.get("content_hash") != c.get("content_hash"):
        add("content_hash_changed", "info", "Page content changed",
            (b.get("content_hash") or "")[:12], (c.get("content_hash") or "")[:12],
            "Informational — verify the change is intended.", "n/a", "n/a")
    # scores
    bh, chs = b.get("health_score"), c.get("health_score")
    if isinstance(bh, (int, float)) and isinstance(chs, (int, float)) and bh - chs >= 10:
        add("health_regressed", "high" if bh - chs >= 20 else "medium",
            "SEO health regressed", bh, chs, "Investigate the new findings driving the drop.",
            "health recovers to baseline", "health stays down")
    bg, cg = b.get("geo_score"), c.get("geo_score")
    if isinstance(bg, (int, float)) and isinstance(cg, (int, float)) and bg - cg >= 10:
        add("geo_regressed", "medium", "GEO score regressed", bg, cg,
            "Investigate the GEO dimension that dropped.", "GEO recovers", "GEO stays down")
    # Real search-performance drift (Measured) from connected search consoles, when the agent
    # captured them. GSC carries a trustworthy 1-based position so it drifts position too; Bing's
    # average-position scale is ambiguous, so only its click/impression counts drift.
    _search_perf_drift("gsc", "GSC", b.get("gsc"), c.get("gsc"), add, with_position=True)
    _search_perf_drift("bing", "Bing", b.get("bing"), c.get("bing"), add, with_position=False)

    findings.sort(key=lambda f: _SEV_RANK.get(f["severity"], 9))
    counts = {}
    for f in findings:
        counts[f["severity"]] = counts.get(f["severity"], 0) + 1
    return {
        "changed": bool(findings),
        "drift_findings": findings,
        "summary": {**counts, "total": len(findings)},
        "baseline_at": b.get("fetched_at"), "current_at": c.get("fetched_at"),
        "url": c.get("url") or b.get("url"),
    }


def _load(path):
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def main(argv):
    ap = argparse.ArgumentParser(prog="seo-monitor")
    ap.add_argument("--op", choices=["snapshot", "compare"], required=True)
    ap.add_argument("--input", default=None, help="snapshot: seo-crawl JSON (default stdin)")
    ap.add_argument("--health", type=float, default=None, help="snapshot: SEO health score to record")
    ap.add_argument("--geo", type=float, default=None, help="snapshot: GEO score to record")
    ap.add_argument("--gsc", default=None,
                    help="snapshot: Google Search Console query_search_analytics JSON for this URL "
                         "(records clicks/impressions/avg-position for drift). Optional.")
    ap.add_argument("--bing", default=None,
                    help="snapshot: Bing Webmaster GetPageStats/GetQueryStats JSON for this URL "
                         "(records clicks/impressions for drift; counts only). Optional.")
    ap.add_argument("--baseline", default=None, help="compare: baseline snapshot file")
    ap.add_argument("--current", default=None, help="compare: current snapshot file")
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)
    def _snap(obj):  # accept a bare snapshot OR a {ok, data: snapshot} envelope
        return obj.get("data", obj) if isinstance(obj, dict) else obj

    if args.op == "snapshot":
        gsc = _load(args.gsc) if args.gsc else None
        bing = _load(args.bing) if args.bing else None
        data = make_snapshot(_load(args.input), args.health, args.geo, gsc, bing)
    else:
        if not args.baseline or not args.current:
            raise ValueError("compare needs --baseline and --current snapshot files")
        data = compare(_snap(_load(args.baseline)), _snap(_load(args.current)))
    result = {"ok": True, "data": data}
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
