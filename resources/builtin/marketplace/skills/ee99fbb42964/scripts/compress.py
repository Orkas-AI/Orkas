"""deep-research compress — deterministic context compression / de-noising.

GPT-Researcher compresses fetched context with a langchain EmbeddingsFilter
before it hits the model, so a long page does not blow the token budget. We do
the same job WITHOUT langchain and WITHOUT embeddings (embedding/vector rerank is
a separate Phase-3 core-agent tool a stdlib subprocess cannot reach): chunk each
fetched source, drop duplicate/boilerplate passages, score the rest against the
sub-question by lexical overlap, and keep the most relevant chunks within a char
budget. Calls no model, so the same input always yields the same selection.

Small-content shortcut (mirrors GPT-R skipping embedding for small inputs): when
the total fetched text already fits the budget there is nothing to compress —
sources pass through de-duplicated, unscored.

stdlib only. Tokenization is English-centric (whitespace/word based); CJK text is
treated coarsely — fine for the academic/web sources this engine targets.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata

DEFAULT_MAX_CHARS = 12000     # total budget across kept chunks
MAX_CHUNK_CHARS = 1200        # a single passage is split below this
MIN_CHUNK_CHARS = 80          # fragments shorter than this are dropped as noise
SMALL_CONTENT_CHARS = 2000    # total input at/under this skips the compress path
NEAR_DUP_JACCARD = 0.9        # token-set overlap above which two chunks are dups
MAX_SOURCES = 200             # hard cap so hostile/accidental huge inputs stay bounded
MAX_SOURCE_CHARS = 100000     # cap a single fetched source before chunking
MAX_TOTAL_INPUT_CHARS = 500000
NEAR_DEDUP_SHINGLE_TOKENS = 8
NEAR_DEDUP_BUCKET_STEP = 4

_WORD_RE = re.compile(r"[0-9A-Za-z][0-9A-Za-z'\-]*", re.UNICODE)
_WS_RE = re.compile(r"\s+")
_PARA_RE = re.compile(r"\n\s*\n")
_SENT_RE = re.compile(r"(?<=[.!?])\s+")

_STOP = {
    "the", "and", "for", "with", "your", "you", "our", "are", "that", "this",
    "from", "what", "how", "why", "can", "all", "any", "into", "out", "get",
    "was", "were", "has", "have", "had", "not", "but", "its", "their", "them",
    "they", "will", "would", "which", "who", "whom", "these", "those", "such",
    "than", "then", "there", "here", "when", "where", "about", "over", "more",
    "most", "some", "also", "may", "might", "been", "being", "does", "did",
    "a", "an", "of", "to", "in", "is", "it", "on", "by", "or", "be", "as", "at",
}


def _norm(s: str) -> str:
    """Whitespace/case/unicode-form normalization for dedup identity."""
    if not s:
        return ""
    return _WS_RE.sub(" ", unicodedata.normalize("NFKC", s)).strip().casefold()


def tokenize(s: str) -> list:
    """Content tokens: lowercased words, length >= 2, stopwords removed."""
    return [w for w in (m.group(0).lower() for m in _WORD_RE.finditer(s or ""))
            if len(w) >= 2 and w not in _STOP]


def chunk_text(text: str) -> list:
    """Split into passages: by blank-line paragraphs, further split by sentence
    when a paragraph exceeds MAX_CHUNK_CHARS. Fragments below MIN_CHUNK_CHARS are
    dropped."""
    chunks = []
    for para in _PARA_RE.split(text or ""):
        para = _WS_RE.sub(" ", para).strip()
        if not para:
            continue
        if len(para) <= MAX_CHUNK_CHARS:
            if len(para) >= MIN_CHUNK_CHARS:
                chunks.append(para)
            continue
        # Pack sentences up to the cap so we never emit a > MAX_CHUNK_CHARS chunk.
        buf = ""
        for sent in _SENT_RE.split(para):
            sent = sent.strip()
            if not sent:
                continue
            if buf and len(buf) + 1 + len(sent) > MAX_CHUNK_CHARS:
                if len(buf) >= MIN_CHUNK_CHARS:
                    chunks.append(buf)
                buf = sent
            else:
                buf = (buf + " " + sent) if buf else sent
            # A single sentence longer than the cap is hard-split on width.
            while len(buf) > MAX_CHUNK_CHARS:
                chunks.append(buf[:MAX_CHUNK_CHARS])
                buf = buf[MAX_CHUNK_CHARS:]
        if len(buf) >= MIN_CHUNK_CHARS:
            chunks.append(buf)
    return chunks


def _score(query_terms: set, chunk_tokens: list) -> tuple:
    """(coverage, density): coverage = fraction of the sub-question's content
    terms the chunk addresses (0..1); density = how concentrated those hits are.
    A chunk sharing only stopwords scores 0 because stopwords are not query
    terms — that is what separates a real topical passage from look-alike noise."""
    if not query_terms or not chunk_tokens:
        return (0.0, 0.0)
    tokset = set(chunk_tokens)
    matched = query_terms & tokset
    if not matched:
        return (0.0, 0.0)
    coverage = len(matched) / len(query_terms)
    hits = sum(1 for t in chunk_tokens if t in matched)
    density = hits / len(chunk_tokens)
    return (round(coverage, 4), round(density, 4))


def _near_dedup_keys(toks: set) -> tuple:
    """Stable token-shingle buckets for near-duplicate candidate lookup.

    Near duplicates share most content tokens, so they also share at least one
    sorted-token shingle. We then run the exact Jaccard check only against those
    bucket candidates instead of every previously-kept chunk.
    """
    ordered = sorted(toks)
    if not ordered:
        return ()
    width = max(1, int(NEAR_DEDUP_SHINGLE_TOKENS))
    if len(ordered) <= width:
        return (" ".join(ordered),)
    step = max(1, int(NEAR_DEDUP_BUCKET_STEP))
    keys = [" ".join(ordered[i:i + width]) for i in range(0, len(ordered) - width + 1, step)]
    tail = " ".join(ordered[-width:])
    if keys[-1] != tail:
        keys.append(tail)
    return tuple(keys)


def _dedup(records: list) -> tuple:
    """Drop exact-normalized duplicates, then bucketed near-duplicates.

    First occurrence wins, so ordering stays stable. Returns
    (kept_records, dropped_count).
    """
    seen_norm = set()
    kept = []
    kept_tok = []
    near_buckets = {}
    dropped = 0
    for rec in records:
        key = _norm(rec["chunk"])
        if key in seen_norm:
            dropped += 1
            continue
        toks = set(tokenize(rec["chunk"]))
        is_near = False
        if toks:
            candidate_idxs = set()
            for bucket_key in _near_dedup_keys(toks):
                candidate_idxs.update(near_buckets.get(bucket_key, ()))
            for idx in candidate_idxs:
                prev = kept_tok[idx]
                inter = len(toks & prev)
                if inter and inter / len(toks | prev) >= NEAR_DUP_JACCARD:
                    is_near = True
                    break
        if is_near:
            dropped += 1
            continue
        seen_norm.add(key)
        kept.append(rec)
        kept_tok.append(toks)
        idx = len(kept_tok) - 1
        for bucket_key in _near_dedup_keys(toks):
            near_buckets.setdefault(bucket_key, []).append(idx)
    return kept, dropped


def _text_of(src: dict) -> str:
    value = src.get("text") or ""
    return value if isinstance(value, str) else str(value)


def _limit_sources(sources: list) -> tuple:
    """Return capped source copies plus stats about discarded input."""
    valid = 0
    raw_chars = 0
    limited = []
    chars = 0
    sources_dropped = 0
    sources_truncated = 0
    chars_truncated = 0

    for src in sources:
        if not isinstance(src, dict):
            continue
        valid += 1
        original_text = _text_of(src)
        raw_chars += len(original_text)
        if len(limited) >= MAX_SOURCES:
            sources_dropped += 1
            chars_truncated += len(original_text)
            continue

        remaining_total = MAX_TOTAL_INPUT_CHARS - chars
        if remaining_total <= 0:
            sources_dropped += 1
            chars_truncated += len(original_text)
            continue

        cap = min(MAX_SOURCE_CHARS, remaining_total)
        text = original_text[:cap]
        if len(text) < len(original_text):
            sources_truncated += 1
            chars_truncated += len(original_text) - len(text)

        copy = dict(src)
        copy["text"] = text
        limited.append(copy)
        chars += len(text)

    return limited, {
        "sources_input": valid,
        "sources_considered": len(limited),
        "sources_dropped": sources_dropped,
        "sources_truncated": sources_truncated,
        "chars_input_raw": raw_chars,
        "chars_truncated": chars_truncated,
        "input_capped": sources_dropped > 0 or sources_truncated > 0,
    }


def compress(payload: dict) -> dict:
    query = payload.get("query") or ""
    original_sources = payload.get("sources") or []
    sources, source_stats = _limit_sources(original_sources)
    budget = int(payload.get("max_chars") or DEFAULT_MAX_CHARS)
    max_per_source = payload.get("max_per_source")
    min_score = float(payload.get("min_score") or 0.0)

    chars_in = sum(len(_text_of(s)) for s in sources if isinstance(s, dict))
    query_terms = set(tokenize(query))

    # Small-content / no-query shortcut: nothing to gain from scoring, just emit
    # whole sources (de-duplicated) so the caller still gets clean, keyed context.
    skip = chars_in <= SMALL_CONTENT_CHARS or not query_terms
    records = []
    for s in sources:
        if not isinstance(s, dict):
            continue
        text = _text_of(s)
        meta = {"source": s.get("id"), "url": s.get("url"), "title": s.get("title")}
        pieces = [text.strip()] if skip else chunk_text(text)
        for i, piece in enumerate(pieces):
            if not piece:
                continue
            records.append({**meta, "chunk": piece, "chunk_index": i})

    records, deduped = _dedup(records)

    if skip:
        kept = [{**r, "score": None} for r in records]
        chars_out = sum(len(r["chunk"]) for r in kept)
        return _envelope(query, kept, sources, records, deduped, chars_in, chars_out,
                         budget, dropped_low=0, skipped=True, source_stats=source_stats)

    # Score, drop zero/low-relevance noise, then rank for budget selection.
    # Default threshold 0.0 keeps any chunk that shares >=1 content term and
    # drops pure noise (coverage 0); a positive min_score raises the bar.
    scored = []
    for r in records:
        cov, dens = _score(query_terms, tokenize(r["chunk"]))
        if cov <= min_score:
            continue
        scored.append({**r, "score": cov, "_density": dens})
    dropped_low = len(records) - len(scored)

    # Stable ranking: relevance first, then original source/chunk order.
    scored.sort(key=lambda r: (-r["score"], -r["_density"], str(r["source"]), r["chunk_index"]))

    kept = []
    used = 0
    per_source = {}
    for r in scored:
        if max_per_source is not None:
            c = per_source.get(r["source"], 0)
            if c >= int(max_per_source):
                continue
        if used + len(r["chunk"]) > budget and kept:
            continue          # over budget — skip, but keep scanning smaller chunks
        used += len(r["chunk"])
        per_source[r["source"]] = per_source.get(r["source"], 0) + 1
        kept.append({"source": r["source"], "url": r["url"], "title": r["title"],
                     "chunk": r["chunk"], "chunk_index": r["chunk_index"], "score": r["score"]})

    return _envelope(query, kept, sources, records, deduped, chars_in, used,
                     budget, dropped_low=dropped_low, skipped=False, source_stats=source_stats)


def _envelope(query, kept, sources, records, deduped, chars_in, chars_out,
              budget, dropped_low, skipped, source_stats=None) -> dict:
    source_stats = source_stats or {}
    return {
        "query": query,
        "kept": kept,
        "dropped_low_relevance": dropped_low,
        "budget_chars": budget,
        "stats": {
            "sources": source_stats.get("sources_input", sum(1 for s in sources if isinstance(s, dict))),
            "sources_input": source_stats.get("sources_input", sum(1 for s in sources if isinstance(s, dict))),
            "sources_considered": source_stats.get("sources_considered", sum(1 for s in sources if isinstance(s, dict))),
            "sources_dropped": source_stats.get("sources_dropped", 0),
            "sources_truncated": source_stats.get("sources_truncated", 0),
            "chunks_total": len(records) + deduped,
            "chunks_kept": len(kept),
            "chars_input_raw": source_stats.get("chars_input_raw", chars_in),
            "chars_in": chars_in,
            "chars_out": chars_out,
            "chars_truncated": source_stats.get("chars_truncated", 0),
            "deduped": deduped,
            "input_capped": source_stats.get("input_capped", False),
            "skipped_compression": skipped,
        },
    }


def _load(path):
    raw = sys.stdin.read() if not path or path == "-" else open(path, encoding="utf-8").read()
    return json.loads(raw)


def main(argv):
    ap = argparse.ArgumentParser(prog="deep-research/compress")
    ap.add_argument("--input", default=None, help="query+sources payload JSON (default stdin)")
    ap.add_argument("--max-chars", type=int, default=None, help="override total char budget")
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    payload = _load(args.input)
    if not isinstance(payload, dict):
        raise ValueError("input must be a JSON object with 'query' and 'sources'")
    if args.max_chars is not None:
        payload["max_chars"] = args.max_chars
    data = compress(payload)

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
