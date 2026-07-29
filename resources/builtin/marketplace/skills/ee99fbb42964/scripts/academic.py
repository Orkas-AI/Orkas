"""deep-research academic — scholarly retriever over public APIs (stdlib only).

The one retriever that fits a Python skill: academic sources expose plain
JSON/XML query APIs, so no model and no browser is needed — a stdlib HTTP call
plus a deterministic parser is enough. Aligns with the deep-research skill's
declared academic dependencies. Sources (no API key required):

  arxiv          — export.arxiv.org Atom XML
  openalex       — api.openalex.org JSON (abstract reconstructed from inverted index)
  crossref       — api.crossref.org JSON
  semanticscholar— api.semanticscholar.org graph JSON
  pubmed         — NCBI E-utilities JSON + XML

Each source is fetched independently; one failing source is recorded in
`errors` and never aborts the others. Results are normalized to the same record
shape the rest of the engine consumes (`text` = abstract), so the pipeline
composes: academic -> compress -> draft -> citations.

Safety: unlike seo-crawl (which fetches arbitrary user URLs and needs the full
SSRF/DNS-rebinding guard), this skill only ever talks to a FIXED ALLOW-LIST of
API hosts over https — a positive allow-list is a stronger guarantee than a
deny-list. Redirects are re-validated against the same list. Requests honor
HTTP(S)_PROXY (required in fake-ip proxy dev environments, where direct DNS
returns reserved 198.18.0.0/15 addresses) and set an explicit timeout so a slow
source cannot hang the agent loop.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from urllib.parse import urlencode, urlsplit

ALLOWED_HOSTS = {
    "export.arxiv.org",
    "api.openalex.org",
    "api.crossref.org",
    "api.semanticscholar.org",
    "eutils.ncbi.nlm.nih.gov",
}
DEFAULT_LIMIT = 5
DEFAULT_TIMEOUT = 30.0          # per request; academic APIs can be slow, but must not hang the loop
MAX_AUTHORS = 10
MAX_BYTES = 5_000_000
USER_AGENT = "OrkasDeepResearch/1.0 (research skill; stdlib)"

_WS_RE = re.compile(r"\s+")
_TAG_RE = re.compile(r"<[^>]+>")
_DOI_PREFIX_RE = re.compile(r"^https?://(dx\.)?doi\.org/", re.IGNORECASE)


# ---- HTTP (allow-listed, proxy-aware, redirect-revalidated) ----------------

class _AllowlistRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parts = urlsplit(newurl)
        if parts.scheme != "https" or parts.hostname not in ALLOWED_HOSTS:
            raise urllib.error.HTTPError(newurl, code, "redirect to disallowed host", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _env_proxies() -> dict:
    proxies = {}
    for scheme in ("http", "https"):
        val = os.environ.get(scheme.upper() + "_PROXY") or os.environ.get(scheme + "_proxy")
        if val:
            proxies[scheme] = val
    return proxies


_OPENER = None


def _opener():
    global _OPENER
    if _OPENER is None:
        _OPENER = urllib.request.build_opener(
            urllib.request.ProxyHandler(_env_proxies()), _AllowlistRedirect())
    return _OPENER


def _http_get(url: str, accept: str, timeout: float) -> str:
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise ValueError("only https is allowed: {}".format(url))
    if parts.hostname not in ALLOWED_HOSTS:
        raise ValueError("host not allow-listed: {}".format(parts.hostname))
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
    with _opener().open(req, timeout=timeout) as resp:
        body = resp.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError("response exceeds {} byte limit".format(MAX_BYTES))
        return body.decode("utf-8", "replace")


# ---- normalization ----------------------------------------------------------

def _clean(s: str) -> str:
    return _WS_RE.sub(" ", s or "").strip()


def _strip_tags(s: str) -> str:
    return _clean(_TAG_RE.sub(" ", s or ""))


def _norm_doi(doi):
    if not doi:
        return None
    d = _DOI_PREFIX_RE.sub("", str(doi).strip()).strip().lower()
    return d or None


def _rec(source, title, text, authors, date, doi, url, ident) -> dict:
    return {
        "id": ident or url or _clean(title),
        "source": source,
        "title": _clean(title),
        "text": _clean(text),
        "authors": [a for a in (_clean(a) for a in (authors or [])) if a][:MAX_AUTHORS],
        "date": (date or None),
        "doi": _norm_doi(doi),
        "url": url or None,
    }


# ---- per-source parsers (deterministic; the unit-tested core) ---------------

_ATOM = {"a": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}


def parse_arxiv(xml_text: str) -> list:
    root = ET.fromstring(xml_text)
    out = []
    for e in root.findall("a:entry", _ATOM):
        authors = [a.findtext("a:name", default="", namespaces=_ATOM)
                   for a in e.findall("a:author", _ATOM)]
        out.append(_rec(
            "arxiv",
            e.findtext("a:title", default="", namespaces=_ATOM),
            e.findtext("a:summary", default="", namespaces=_ATOM),
            authors,
            (e.findtext("a:published", default="", namespaces=_ATOM) or "")[:10],
            e.findtext("arxiv:doi", default=None, namespaces=_ATOM),
            e.findtext("a:id", default="", namespaces=_ATOM),
            e.findtext("a:id", default="", namespaces=_ATOM),
        ))
    return out


def _openalex_abstract(inv) -> str:
    if not isinstance(inv, dict) or not inv:
        return ""
    positions = [(i, word) for word, idxs in inv.items()
                 if isinstance(idxs, list) for i in idxs if isinstance(i, int)]
    positions.sort()
    return " ".join(w for _, w in positions)


def parse_openalex(obj: dict) -> list:
    out = []
    for w in (obj.get("results") or []):
        if not isinstance(w, dict):
            continue
        authors = [((a.get("author") or {}).get("display_name") or "")
                   for a in (w.get("authorships") or []) if isinstance(a, dict)]
        date = w.get("publication_date") or (str(w["publication_year"])
                                             if w.get("publication_year") else "")
        url = w.get("id") or ((w.get("primary_location") or {}).get("landing_page_url") or "")
        out.append(_rec("openalex", w.get("title") or w.get("display_name") or "",
                        _openalex_abstract(w.get("abstract_inverted_index")),
                        authors, date, w.get("doi"), url, w.get("id") or ""))
    return out


def _crossref_date(issued) -> str:
    try:
        parts = (issued or {}).get("date-parts") or []
        ymd = parts[0]
        return "-".join("{:02d}".format(int(x)) if i else str(int(x)) for i, x in enumerate(ymd))
    except (TypeError, ValueError, IndexError, KeyError):
        return ""


def _crossref_name(a: dict) -> str:
    return _clean(" ".join(x for x in (a.get("given"), a.get("family")) if x) or (a.get("name") or ""))


def parse_crossref(obj: dict) -> list:
    out = []
    for it in ((obj.get("message") or {}).get("items") or []):
        if not isinstance(it, dict):
            continue
        title = (it.get("title") or [""])
        doi = it.get("DOI")
        authors = [_crossref_name(a) for a in (it.get("author") or []) if isinstance(a, dict)]
        url = it.get("URL") or (("https://doi.org/" + doi) if doi else "")
        out.append(_rec("crossref", title[0] if title else "", _strip_tags(it.get("abstract") or ""),
                        authors, _crossref_date(it.get("issued")), doi, url, doi or url))
    return out


def parse_semanticscholar(obj: dict) -> list:
    out = []
    for p in (obj.get("data") or []):
        if not isinstance(p, dict):
            continue
        doi = (p.get("externalIds") or {}).get("DOI")
        year = p.get("year")
        authors = [(a.get("name") or "") for a in (p.get("authors") or []) if isinstance(a, dict)]
        url = p.get("url") or (("https://doi.org/" + doi) if doi else "")
        out.append(_rec("semanticscholar", p.get("title") or "", p.get("abstract") or "",
                        authors, str(year) if year else "", doi, url, p.get("paperId") or doi or url))
    return out


_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _element_text(element) -> str:
    return _clean("".join(element.itertext())) if element is not None else ""


def _pubmed_date(article) -> str:
    node = article.find(".//ArticleDate")
    if node is None:
        node = article.find(".//PubDate")
    if node is None:
        return ""
    year = _clean(node.findtext("Year") or "")
    month = _clean(node.findtext("Month") or "")
    day = _clean(node.findtext("Day") or "")
    if not year:
        medline = _clean(node.findtext("MedlineDate") or "")
        return medline
    parts = [year]
    if month:
        try:
            month_number = int(month)
        except ValueError:
            month_number = _MONTHS.get(month[:3].lower())
        if month_number:
            parts.append("{:02d}".format(month_number))
            if day:
                try:
                    parts.append("{:02d}".format(int(day)))
                except ValueError:
                    pass
    return "-".join(parts)


def parse_pubmed(xml_text: str) -> list:
    root = ET.fromstring(xml_text)
    out = []
    for item in root.findall(".//PubmedArticle"):
        pmid = _clean(item.findtext(".//MedlineCitation/PMID") or "")
        title = _element_text(item.find(".//Article/ArticleTitle"))
        abstract_parts = []
        for node in item.findall(".//Article/Abstract/AbstractText"):
            text = _element_text(node)
            label = _clean(node.attrib.get("Label") or "")
            if text:
                abstract_parts.append("{}: {}".format(label, text) if label else text)
        authors = []
        for author in item.findall(".//Article/AuthorList/Author"):
            collective = _clean(author.findtext("CollectiveName") or "")
            personal = _clean(" ".join(
                part for part in (
                    author.findtext("ForeName") or "",
                    author.findtext("LastName") or "",
                ) if part
            ))
            if collective or personal:
                authors.append(collective or personal)
        doi = None
        for article_id in item.findall(".//PubmedData/ArticleIdList/ArticleId"):
            if (article_id.attrib.get("IdType") or "").lower() == "doi":
                doi = _element_text(article_id)
                break
        url = "https://pubmed.ncbi.nlm.nih.gov/{}/".format(pmid) if pmid else ""
        record = _rec(
            "pubmed",
            title,
            " ".join(abstract_parts),
            authors,
            _pubmed_date(item),
            doi,
            url,
            pmid or doi or url,
        )
        record["pmid"] = pmid or None
        out.append(record)
    return out


# ---- fetchers ---------------------------------------------------------------

def fetch_arxiv(query, limit, timeout):
    url = "https://export.arxiv.org/api/query?" + urlencode(
        {"search_query": "all:" + query, "start": 0, "max_results": limit})
    return parse_arxiv(_http_get(url, "application/atom+xml", timeout))


def fetch_openalex(query, limit, timeout):
    url = "https://api.openalex.org/works?" + urlencode({"search": query, "per_page": limit})
    return parse_openalex(json.loads(_http_get(url, "application/json", timeout)))


def fetch_crossref(query, limit, timeout):
    url = "https://api.crossref.org/works?" + urlencode({"query": query, "rows": limit})
    return parse_crossref(json.loads(_http_get(url, "application/json", timeout)))


def fetch_semanticscholar(query, limit, timeout):
    url = "https://api.semanticscholar.org/graph/v1/paper/search?" + urlencode(
        {"query": query, "limit": limit, "fields": "title,abstract,year,authors,externalIds,url"})
    return parse_semanticscholar(json.loads(_http_get(url, "application/json", timeout)))


def fetch_pubmed(query, limit, timeout):
    search_url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?" + urlencode(
        {"db": "pubmed", "term": query, "retmax": limit, "retmode": "json"})
    search_result = json.loads(_http_get(search_url, "application/json", timeout))
    ids = ((search_result.get("esearchresult") or {}).get("idlist") or [])[:limit]
    ids = [str(value) for value in ids if str(value).strip()]
    if not ids:
        return []
    fetch_url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?" + urlencode(
        {"db": "pubmed", "id": ",".join(ids), "retmode": "xml"})
    return parse_pubmed(_http_get(fetch_url, "application/xml", timeout))


FETCHERS = {"arxiv": fetch_arxiv, "openalex": fetch_openalex,
            "crossref": fetch_crossref, "semanticscholar": fetch_semanticscholar,
            "pubmed": fetch_pubmed}
DEFAULT_SOURCES = ["arxiv", "openalex", "crossref", "semanticscholar", "pubmed"]


def _dedup_key(rec: dict) -> str:
    return "doi:" + rec["doi"] if rec.get("doi") else "title:" + _clean(rec.get("title") or "").lower()


def search(query: str, sources, limit, timeout) -> dict:
    results, errors, queried, seen = [], [], [], set()
    jobs = []
    scheduled = set()
    for s in (sources or DEFAULT_SOURCES):
        fn = FETCHERS.get(s)
        if fn is None:
            errors.append({"source": s, "error": "unknown source"})
            continue
        if s in scheduled:
            continue
        scheduled.add(s)
        queried.append(s)
        jobs.append((s, fn))

    # Provider calls are independent and can each consume the full timeout.
    # Run them concurrently, then merge in requested provider order so output
    # and DOI/title de-dup remain deterministic regardless of completion order.
    completed = {}
    if jobs:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(jobs), 8)) as pool:
            futures = {
                s: pool.submit(fn, query, limit, timeout)
                for s, fn in jobs
            }
            for s, _ in jobs:
                try:
                    completed[s] = futures[s].result()
                except Exception as e:  # external I/O + parse: isolate one provider
                    errors.append({"source": s, "error": "{}: {}".format(type(e).__name__, e)})

    for s, _ in jobs:
        for rec in completed.get(s, []):
            try:
                key = _dedup_key(rec)
                if not key or key in seen:
                    continue
                seen.add(key)
                results.append(rec)
            except Exception as e:
                errors.append({"source": s, "error": "{}: {}".format(type(e).__name__, e)})
    return {"query": query, "sources_queried": queried, "count": len(results),
            "results": results, "errors": errors}


def main(argv):
    ap = argparse.ArgumentParser(prog="deep-research/academic")
    ap.add_argument("--op", choices=["search"], default="search")
    ap.add_argument("--query", required=True)
    ap.add_argument("--sources", default=None, help="comma-separated subset of " + ",".join(DEFAULT_SOURCES))
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="max results per source")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    sources = [s.strip() for s in args.sources.split(",")] if args.sources else DEFAULT_SOURCES
    limit = max(1, min(int(args.limit), 25))
    # Clamp like --limit: provider calls are parallel, but each source still needs
    # a finite timeout and PubMed performs a bounded search+fetch pair.
    timeout = max(1.0, min(float(args.timeout), 60.0))
    data = search(args.query, sources, limit, timeout)

    result = {"ok": True, "data": data}
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(result, fh, ensure_ascii=False)
    return result


if __name__ == "__main__":
    try:
        out = main(sys.argv[1:])
    except (ValueError, OSError) as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(out, ensure_ascii=False))
