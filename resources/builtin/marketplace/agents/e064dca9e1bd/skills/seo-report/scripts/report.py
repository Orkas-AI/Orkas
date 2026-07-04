"""seo-report — turn a seo-tech-audit result into a :::dashboard spec + ACTION-PLAN.md.

stdlib only. Pure builders (`build_dashboard`, `build_action_plan`) for testing.
The dashboard JSON is validated against the renderer's directive schema
(schema_version 1; the widget/enum allow-lists below mirror
PC/src/renderer/modules/utils.js) BEFORE it is emitted, so the agent can wrap
stdout in a `:::dashboard` fence without risk of a parse-error block.
"""

from __future__ import annotations

import argparse
import json
import sys

_NODE_TYPES = {"Stack", "Grid", "Card", "Separator", "Metric", "Chart",
               "Table", "Alert", "Timeline", "Code", "Markdown", "Image"}
_TONE = {"positive", "negative", "neutral", "warning"}
_GAP = {"sm", "md", "lg"}
_LEVEL = {"info", "success", "warning", "error"}
_CHART_KIND = {"line", "bar", "area", "pie"}

_DIM_LABEL = {
    "security": "Security", "indexability": "Index", "content_meta": "Meta",
    "content": "Content", "structure": "Structure", "schema": "Schema", "i18n": "i18n",
    "media": "Media", "mobile": "Mobile", "crawlability": "Crawl", "performance": "Perf",
}
_CANON_DIMS = ("security", "indexability", "content_meta", "content", "structure",
               "schema", "i18n", "media", "mobile", "crawlability", "performance")
_WEIGHT = {"critical": 25, "high": 12, "medium": 6, "low": 2}
_GEO_DIM_LABEL = {"citability": "Citability", "structure": "Structure",
                  "multimodal": "Multimodal", "authority": "Authority", "technical": "Tech access"}
_SEV_TONE = {"critical": "negative", "high": "negative", "medium": "warning", "low": "neutral"}
_MAX_TABLE_ROWS = 14
_MAX_OPPORTUNITY_ROWS = 10
_MAX_GEO_PROBE_ROWS = 8


def _data_of(audit_obj: dict) -> dict:
    return audit_obj.get("data", audit_obj) if isinstance(audit_obj, dict) else {}


def _data_of_optional(obj: dict | None) -> dict:
    if not isinstance(obj, dict):
        return {}
    return obj.get("data", obj) if isinstance(obj.get("data", obj), dict) else {}


def _health_tone(score: int) -> str:
    return "positive" if score >= 80 else "warning" if score >= 50 else "negative"


def _num_or(value, default: float = 0.0) -> float:
    """Coerce an optional, possibly-non-numeric probe value to float. GEO probe
    rates/shares are upstream/LLM-derived; one bad value (e.g. "n/a") must not
    crash the whole report via float()."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _tone_for_percent(value: float) -> str:
    pct = value * 100 if value <= 1 else value
    return "positive" if pct >= 25 else "warning" if pct >= 5 else "neutral"


def build_dashboard(audit_obj: dict, opportunities_obj: dict | None = None,
                    geo_probe_obj: dict | None = None) -> dict:
    d = _data_of(audit_obj)
    health = int(d.get("health_score", 0))
    summary = d.get("summary", {})
    dims = d.get("dimension_scores", {})
    findings = d.get("findings", [])
    meta = d.get("meta", {})
    url = meta.get("url") or meta.get("final_url") or ""

    children = []
    children.append({"type": "Metric", "props": {
        "label": "SEO Health", "value": str(health), "tone": _health_tone(health)}})
    geo = d.get("geo_score")
    if geo is not None:
        children.append({"type": "Metric", "props": {
            "label": "GEO Score", "value": str(int(geo)), "tone": _health_tone(int(geo))}})

    children.append({"type": "Grid", "props": {"columns": 4, "gap": "sm"}, "children": [
        {"type": "Metric", "props": {"label": "Critical", "value": str(summary.get("critical", 0)),
                                     "tone": "negative" if summary.get("critical") else "neutral"}},
        {"type": "Metric", "props": {"label": "High", "value": str(summary.get("high", 0)),
                                     "tone": "negative" if summary.get("high") else "neutral"}},
        {"type": "Metric", "props": {"label": "Medium", "value": str(summary.get("medium", 0)),
                                     "tone": "warning" if summary.get("medium") else "neutral"}},
        {"type": "Metric", "props": {"label": "Low", "value": str(summary.get("low", 0)),
                                     "tone": "neutral"}},
    ]})

    if dims:
        chart_data = [{"x": _DIM_LABEL.get(k, k), "y": int(v)} for k, v in dims.items()]
        children.append({"type": "Chart", "props": {"kind": "bar", "data": chart_data}})

    geo_dims = d.get("geo_dimensions")
    if geo_dims:
        gdata = [{"x": _GEO_DIM_LABEL.get(k, k), "y": int(v)} for k, v in geo_dims.items()]
        children.append({"type": "Chart", "props": {"kind": "bar", "data": gdata}})

    crit_high = [f for f in findings if f["severity"] in ("critical", "high")]
    if crit_high:
        top = "; ".join(f["title"] for f in crit_high[:3])
        children.append({"type": "Alert", "props": {
            "level": "error" if any(f["severity"] == "critical" for f in crit_high) else "warning",
            "title": "{} blocking/high issue(s)".format(len(crit_high)),
            "body": top}})

    rows = []
    for f in findings[:_MAX_TABLE_ROWS]:
        rows.append({"sev": f["severity"], "area": f.get("dimension", ""),
                     "issue": f["title"], "fix": f["recommendation"]})
    if rows:
        children.append({"type": "Table", "props": {
            "columns": [{"key": "sev", "label": "Severity"}, {"key": "area", "label": "Area"},
                        {"key": "issue", "label": "Issue"}, {"key": "fix", "label": "Recommendation"}],
            "rows": rows}})
    if len(findings) > _MAX_TABLE_ROWS:
        children.append({"type": "Markdown", "props": {
            "text": "_+{} more findings — see ACTION-PLAN.md._".format(len(findings) - _MAX_TABLE_ROWS)}})

    opp_data = _data_of_optional(opportunities_obj)
    opps = opp_data.get("opportunities") or []
    if opps:
        high = sum(1 for o in opps if o.get("priority") == "High")
        measured = sum(1 for o in opps if o.get("data_tier") == "Measured")
        children.append({"type": "Separator", "props": {}})
        children.append({"type": "Grid", "props": {"columns": 3, "gap": "sm"}, "children": [
            {"type": "Metric", "props": {"label": "Keyword opportunities", "value": str(len(opps)),
                                         "tone": "positive" if opps else "neutral"}},
            {"type": "Metric", "props": {"label": "High priority", "value": str(high),
                                         "tone": "warning" if high else "neutral"}},
            {"type": "Metric", "props": {"label": "Measured", "value": str(measured),
                                         "tone": "positive" if measured else "neutral"}},
        ]})
        orows = []
        for o in opps[:_MAX_OPPORTUNITY_ROWS]:
            orows.append({
                "query": o.get("query", ""),
                "type": o.get("type", ""),
                "source": "{} / {}".format(o.get("source", ""), o.get("data_tier", "")),
                "signal": o.get("current_signal", ""),
                "priority": "{} ({})".format(o.get("priority", ""), o.get("priority_score", "")),
                "action": o.get("recommended_action", ""),
            })
        children.append({"type": "Table", "props": {
            "columns": [{"key": "query", "label": "Query"}, {"key": "type", "label": "Type"},
                        {"key": "source", "label": "Source"}, {"key": "signal", "label": "Signal"},
                        {"key": "priority", "label": "Priority"}, {"key": "action", "label": "Action"}],
            "rows": orows}})
        if len(opps) > _MAX_OPPORTUNITY_ROWS:
            children.append({"type": "Markdown", "props": {
                "text": "_+{} more keyword opportunities — see ACTION-PLAN.md._".format(
                    len(opps) - _MAX_OPPORTUNITY_ROWS)}})

    probe = _data_of_optional(geo_probe_obj)
    if probe:
        sov = _num_or(probe.get("share_of_voice"))
        citation = _num_or(probe.get("citation_rate"))
        children.append({"type": "Separator", "props": {}})
        children.append({"type": "Grid", "props": {"columns": 4, "gap": "sm"}, "children": [
            {"type": "Metric", "props": {"label": "GEO Mention SoV", "value": "{:.0f}%".format(sov * 100),
                                         "tone": _tone_for_percent(sov)}},
            {"type": "Metric", "props": {"label": "GEO Citation Rate", "value": "{:.0f}%".format(citation * 100),
                                         "tone": _tone_for_percent(citation)}},
            {"type": "Metric", "props": {"label": "Answers scored", "value": str(probe.get("answers_scored", 0)),
                                         "tone": "neutral"}},
            {"type": "Metric", "props": {"label": "Data tier", "value": str(probe.get("data_tier", "Estimated")),
                                         "tone": "positive" if probe.get("data_tier") == "Measured" else "warning"}},
        ]})
        comp = probe.get("competitor_share") or {}
        if comp:
            cdata = [{"x": k, "y": int(round(_num_or(v) * 100))} for k, v in comp.items()]
            children.append({"type": "Chart", "props": {"kind": "bar", "data": cdata}})
        per_answer = probe.get("per_answer") or []
        prows = []
        for r in per_answer[:_MAX_GEO_PROBE_ROWS]:
            prows.append({
                "query": r.get("query", ""),
                "mode": r.get("mode", ""),
                "result": r.get("result", ""),
                "cited": "yes" if r.get("domain_cited") else "no",
                "context": "yes" if r.get("context_corroborated") else "no",
            })
        if prows:
            children.append({"type": "Table", "props": {
                "columns": [{"key": "query", "label": "Prompt"}, {"key": "mode", "label": "Mode"},
                            {"key": "result", "label": "Result"}, {"key": "cited", "label": "Domain cited"},
                            {"key": "context", "label": "Context"}],
                "rows": prows}})
            if len(per_answer) > _MAX_GEO_PROBE_ROWS:
                children.append({"type": "Markdown", "props": {
                    "text": "_+{} more prompts — see ACTION-PLAN.md._".format(
                        len(per_answer) - _MAX_GEO_PROBE_ROWS)}})
        children.append({"type": "Markdown", "props": {
            "text": "GEO SoV is a one-run snapshot. Mentions are weaker than sourced citations; sample size is `{}` answers.".format(
                probe.get("answers_scored", 0))}})

    children.append({"type": "Markdown", "props": {
        "text": "Diagnosed `{}` · crawl/audit signals come from this live fetch; optional opportunity and GEO snapshot rows keep their own data tier.".format(url)}})

    return {"schema_version": 1, "root": {"type": "Stack", "props": {"gap": "md"}, "children": children}}


def build_action_plan(audit_obj: dict, crawl_obj: dict | None = None,
                      opportunities_obj: dict | None = None,
                      geo_probe_obj: dict | None = None) -> str:
    d = _data_of(audit_obj)
    meta = d.get("meta", {})
    health = d.get("health_score", 0)
    summary = d.get("summary", {})
    findings = d.get("findings", [])
    url = meta.get("url") or meta.get("final_url") or ""
    fetched = meta.get("fetched_at") or ""

    lines = [
        "# SEO/GEO Action Plan",
        "",
        "- URL: {}".format(url),
        "- Health score: {}/100".format(health),
        "- Findings: {} critical · {} high · {} medium · {} low".format(
            summary.get("critical", 0), summary.get("high", 0),
            summary.get("medium", 0), summary.get("low", 0)),
        "- Fetched: {}".format(fetched),
        "",
    ]
    by_sev = {"critical": [], "high": [], "medium": [], "low": []}
    for f in findings:
        by_sev.setdefault(f["severity"], []).append(f)
    titles = {"critical": "## Critical — fix first", "high": "## High",
              "medium": "## Medium", "low": "## Low"}
    for sev in ("critical", "high", "medium", "low"):
        items = by_sev.get(sev) or []
        if not items:
            continue
        lines.append(titles[sev])
        lines.append("")
        for i, f in enumerate(items, 1):
            lines.append("### {}. {}  _({})_".format(i, f["title"], f.get("dimension", "")))
            lines.append("- Evidence: {}".format(f["evidence"]))
            lines.append("- Fix: {}".format(f["recommendation"]))
            lines.append("- Leading indicator: {}".format(f["leading_indicator"]))
            lines.append("- Failure criterion: {}".format(f["failure_criterion"]))
            lines.append("- Data tier: {}".format(f.get("data_tier", "Measured")))
            lines.append("")
    if not findings:
        lines.append("_No technical issues found in this pass._")
        lines.append("")

    opp_data = _data_of_optional(opportunities_obj)
    opps = opp_data.get("opportunities") or []
    if opps:
        lines.append("## Keyword Opportunities")
        lines.append("")
        lines.append("- Scope: one-run opportunity snapshot; not a historical trend.")
        lines.append("- Opportunities: {} total · {} measured · {} estimated".format(
            len(opps),
            sum(1 for o in opps if o.get("data_tier") == "Measured"),
            sum(1 for o in opps if o.get("data_tier") != "Measured")))
        lines.append("")
        for i, o in enumerate(opps, 1):
            lines.append("### K{}. {}  _({}; priority {} / {})_".format(
                i, o.get("query", ""), o.get("type", ""), o.get("priority", ""), o.get("priority_score", "")))
            lines.append("- Target page: {}".format(o.get("target_page_url", "")))
            lines.append("- Evidence: {}".format(o.get("current_signal", "")))
            lines.append("- Fix: {}".format(o.get("recommended_action", "")))
            lines.append("- Leading indicator: {}".format(o.get("leading_indicator", "")))
            lines.append("- Failure criterion: {}".format(o.get("failure_criterion", "")))
            lines.append("- Data tier: {}".format(o.get("data_tier", "Estimated")))
            lines.append("")

    probe = _data_of_optional(geo_probe_obj)
    if probe:
        lines.append("## GEO Share-of-Voice Snapshot")
        lines.append("")
        lines.append("- Brand: {}".format(probe.get("brand", "?")))
        lines.append("- Domain: {}".format(probe.get("domain", "?")))
        lines.append("- Answers scored: {}".format(probe.get("answers_scored", 0)))
        lines.append("- Mention SoV: {:.0f}%".format(_num_or(probe.get("share_of_voice")) * 100))
        lines.append("- Citation rate: {:.0f}%".format(_num_or(probe.get("citation_rate")) * 100))
        lines.append("- Data tier: {}".format(probe.get("data_tier", "Estimated")))
        comp = probe.get("competitor_share") or {}
        if comp:
            lines.append("- Competitor share: {}".format(", ".join(
                "{} {:.0f}%".format(k, _num_or(v) * 100) for k, v in comp.items())))
        lines.append("")
        lines.append("_Mentions are weaker than sourced citations. This is a one-run snapshot, not a trend._")
        lines.append("")
        per_answer = probe.get("per_answer") or []
        for i, r in enumerate(per_answer[:_MAX_GEO_PROBE_ROWS], 1):
            lines.append("### S{}. {}".format(i, r.get("query", "")))
            lines.append("- Result: {}".format(r.get("result", "")))
            lines.append("- Mode: {}".format(r.get("mode", "")))
            lines.append("- Domain cited: {}".format("yes" if r.get("domain_cited") else "no"))
            lines.append("")
        if len(per_answer) > _MAX_GEO_PROBE_ROWS:
            lines.append("_+{} more prompts not shown above._".format(len(per_answer) - _MAX_GEO_PROBE_ROWS))
            lines.append("")

    geo_recs = d.get("geo_recommendations")
    if geo_recs or d.get("geo_score") is not None:
        lines.append("## GEO (Generative Engine Optimization)")
        lines.append("")
        lines.append("- GEO score: {}/100".format(d.get("geo_score", "?")))
        lines.append("- Entity resolution: {}".format(d.get("entity_status", "?")))
        lines.append("")
        for i, r in enumerate(geo_recs or [], 1):
            lines.append("### G{}. {}".format(i, r["title"]))
            lines.append("- Evidence: {}".format(r["evidence"]))
            lines.append("- Fix: {}".format(r["recommendation"]))
            lines.append("- Leading indicator: {}".format(r["leading_indicator"]))
            lines.append("- Failure criterion: {}".format(r["failure_criterion"]))
            lines.append("- Data tier: {}".format(r.get("data_tier", "Measured")))
            lines.append("")
    return "\n".join(lines)


def validate_dashboard(spec: dict) -> None:
    """Raise ValueError if the spec would not render under the directive schema."""
    if spec.get("schema_version") != 1:
        raise ValueError("dashboard schema_version must be 1")
    root = spec.get("root")
    if not isinstance(root, dict):
        raise ValueError("dashboard root missing")

    def walk(node, path="root"):
        if not isinstance(node, dict):
            raise ValueError("{}: node must be an object".format(path))
        t = node.get("type")
        if t not in _NODE_TYPES:
            raise ValueError("{}: unknown node type {!r}".format(path, t))
        props = node.get("props", {})
        if not isinstance(props, dict):
            raise ValueError("{}: props must be an object".format(path))
        if t == "Chart":
            if props.get("kind") not in _CHART_KIND:
                raise ValueError("{}: bad chart kind {!r}".format(path, props.get("kind")))
            data = props.get("data")
            if not isinstance(data, list) or not data:
                raise ValueError("{}: chart data must be a non-empty list".format(path))
            for pt in data:
                if not (("x" in pt and "y" in pt) or ("label" in pt and "value" in pt)):
                    raise ValueError("{}: chart point needs x/y or label/value".format(path))
        if t == "Metric" and ("label" not in props or "value" not in props):
            raise ValueError("{}: Metric needs label+value".format(path))
        if t == "Table":
            if not isinstance(props.get("columns"), list) or not isinstance(props.get("rows"), list):
                raise ValueError("{}: Table needs columns+rows lists".format(path))
        if "tone" in props and props["tone"] not in _TONE:
            raise ValueError("{}: bad tone {!r}".format(path, props["tone"]))
        if "gap" in props and props["gap"] not in _GAP:
            raise ValueError("{}: bad gap {!r}".format(path, props["gap"]))
        if "level" in props and props["level"] not in _LEVEL:
            raise ValueError("{}: bad level {!r}".format(path, props["level"]))
        for i, ch in enumerate(node.get("children", []) or []):
            walk(ch, "{}>{}[{}]".format(path, t, i))

    walk(root)


def merge_audits(primary: dict, adds: list) -> dict:
    """Union findings from the primary audit + any --add finding sets, then
    recompute health, per-dimension scores and the severity summary from the
    union. The primary audit supplies meta; a GEO finding set may carry a
    separate `geo_score` which is surfaced as its own metric (not folded into
    SEO health)."""
    def data_of(o):
        return o.get("data", o) if isinstance(o, dict) else {}

    pdata = data_of(primary)
    findings = list(pdata.get("findings") or [])
    geo_score = pdata.get("geo_score")
    geo_dimensions = pdata.get("geo_dimensions")
    for a in adds:
        ad = data_of(a)
        findings.extend(ad.get("findings") or [])
        if ad.get("geo_score") is not None:
            geo_score = ad.get("geo_score")
            geo_dimensions = ad.get("geo_dimensions") or geo_dimensions

    counts = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    dim_pen = {d: 0 for d in _CANON_DIMS}
    total_pen = 0
    for f in findings:
        w = _WEIGHT.get(f.get("severity"), 0)
        total_pen += w
        counts[f["severity"]] = counts.get(f["severity"], 0) + 1
        dim = f.get("dimension", "indexability")
        dim_pen[dim] = dim_pen.get(dim, 0) + w
    rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    findings.sort(key=lambda f: rank.get(f.get("severity"), 9))
    merged = {
        "health_score": max(0, min(100, 100 - total_pen)),
        "dimension_scores": {d: max(0, 100 - p) for d, p in dim_pen.items()},
        "summary": {**counts, "total": len(findings)},
        "findings": findings,
        "meta": pdata.get("meta", {}),
    }
    if geo_score is not None:
        merged["geo_score"] = geo_score
        if geo_dimensions:
            merged["geo_dimensions"] = geo_dimensions
    return {"ok": True, "data": merged}


def _load(path: str | None) -> dict:
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def main(argv):
    ap = argparse.ArgumentParser(prog="seo-report")
    ap.add_argument("--audit", default=None, help="primary (seo-tech-audit) JSON file (default: stdin)")
    ap.add_argument("--add", action="append", default=[], help="extra SEO finding set (seo-content/seo-schema); repeatable")
    ap.add_argument("--geo", default=None, help="geo-score JSON (shown separately from SEO health)")
    ap.add_argument("--geo-probe", default=None, help="geo-probe score JSON (one-run SoV snapshot)")
    ap.add_argument("--opportunities", default=None, help="seo-opportunity JSON")
    ap.add_argument("--crawl", default=None, help="optional seo-crawl JSON for extra context")
    ap.add_argument("--plan", default=None, help="write ACTION-PLAN.md here")
    ap.add_argument("--out", default=None, help="write the dashboard JSON here too")
    args = ap.parse_args(argv)
    primary = _load(args.audit)
    # --add files load defensively: a missing/unreadable one (e.g. an optional
    # seo-cwv that hit a rate limit and wrote nothing) is skipped, not fatal.
    adds = []
    for p in args.add:
        try:
            adds.append(_load(p))
        except (OSError, json.JSONDecodeError):
            continue
    audit_obj = merge_audits(primary, adds) if adds else primary
    if args.geo:
        gd = _load(args.geo)
        g = gd.get("data", gd)
        target = audit_obj.get("data") if isinstance(audit_obj, dict) and "data" in audit_obj else audit_obj
        target["geo_score"] = g.get("geo_score")
        target["geo_dimensions"] = g.get("geo_dimensions")
        target["geo_recommendations"] = g.get("geo_recommendations")
        target["entity_status"] = g.get("entity_status")
    crawl_obj = _load(args.crawl) if args.crawl else None
    opportunities_obj = _load(args.opportunities) if args.opportunities else None
    geo_probe_obj = _load(args.geo_probe) if args.geo_probe else None
    dashboard = build_dashboard(audit_obj, opportunities_obj=opportunities_obj, geo_probe_obj=geo_probe_obj)
    validate_dashboard(dashboard)
    plan = build_action_plan(audit_obj, crawl_obj, opportunities_obj=opportunities_obj, geo_probe_obj=geo_probe_obj)
    if args.plan:
        with open(args.plan, "w", encoding="utf-8") as fh:
            fh.write(plan)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(dashboard, fh, ensure_ascii=False)
    d = _data_of(audit_obj)
    return {"ok": True, "dashboard": dashboard, "action_plan_md": plan,
            "health_score": d.get("health_score"), "summary": d.get("summary")}


if __name__ == "__main__":
    try:
        envelope = main(sys.argv[1:])
    except (ValueError, OSError, json.JSONDecodeError) as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
    # stdout: {ok, dashboard, action_plan_md, ...}. Emit `dashboard` between
    # :::dashboard fences; write `action_plan_md` to ACTION-PLAN.md.
    print(json.dumps(envelope, ensure_ascii=False))
