#!/usr/bin/env python3
"""Deterministic editorial preflight for Markdown or plain-text content.

This script surfaces review candidates. It does not determine truth, citation
entailment, plagiarism, AI authorship, or publication fitness by itself.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from itertools import islice
from pathlib import Path
from typing import Any


MAX_INPUT_BYTES = 2 * 1024 * 1024
MAX_FINDINGS = 1000
MAX_LINKS = 5000
MAX_COMPARISON_VALUES = 1000


class InputTooLargeError(ValueError):
    pass


URL_RE = re.compile(r"https?://[^\s<>()\[\]{}]+", re.IGNORECASE)
MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)", re.IGNORECASE)
CITATION_MARKER_RE = re.compile(
    r"(?:\[(?:\d{1,3}|[A-Za-z]\d{1,3}|\^[A-Za-z0-9_-]+)\]|\([A-Z][A-Za-z'’-]+(?:\s+(?:et\s+al\.|and\s+[A-Z][A-Za-z'’-]+))?,?\s+20\d{2}[a-z]?\))"
)
PLACEHOLDER_RE = re.compile(
    r"(?:\b(?:TODO|TBD|TK|FIXME|XXX)\b|\[(?:citation needed|source needed|verify|待补|待核|来源|引用)\]|\{\{[^{}]+\}\}|<<[^<>]+>>)",
    re.IGNORECASE,
)
NUMERIC_CLAIM_RE = re.compile(
    r"(?:[$€£¥￥]\s?\d|(?<!\d)(?:19|20)\d{2}(?!\d)|(?<![\d.])\d+(?:[.,]\d+)?\s?(?:%|percent|percentage points?|bps|x|million|billion|trillion|万|亿|倍|个百分点|亿元?|万元?|美元|元|人|名|家|个|天|年|个月|hours?|days?|weeks?|months?|years?|ms|seconds?|GB|TB|MB)(?![A-Za-z0-9]))",
    re.IGNORECASE,
)
QUOTE_RE = re.compile(r'(?:"[^"\n]{12,}"|“[^”\n]{12,}”|‘[^’\n]{12,}’|「[^」\n]{12,}」|『[^』\n]{12,}』)')
LATIN_WORD_RE = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ0-9]+(?:[’'-][A-Za-zÀ-ÖØ-öø-ÿ0-9]+)*")
HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*$")
TABLE_SEPARATOR_RE = re.compile(r"^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$")
DISCLOSURE_RE = re.compile(
    r"(?:赞助|资助|广告|商业合作|利益冲突|关联链接|affiliate|sponsor(?:ed by)?|funder|funded by|conflict of interest|paid partnership)",
    re.IGNORECASE,
)
DISCLOSURE_PARTY_PATTERNS = (
    re.compile(
        r"(?:sponsored|funded)\s+by\s+([A-Za-z0-9][A-Za-z0-9 .&'’_-]{0,79}?)(?=\s*(?:[.,;:!?)]|$))",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:由|获)\s*([\w\u3400-\u4dbf\u4e00-\u9fff][\w\u3400-\u4dbf\u4e00-\u9fff .&'’()_-]{0,79}?)\s*(?:赞助|资助)",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:sponsor|funder|赞助方|资助方)\s*[:：]\s*([A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff][A-Za-z0-9\u3400-\u4dbf\u4e00-\u9fff .&'’()_-]{0,79}?)(?=\s*(?:[.,;:!?，。；：！？)]|$))",
        re.IGNORECASE,
    ),
)
BRIDGE_CLAIM_PATTERNS: dict[str, re.Pattern[str]] = {
    "foundation": re.compile(r"(?:提供|奠定|打下).{0,12}基础|(?:provide|lay|form).{0,20}(?:a |the )?(?:foundation|basis)", re.IGNORECASE),
    "signal_or_potential": re.compile(r"初步(?:信号|迹象)|展现.{0,10}潜力|显示.{0,10}潜力|shows?.{0,16}potential|early signal", re.IGNORECASE),
    "future_value": re.compile(r"未来(?:价值|可期|潜力|机会)|开启.{0,12}(?:可能|未来)|future (?:value|potential|opportunity)|possibilities are endless", re.IGNORECASE),
    "unsupported_next_step": re.compile(r"后续(?:如需|需要|应当)|下一步(?:需要|应当)|进一步(?:评估|验证|研究)|more (?:samples|evidence).{0,24}(?:needed|required)|further (?:validation|evaluation|research)", re.IGNORECASE),
    "effectiveness_inference": re.compile(r"证明.{0,16}(?:有效|效果)|说明.{0,16}(?:有效|效果)|demonstrates?.{0,20}(?:effective|effectiveness)", re.IGNORECASE),
}

STYLE_PATTERNS: dict[str, tuple[re.Pattern[str], str]] = {
    "significance_inflation": (
        re.compile(
            r"\b(?:pivotal|transformative|groundbreaking|a testament to|marks? a (?:major |key )?(?:shift|turning point|milestone)|underscores? (?:the |its )?importance|evolving landscape)\b|(?:标志着|彰显了|具有里程碑意义|划时代|历史性时刻|时代浪潮)",
            re.IGNORECASE,
        ),
        "Check whether significance language states a supported consequence or merely inflates importance.",
    ),
    "promotional_language": (
        re.compile(
            r"\b(?:breathtaking|must-visit|best-in-class|world-class|revolutionary|unparalleled|game-changing|seamless(?:ly)?|unlock(?:s|ing)? the power)\b|(?:行业领先|颠覆性|革命性|无与伦比|极致体验|强势赋能|重磅|震撼发布|遥遥领先)",
            re.IGNORECASE,
        ),
        "Replace promotional language with a specific supported attribute unless the channel intentionally calls for ad copy.",
    ),
    "vague_attribution": (
        re.compile(
            r"\b(?:experts (?:say|believe|argue)|studies (?:show|suggest|indicate)|research (?:shows|suggests)|industry reports? (?:say|show|suggest)|observers (?:say|note|believe)|many people believe)\b|(?:专家(?:表示|认为|指出)|研究(?:表明|显示|发现)|业内人士(?:表示|认为)|有观点认为|有报道称|数据显示)",
            re.IGNORECASE,
        ),
        "Name and cite the source, or remove the implied authority.",
    ),
    "generic_signposting": (
        re.compile(
            r"\b(?:let(?:'s| us) (?:dive|delve|explore)|here(?:'s| is) what you need to know|in today(?:'s|’s) (?:fast-paced|rapidly changing) world|without further ado)\b|(?:让我们(?:深入|一起来)(?:探讨|了解|看看)|下面(?:让我们|我们将)|在当今(?:快速发展|瞬息万变)的时代|话不多说)",
            re.IGNORECASE,
        ),
        "Start with the useful point unless the signpost serves a real navigation need.",
    ),
    "chatbot_residue": (
        re.compile(
            r"\b(?:i hope this helps|let me know if you(?:'d| would) like|would you like me to|of course!|great question!)\b|(?:希望(?:这些|以上内容)?对你有帮助|如果你愿意我可以|如需更多帮助|这是一个很好的问题)",
            re.IGNORECASE,
        ),
        "Remove assistant-to-user correspondence that is not part of the artifact.",
    ),
    "generic_conclusion": (
        re.compile(
            r"\b(?:the future (?:looks|is) bright|only time will tell|the possibilities are endless|an exciting journey ahead)\b|(?:展望未来|未来可期|让我们拭目以待|未来充满无限可能)",
            re.IGNORECASE,
        ),
        "End with a supported implication, decision, uncertainty, or next action.",
    ),
    "forced_parallelism": (
        re.compile(
            r"\b(?:it(?:'s| is) not (?:just|only).{0,80}\bit(?:'s| is)|not only.{0,100}but also)\b|(?:不仅仅?是.{0,80}(?:更是|而是)|不只是.{0,80}(?:更是|而是))",
            re.IGNORECASE,
        ),
        "Check whether the contrast adds meaning or is formulaic framing.",
    ),
}

SEVERITY_ORDER = {"error": 0, "review": 1, "suggestion": 2}


def mask_code(text: str) -> str:
    """Blank fenced and inline code while preserving line numbers."""
    output: list[str] = []
    fence: str | None = None
    for line in text.splitlines():
        stripped = line.lstrip()
        marker = stripped[:3]
        if fence:
            output.append("")
            if marker == fence:
                fence = None
            continue
        if marker in {"```", "~~~"}:
            fence = marker
            output.append("")
            continue
        output.append(re.sub(r"`[^`\n]+`", "", line))
    return "\n".join(output)


def has_citation_marker(line: str) -> bool:
    return bool(URL_RE.search(line) or MARKDOWN_LINK_RE.search(line) or CITATION_MARKER_RE.search(line))


def _excerpt(line: str, limit: int = 180) -> str:
    compact = re.sub(r"\s+", " ", line).strip()
    return compact if len(compact) <= limit else compact[: limit - 1].rstrip() + "…"


def _sentence_lengths(line: str) -> list[tuple[str, int, int]]:
    results: list[tuple[str, int, int]] = []
    for sentence in re.split(r"(?<=[.!?。！？])\s+|(?<=[。！？])", line):
        sentence = sentence.strip()
        if not sentence:
            continue
        results.append((sentence, len(LATIN_WORD_RE.findall(sentence)), len(HAN_RE.findall(sentence))))
    return results


def _title_case_ratio(title: str) -> tuple[float, int]:
    words = re.findall(r"[A-Za-z][A-Za-z'’-]*", re.sub(r"[*_`]+", "", title))
    meaningful = [w for w in words if w.lower() not in {"a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to"}]
    if not meaningful:
        return 0.0, 0
    titled = sum(1 for word in meaningful if word[0].isupper())
    return titled / len(meaningful), len(meaningful)


def _normalized_matches(pattern: re.Pattern[str], text: str) -> Counter[str]:
    return Counter(re.sub(r"\s+", "", match.group(0)).lower() for match in pattern.finditer(mask_code(text)))


def _disclosure_parties(text: str) -> Counter[str]:
    parties: Counter[str] = Counter()
    for line in mask_code(text).splitlines():
        if not DISCLOSURE_RE.search(line):
            continue
        seen_on_line: set[str] = set()
        for pattern in DISCLOSURE_PARTY_PATTERNS:
            for match in pattern.finditer(line):
                party = re.sub(r"\s+", " ", match.group(1)).strip(" \t.,;:!?，。；：！？()").lower()
                if party and party not in seen_on_line:
                    parties[party] += 1
                    seen_on_line.add(party)
    return parties


def _bounded_counter_elements(counter: Counter[str]) -> tuple[list[str], int, bool]:
    total = sum(counter.values())
    values = list(islice(counter.elements(), MAX_COMPARISON_VALUES))
    return values, total, total > len(values)


def _validate_text_size(text: str, label: str) -> None:
    # Every Unicode code point occupies at least one UTF-8 byte, so the cheap
    # character check rejects obviously oversized values without first making
    # another large allocation.
    if len(text) > MAX_INPUT_BYTES or len(text.encode("utf-8")) > MAX_INPUT_BYTES:
        raise InputTooLargeError(f"{label} exceeds {MAX_INPUT_BYTES} UTF-8 bytes")


def _first_line_with(text: str, value: str) -> tuple[int, str]:
    compact_value = re.sub(r"\s+", "", value).lower()
    for number, line in enumerate(text.splitlines(), start=1):
        if compact_value in re.sub(r"\s+", "", line).lower():
            return number, line
    return 1, text.splitlines()[0] if text.splitlines() else ""


def audit_text(text: str, max_findings: int = 100, source_text: str | None = None) -> dict[str, Any]:
    if not 1 <= max_findings <= MAX_FINDINGS:
        raise ValueError(f"max_findings must be between 1 and {MAX_FINDINGS}")
    _validate_text_size(text, "input")
    if source_text is not None:
        _validate_text_size(source_text, "source input")

    clean = mask_code(text)
    raw_lines = text.splitlines()
    clean_lines = clean.splitlines()
    finding_buckets: dict[str, list[dict[str, Any]]] = {
        severity: [] for severity in SEVERITY_ORDER
    }
    findings_seen = 0
    link_inventory: list[dict[str, Any]] = []
    links_seen = 0
    headings = 0

    def add(code: str, severity: str, line_number: int, message: str, line: str, **metadata: Any) -> None:
        nonlocal findings_seen
        findings_seen += 1
        bucket = finding_buckets[severity]
        if len(bucket) >= max_findings:
            return
        bucket.append({
            "code": code,
            "severity": severity,
            "line": line_number,
            "message": message,
            "excerpt": _excerpt(line),
            **({"metadata": metadata} if metadata else {}),
        })

    def add_link(line_number: int, label: str, url: str) -> None:
        nonlocal links_seen
        links_seen += 1
        if len(link_inventory) < MAX_LINKS:
            link_inventory.append({"line": line_number, "label": label, "url": url})

    for number, line in enumerate(clean_lines, start=1):
        if not line.strip() or TABLE_SEPARATOR_RE.match(line):
            continue

        raw_line = raw_lines[number - 1] if number <= len(raw_lines) else line
        heading = HEADING_RE.match(line)
        if heading:
            headings += 1
            ratio, word_total = _title_case_ratio(heading.group(2))
            if word_total >= 4 and ratio >= 0.8:
                add(
                    "title_case_heading",
                    "suggestion",
                    number,
                    "Check whether title case matches the channel and house style.",
                    raw_line,
                    title_case_ratio=round(ratio, 2),
                )

        for match in MARKDOWN_LINK_RE.finditer(line):
            add_link(number, match.group(1), match.group(2))
        markdown_urls = {match.group(2) for match in MARKDOWN_LINK_RE.finditer(line)}
        for match in URL_RE.finditer(line):
            url = match.group(0).rstrip(".,;:!?，。；：！？")
            if url not in markdown_urls:
                add_link(number, "", url)

        for match in PLACEHOLDER_RE.finditer(line):
            add(
                "unresolved_placeholder",
                "error",
                number,
                "Resolve the placeholder before publication.",
                raw_line,
                placeholder=match.group(0),
            )

        if NUMERIC_CLAIM_RE.search(line):
            add(
                "numeric_or_date_claim",
                "review",
                number,
                "Verify the number/date, scope, unit, freshness, and source entailment.",
                raw_line,
                citation_marker_present=has_citation_marker(line),
            )

        if QUOTE_RE.search(line):
            add(
                "direct_quote_candidate",
                "review",
                number,
                "Verify the exact wording, speaker, date, context, and citation.",
                raw_line,
                citation_marker_present=has_citation_marker(line),
            )

        for code, (pattern, message) in STYLE_PATTERNS.items():
            if pattern.search(line):
                severity = "review" if code == "vague_attribution" else "suggestion"
                add(code, severity, number, message, raw_line)

        if not heading:
            for sentence, latin_words, han_chars in _sentence_lengths(line):
                if latin_words > 45 or han_chars > 90:
                    add(
                        "long_sentence",
                        "suggestion",
                        number,
                        "Review this long sentence for hierarchy, clarity, and intentional rhythm.",
                        sentence,
                        latin_words=latin_words,
                        han_characters=han_chars,
                    )

    sentence_openers: list[tuple[str, int, str]] = []
    for number, line in enumerate(clean_lines, start=1):
        if HEADING_RE.match(line):
            continue
        for sentence, _, _ in _sentence_lengths(line):
            words = LATIN_WORD_RE.findall(sentence.lower())
            if len(words) >= 4:
                sentence_openers.append((" ".join(words[:2]), number, sentence))
    opener_counts = Counter(opener for opener, _, _ in sentence_openers)
    reported_openers: set[str] = set()
    for opener, number, sentence in sentence_openers:
        if opener_counts[opener] >= 3 and opener not in reported_openers:
            reported_openers.add(opener)
            add(
                "repeated_sentence_opener",
                "suggestion",
                number,
                f"The opener '{opener}' appears {opener_counts[opener]} times; check for mechanical cadence.",
                sentence,
                count=opener_counts[opener],
            )

    source_comparison: dict[str, Any] | None = None
    if source_text is not None:
        source_numbers = _normalized_matches(NUMERIC_CLAIM_RE, source_text)
        candidate_numbers = _normalized_matches(NUMERIC_CLAIM_RE, text)
        source_citations = _normalized_matches(CITATION_MARKER_RE, source_text)
        candidate_citations = _normalized_matches(CITATION_MARKER_RE, text)
        source_disclosure_parties = _disclosure_parties(source_text)
        candidate_disclosure_parties = _disclosure_parties(text)
        missing_numbers, missing_numbers_total, missing_numbers_truncated = _bounded_counter_elements(
            source_numbers - candidate_numbers
        )
        added_numbers, added_numbers_total, added_numbers_truncated = _bounded_counter_elements(
            candidate_numbers - source_numbers
        )
        missing_citations, missing_citations_total, missing_citations_truncated = _bounded_counter_elements(
            source_citations - candidate_citations
        )
        added_citations, added_citations_total, added_citations_truncated = _bounded_counter_elements(
            candidate_citations - source_citations
        )
        missing_disclosure_parties, missing_disclosure_parties_total, missing_disclosure_parties_truncated = (
            _bounded_counter_elements(source_disclosure_parties - candidate_disclosure_parties)
        )
        added_disclosure_parties, added_disclosure_parties_total, added_disclosure_parties_truncated = (
            _bounded_counter_elements(candidate_disclosure_parties - source_disclosure_parties)
        )

        for value in missing_numbers:
            number, line = _first_line_with(source_text, value)
            add(
                "source_number_missing",
                "error",
                number,
                "Restore this source number/date or explicitly document an authorized omission.",
                line,
                source_value=value,
            )
        for value in added_numbers:
            number, line = _first_line_with(text, value)
            add(
                "candidate_number_added",
                "error",
                number,
                "Remove or verify this number/date because it is absent from the supplied source.",
                line,
                candidate_value=value,
            )
        for value in missing_citations:
            number, line = _first_line_with(source_text, value)
            add(
                "source_citation_missing",
                "error",
                number,
                "Restore the source citation marker next to the claim it supports.",
                line,
                source_value=value,
            )
        for value in added_citations:
            number, line = _first_line_with(text, value)
            add(
                "candidate_citation_added",
                "error",
                number,
                "Remove or verify this citation marker because it is absent from the supplied source.",
                line,
                candidate_value=value,
            )
        for value in missing_disclosure_parties:
            number, line = _first_line_with(source_text, value)
            add(
                "source_disclosure_party_missing",
                "error",
                number,
                "Restore the disclosed sponsor or funder identity from the supplied source.",
                line,
                source_value=value,
            )
        for value in added_disclosure_parties:
            number, line = _first_line_with(text, value)
            add(
                "candidate_disclosure_party_added",
                "error",
                number,
                "Remove or verify this sponsor or funder identity because it is absent from the supplied source.",
                line,
                candidate_value=value,
            )

        source_has_disclosure = bool(DISCLOSURE_RE.search(mask_code(source_text)))
        candidate_has_disclosure = bool(DISCLOSURE_RE.search(clean))
        if source_has_disclosure and not candidate_has_disclosure:
            add(
                "source_disclosure_missing",
                "error",
                1,
                "Restore the sponsorship, funding, advertising, affiliate, or conflict disclosure.",
                source_text.splitlines()[0] if source_text.splitlines() else "",
            )

        bridge_claims: list[dict[str, Any]] = []
        bridge_claims_seen = 0
        clean_source = mask_code(source_text)
        for bridge_type, pattern in BRIDGE_CLAIM_PATTERNS.items():
            if pattern.search(clean_source):
                continue
            for number, line in enumerate(clean_lines, start=1):
                match = pattern.search(line)
                if not match:
                    continue
                bridge_claims_seen += 1
                if len(bridge_claims) < MAX_COMPARISON_VALUES:
                    bridge_claims.append({"type": bridge_type, "line": number, "text": match.group(0)})
                add(
                    "new_bridge_claim",
                    "review",
                    number,
                    "This implication or next-step language is absent from the supplied source; remove it from the artifact or label it as requested editorial advice.",
                    raw_lines[number - 1] if number <= len(raw_lines) else line,
                    bridge_type=bridge_type,
                )

        source_comparison = {
            "missing_numbers_or_dates": missing_numbers,
            "missing_numbers_or_dates_total": missing_numbers_total,
            "added_numbers_or_dates": added_numbers,
            "added_numbers_or_dates_total": added_numbers_total,
            "missing_citations": missing_citations,
            "missing_citations_total": missing_citations_total,
            "added_citations": added_citations,
            "added_citations_total": added_citations_total,
            "missing_disclosure_parties": missing_disclosure_parties,
            "missing_disclosure_parties_total": missing_disclosure_parties_total,
            "added_disclosure_parties": added_disclosure_parties,
            "added_disclosure_parties_total": added_disclosure_parties_total,
            "source_disclosure_present": source_has_disclosure,
            "candidate_disclosure_present": candidate_has_disclosure,
            "new_bridge_claims": bridge_claims,
            "new_bridge_claims_total": bridge_claims_seen,
            "new_bridge_claims_truncated": bridge_claims_seen > len(bridge_claims),
            "values_truncated": any((
                missing_numbers_truncated,
                added_numbers_truncated,
                missing_citations_truncated,
                added_citations_truncated,
                missing_disclosure_parties_truncated,
                added_disclosure_parties_truncated,
            )),
        }

    findings = [item for bucket in finding_buckets.values() for item in bucket]
    findings.sort(key=lambda item: (SEVERITY_ORDER[item["severity"]], item["line"], item["code"]))
    findings = findings[:max_findings]
    truncated = findings_seen > len(findings)
    severity_counts = Counter(item["severity"] for item in findings)
    code_counts = Counter(item["code"] for item in findings)
    latin_words = len(LATIN_WORD_RE.findall(clean))
    han_chars = len(HAN_RE.findall(clean))
    paragraphs = len([p for p in re.split(r"\n\s*\n", clean) if p.strip()])

    report = {
        "schema_version": 1,
        "summary": {
            "latin_words": latin_words,
            "han_characters": han_chars,
            "paragraphs": paragraphs,
            "headings": headings,
            "links": links_seen,
            "links_returned": len(link_inventory),
            "links_truncated": links_seen > len(link_inventory),
            "findings_returned": len(findings),
            "findings_truncated": truncated,
            "by_severity": dict(sorted(severity_counts.items())),
            "by_code": dict(sorted(code_counts.items())),
        },
        "findings": findings,
        "links": link_inventory,
        "limitations": [
            "Heuristics surface editorial review candidates and can produce false positives.",
            "The audit does not fetch links or verify factual truth, source quality, independence, or claim entailment.",
            "The audit does not detect plagiarism or determine whether a human or model authored the text.",
            "A qualified reviewer must assess high-stakes legal, medical, financial, regulatory, and safety content.",
        ],
    }
    if source_comparison is not None:
        report["source_comparison"] = source_comparison
        report["limitations"].append(
            "Source comparison is lexical: it checks markers and risky additions, not semantic equivalence or complete claim entailment."
        )
    return report


def _markdown_cell(value: Any) -> str:
    return str(value).replace("|", "\\|").replace("\n", " ").strip()


def render_markdown(report: dict[str, Any]) -> str:
    summary = report["summary"]
    lines = [
        "# Deterministic content audit",
        "",
        "> Heuristic preflight only. Verify truth, source entailment, links, and publication risk separately.",
        "",
        "## Summary",
        "",
        "| Metric | Count |",
        "|---|---:|",
        f"| Latin words | {summary['latin_words']} |",
        f"| Han characters | {summary['han_characters']} |",
        f"| Paragraphs | {summary['paragraphs']} |",
        f"| Headings | {summary['headings']} |",
        f"| Links | {summary['links']} |",
        f"| Findings returned | {summary['findings_returned']} |",
    ]
    if summary.get("findings_truncated"):
        lines.extend(["", "> Findings were truncated by `--max-findings`."])

    findings = report.get("findings") or []
    lines.extend(["", "## Findings", ""])
    if not findings:
        lines.append("No deterministic findings. This is not a factual or publication-readiness pass.")
    else:
        lines.extend([
            "| Severity | Line | Code | Review action | Excerpt |",
            "|---|---:|---|---|---|",
        ])
        for item in findings:
            lines.append(
                "| {severity} | {line} | `{code}` | {message} | {excerpt} |".format(
                    severity=_markdown_cell(item["severity"].upper()),
                    line=item["line"],
                    code=_markdown_cell(item["code"]),
                    message=_markdown_cell(item["message"]),
                    excerpt=_markdown_cell(item["excerpt"]),
                )
            )

    links = report.get("links") or []
    lines.extend(["", "## Link inventory", ""])
    if links:
        for item in links:
            label = f" ({item['label']})" if item.get("label") else ""
            lines.append(f"- Line {item['line']}: {item['url']}{label}")
    else:
        lines.append("- No HTTP(S) links found.")

    comparison = report.get("source_comparison")
    if comparison is not None:
        lines.extend([
            "",
            "## Supplied-source comparison",
            "",
            f"- Missing numbers/dates: {len(comparison['missing_numbers_or_dates'])}",
            f"- Added numbers/dates: {len(comparison['added_numbers_or_dates'])}",
            f"- Missing citations: {len(comparison['missing_citations'])}",
            f"- Added citations: {len(comparison['added_citations'])}",
            f"- Missing disclosure parties: {len(comparison['missing_disclosure_parties'])}",
            f"- Added disclosure parties: {len(comparison['added_disclosure_parties'])}",
            f"- New bridge-claim candidates: {len(comparison['new_bridge_claims'])}",
            f"- Required disclosure preserved: {'yes' if not comparison['source_disclosure_present'] or comparison['candidate_disclosure_present'] else 'no'}",
        ])

    lines.extend(["", "## Limitations", ""])
    lines.extend(f"- {item}" for item in report.get("limitations") or [])
    return "\n".join(lines) + "\n"


def _read_input(value: str) -> str:
    if value == "-":
        stream = getattr(sys.stdin, "buffer", sys.stdin)
        data = stream.read(MAX_INPUT_BYTES + 1)
    else:
        path = Path(value)
        if not path.is_file():
            raise FileNotFoundError(f"input file not found: {path}")
        with path.open("rb") as handle:
            data = handle.read(MAX_INPUT_BYTES + 1)
    if isinstance(data, str):
        _validate_text_size(data, "input")
        return data
    if len(data) > MAX_INPUT_BYTES:
        raise InputTooLargeError(f"input exceeds {MAX_INPUT_BYTES} UTF-8 bytes")
    return data.decode("utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a deterministic editorial preflight on Markdown or text.")
    parser.add_argument("input", nargs="?", default="-", help="Input file, or - for stdin (default).")
    parser.add_argument("--source", help="Optional supplied source file for strict preservation comparison.")
    parser.add_argument("--format", choices=("json", "markdown"), default="markdown")
    parser.add_argument("--max-findings", type=int, default=100)
    args = parser.parse_args(argv)

    if not 1 <= args.max_findings <= MAX_FINDINGS:
        parser.error(f"--max-findings must be between 1 and {MAX_FINDINGS}")
    if args.input == "-" and args.source == "-":
        parser.error("input and --source cannot both read from stdin")
    try:
        text = _read_input(args.input)
        source_text = _read_input(args.source) if args.source else None
    except (OSError, UnicodeError, InputTooLargeError) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    report = audit_text(text, max_findings=args.max_findings, source_text=source_text)
    if args.format == "json":
        json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(render_markdown(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
