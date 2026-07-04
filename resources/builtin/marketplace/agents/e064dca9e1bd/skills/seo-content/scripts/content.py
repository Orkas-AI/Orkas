"""seo-content — heuristic content quality / E-E-A-T / GEO-readiness findings.

stdlib only. Pure-function core (`audit_content`) over the seo-crawl page
(`text_sample`, `first_paragraph`, `title`, `h1s`, link counts, structured
data). Heuristic judgments are marked data_tier Estimated; raw counts are
Measured — honest about confidence per the design plan.

Clean-room of the signals in claude-seo content_quality.py / content_verify.py
plus the Web SEO guide's GEO patterns (answer-first, quotable, citations).
"""

from __future__ import annotations

import argparse
import json
import re
import sys

_WEIGHT = {"critical": 25, "high": 12, "medium": 6, "low": 2}

# AI-cliché / filler phrases (lowercased). Clean-room from common LLM-tells.
_AI_PHRASES = [
    "delve into", "delve deeper", "leverage the power", "in today's fast-paced",
    "in today's digital", "ever-evolving", "ever-changing landscape", "cutting-edge",
    "state-of-the-art", "seamless", "seamlessly", "robust solution", "unlock the power",
    "unlock the potential", "navigate the complexities", "rich tapestry", "tapestry of",
    "testament to", "it's important to note", "it is important to note", "when it comes to",
    "a wide range of", "plethora of", "game-changer", "game changer", "elevate your",
    "embark on", "in the realm of", "at the end of the day", "needle in a haystack",
    "more than just", "world of", "look no further",
]

_STAT_RE = re.compile(r"\b\d+(?:\.\d+)?\s*%")
_MONEY_RE = re.compile(r"[$€£¥]\s?\d[\d,]*")
_BIGNUM_RE = re.compile(r"\b\d[\d,]*\s?(?:million|billion|thousand|k|m|bn)\b", re.I)
_AUTHORITY_RE = re.compile(r"\b(according to|study (?:found|shows)|research (?:shows|found)|report(?:s|ed)? that|survey (?:found|of))\b", re.I)
_YEAR_RE = re.compile(r"\bin (?:19|20)\d\d\b")
_SENT_SPLIT = re.compile(r"[.!?。！？]+")
_WORD_RE = re.compile(r"\b[\w'-]+\b", re.UNICODE)
_STOP = {"the", "and", "for", "with", "your", "you", "our", "are", "that", "this",
         "from", "what", "how", "why", "can", "all", "any", "into", "out", "get",
         "a", "an", "of", "to", "in", "is", "it", "on", "by", "or", "be", "as"}


def _data_page(crawl_obj: dict) -> tuple[dict, dict]:
    data = crawl_obj.get("data", crawl_obj) if isinstance(crawl_obj, dict) else {}
    pages = data.get("pages") or []
    if not pages:
        raise ValueError("crawl JSON has no pages")
    return pages[0], (data.get("site") or {})


def _count_claims(text: str) -> int:
    return (len(_STAT_RE.findall(text)) + len(_MONEY_RE.findall(text))
            + len(_BIGNUM_RE.findall(text)) + len(_AUTHORITY_RE.findall(text))
            + len(_YEAR_RE.findall(text)))


def _avg_sentence_words(text: str) -> float:
    sents = [s for s in _SENT_SPLIT.split(text) if s.strip()]
    if not sents:
        return 0.0
    counts = [len(_WORD_RE.findall(s)) for s in sents]
    counts = [c for c in counts if c]
    return (sum(counts) / len(counts)) if counts else 0.0


def audit_content(crawl_obj: dict) -> dict:
    page, site = _data_page(crawl_obj)
    text = page.get("text_sample") or ""
    first = (page.get("first_paragraph") or "").strip()
    title = (page.get("title") or "").strip()
    h1s = page.get("h1s") or []
    wc = page.get("word_count", 0)
    findings: list[dict] = []

    def add(fid, sev, title_, evidence, rec, lead, fail, tier="Estimated", dim="content"):
        findings.append({"id": fid, "dimension": dim, "severity": sev, "title": title_,
                         "evidence": evidence, "recommendation": rec, "leading_indicator": lead,
                         "failure_criterion": fail, "data_tier": tier})

    low = text.lower()
    raw_hits = [p for p in _AI_PHRASES if p in low]
    # Drop a phrase that is a substring of another matched phrase ("seamless" is
    # contained in "seamlessly"), so one cliché counts once instead of inflating
    # the count toward the ≥3 gate.
    hits = [p for p in raw_hits if not any(p != q and p in q for q in raw_hits)]
    if len(hits) >= 3:
        add("ai_tone", "medium", "Content reads AI-generated (filler phrases)",
            "{} cliché/filler phrases e.g. {}".format(len(hits), ", ".join(hits[:4])),
            "Cut filler and AI tells; write concrete, specific prose with original detail.",
            "filler-phrase count drops on recrawl; content reads specific",
            "recrawl still has ≥3 filler phrases", dim="content")

    claims = _count_claims(text)
    ext_links = page.get("external_link_count", 0)
    if claims >= 3 and ext_links == 0:
        add("uncited_claims", "medium", "Statistical/factual claims without citations",
            "{} claim-like statements, 0 outbound citations".format(claims),
            "Cite primary sources for statistics and factual claims (GEO: AI engines prefer corroborated facts).",
            "outbound citations added next to claims; citation coverage > 0",
            "recrawl still has claims with no citations", tier="Measured")

    if wc >= 150 and len(first) < 60:
        add("no_answer_first", "medium", "No direct answer in the opening",
            "first paragraph is {} chars".format(len(first)),
            "Front-load a 1–2 sentence direct answer in the first 30% of the page (GEO answer-first pattern).",
            "first paragraph carries an extractable direct answer; AI-citation eligibility improves",
            "recrawl still buries the answer", dim="content")

    avg = _avg_sentence_words(text)
    if avg > 30:
        add("long_sentences", "low", "Long average sentence length",
            "~{:.0f} words/sentence".format(avg),
            "Shorten sentences (~15–22 words) for readability and quotable chunks.",
            "average sentence length drops below 25 on recrawl",
            "recrawl still averages >30 words/sentence", tier="Measured")

    # title ↔ opening alignment (does the page deliver on its title topic up top?)
    t_terms = [w for w in (_WORD_RE.findall(title.lower())) if len(w) > 3 and w not in _STOP]
    # Whole-word overlap: a raw substring test let a title term "guide" be
    # satisfied by an unrelated body word "guidelines", masking a real mismatch.
    body_words = set(_WORD_RE.findall((first + " " + " ".join(h1s)).lower()))
    if t_terms and not any(term in body_words for term in t_terms):
        add("title_body_mismatch", "low", "Title terms absent from the opening/H1",
            "title terms {} not found in H1/first paragraph".format(t_terms[:5]),
            "Echo the title's primary terms in the H1 and opening so the page matches intent.",
            "primary title term appears in H1/opening on recrawl",
            "recrawl still has no title-term overlap up top", dim="content")

    if wc and wc < 300 and not any(f["id"] == "thin_content" for f in findings):
        add("thin_for_topic", "low", "Short body for a content page",
            "{} words".format(wc),
            "If this is a content/landing page, expand with substantive, original information.",
            "word count grows with substantive content",
            "still thin after expansion", tier="Measured", dim="content")

    penalty = sum(_WEIGHT[f["severity"]] for f in findings)
    return {
        "content_score": max(0, 100 - penalty),
        "findings": findings,
        "summary": {"total": len(findings)},
        "meta": {"url": page.get("url"), "claims_detected": claims,
                 "ai_phrase_hits": len(hits), "avg_sentence_words": round(avg, 1),
                 "word_count": wc},
    }


def _load(path):
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def main(argv):
    ap = argparse.ArgumentParser(prog="seo-content")
    ap.add_argument("--input", default=None, help="seo-crawl JSON (default stdin)")
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)
    result = {"ok": True, "data": audit_content(_load(args.input))}
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
