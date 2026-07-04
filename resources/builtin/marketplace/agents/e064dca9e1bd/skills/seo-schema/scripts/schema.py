"""seo-schema — lint existing JSON-LD and generate templates.

stdlib only. Two ops:
  validate  — consume seo-crawl JSON, lint each JSON-LD node (missing @type /
              required fields, deprecated rich-result types) and recommend
              types the page should add. Emits findings (dimension "schema").
  generate  — emit a JSON-LD template for a type, filled from --json or with
              placeholders (used in the apply/content flow).

Clean-room of claude-seo schema/templates.json + the Web SEO guide's
home/docs/task schema rules. Recommendations are heuristic (Estimated).
"""

from __future__ import annotations

import argparse
import json
import sys
from urllib.parse import urlsplit

_WEIGHT = {"critical": 25, "high": 12, "medium": 6, "low": 2}

# Minimal required-property sets for the types we recognize.
_REQUIRED = {
    "Organization": ["name", "url"],
    "WebSite": ["name", "url"],
    "SoftwareApplication": ["name", "applicationCategory"],
    "Article": ["headline"],
    "BlogPosting": ["headline"],
    "FAQPage": ["mainEntity"],
    "BreadcrumbList": ["itemListElement"],
    "Product": ["name"],
    "HowTo": ["name", "step"],
}
# Types Google restricted/deprecated for rich results (still valid markup).
_DEPRECATED_RICHRESULT = {"FAQPage", "HowTo"}

_TEMPLATES = {
    "Organization": {"@context": "https://schema.org", "@type": "Organization",
                     "name": "<ORG NAME>", "url": "<https://site>", "logo": "<https://site/logo.png>",
                     "sameAs": ["<https://github.com/...>", "<https://x.com/...>"]},
    "WebSite": {"@context": "https://schema.org", "@type": "WebSite",
                "name": "<SITE NAME>", "url": "<https://site>"},
    "SoftwareApplication": {"@context": "https://schema.org", "@type": "SoftwareApplication",
                            "name": "<APP NAME>", "applicationCategory": "<e.g. DeveloperApplication>",
                            "operatingSystem": "<macOS, Windows>",
                            "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"}},
    "FAQPage": {"@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
        {"@type": "Question", "name": "<QUESTION matching a visible FAQ>",
         "acceptedAnswer": {"@type": "Answer", "text": "<ANSWER matching the visible text>"}}]},
    "Article": {"@context": "https://schema.org", "@type": "Article", "headline": "<HEADLINE>",
                "author": {"@type": "Person", "name": "<AUTHOR>"}, "datePublished": "<YYYY-MM-DD>"},
    "BreadcrumbList": {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "<NAME>", "item": "<https://site/path>"}]},
    "Product": {"@context": "https://schema.org", "@type": "Product", "name": "<PRODUCT>",
                "offers": {"@type": "Offer", "price": "<PRICE>", "priceCurrency": "USD"}},
}


def _data_page(crawl_obj: dict) -> tuple[dict, dict]:
    data = crawl_obj.get("data", crawl_obj) if isinstance(crawl_obj, dict) else {}
    pages = data.get("pages") or []
    if not pages:
        raise ValueError("crawl JSON has no pages")
    return pages[0], (data.get("site") or {})


def _nodes(structured_data: list) -> list[dict]:
    """Flatten JSON-LD blocks, expanding @graph."""
    out = []
    for block in structured_data or []:
        items = block if isinstance(block, list) else [block]
        for it in items:
            if not isinstance(it, dict):
                continue
            if "@graph" in it:
                # @graph is usually a list, but a single-node object is valid too;
                # treating a dict @graph as a plain node dropped the inner node(s)
                # and left a typeless wrapper (spurious schema_no_type).
                graph = it["@graph"]
                graph_items = graph if isinstance(graph, list) else [graph]
                out.extend(n for n in graph_items if isinstance(n, dict))
            else:
                out.append(it)
    return out


def _types_of(node: dict) -> list[str]:
    t = node.get("@type")
    if isinstance(t, list):
        return [str(x) for x in t]
    return [str(t)] if t else []


def validate(crawl_obj: dict) -> dict:
    page, _ = _data_page(crawl_obj)
    nodes = _nodes(page.get("structured_data") or [])
    present = sorted({t for n in nodes for t in _types_of(n)})
    findings: list[dict] = []

    def add(fid, sev, title_, evidence, rec, lead, fail, tier="Measured"):
        findings.append({"id": fid, "dimension": "schema", "severity": sev, "title": title_,
                         "evidence": evidence, "recommendation": rec, "leading_indicator": lead,
                         "failure_criterion": fail, "data_tier": tier})

    for i, n in enumerate(nodes):
        types = _types_of(n)
        if not types:
            add("schema_no_type", "medium", "JSON-LD block missing @type",
                "block #{} has no @type".format(i + 1),
                "Add a valid schema.org @type to every JSON-LD node.",
                "every JSON-LD node has @type on recrawl", "recrawl still has a typeless node")
            continue
        for ty in types:
            req = _REQUIRED.get(ty)
            if req:
                # A present-but-empty required value (name:"", mainEntity:[]) is as
                # invalid as an absent one — `not n.get(p)` catches both.
                missing = [p for p in req if not n.get(p)]
                if missing:
                    add("schema_missing_field", "low", "{} JSON-LD missing required fields".format(ty),
                        "{} lacks {}".format(ty, ", ".join(missing)),
                        "Add the required properties so the markup is eligible.",
                        "{} has {} on recrawl".format(ty, "/".join(req)),
                        "recrawl still missing {}".format(", ".join(missing)))
            if ty in _DEPRECATED_RICHRESULT:
                add("schema_deprecated_richresult", "low",
                    "{} no longer yields rich results for most sites".format(ty),
                    "{} present".format(ty),
                    "Keep the markup if the visible content matches, but don't expect a {} rich result (Google restricted it).".format(ty),
                    "no reliance on a deprecated rich result", "n/a", tier="Estimated")

    # Recommend types by page role (heuristic).
    path = (urlsplit(page.get("url") or "").path or "/").rstrip("/") or "/"
    recommend = []
    if path == "/":
        for ty in ("Organization", "WebSite"):
            if ty not in present:
                recommend.append(ty)
    else:
        if "BreadcrumbList" not in present:
            recommend.append("BreadcrumbList")
    if recommend:
        add("schema_recommend", "low", "Recommended structured data not present",
            "page {} is missing {}".format(path, ", ".join(recommend)),
            "Add JSON-LD for {} matching the visible page (use the generate op).".format(", ".join(recommend)),
            "recommended types present and valid on recrawl",
            "recrawl still missing the recommended types", tier="Estimated")

    penalty = sum(_WEIGHT[f["severity"]] for f in findings)
    return {"schema_score": max(0, 100 - penalty), "present_types": present,
            "recommended_types": recommend, "findings": findings,
            "summary": {"total": len(findings)}, "meta": {"url": page.get("url")}}


def generate(type_name: str, data: dict | None) -> dict:
    tmpl = _TEMPLATES.get(type_name)
    if not tmpl:
        raise ValueError("no template for type {!r}; known: {}".format(
            type_name, ", ".join(sorted(_TEMPLATES))))
    out = json.loads(json.dumps(tmpl))  # deep copy
    if data:
        out.update(data)
    return out


def _load(path):
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def main(argv):
    ap = argparse.ArgumentParser(prog="seo-schema")
    ap.add_argument("--op", choices=["validate", "generate"], default="validate")
    ap.add_argument("--input", default=None, help="seo-crawl JSON for validate (default stdin)")
    ap.add_argument("--out", default=None)
    ap.add_argument("--type", default=None, help="schema.org type for generate")
    ap.add_argument("--json", default=None, help="JSON object of field overrides for generate")
    args = ap.parse_args(argv)
    if args.op == "generate":
        if not args.type:
            raise ValueError("generate requires --type")
        overrides = json.loads(args.json) if args.json else None
        result = {"ok": True, "data": {"jsonld": generate(args.type, overrides)}}
    else:
        result = {"ok": True, "data": validate(_load(args.input))}
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
