/**
 * `research_verify_citations` tool — the host-side, provenance-bound half of the
 * deep-research anti-fabrication guarantee, owned by the research agents
 * (TOOL_CATALOG `ownerAgent`).
 *
 * The deep-research `citations` skill (Python, stdlib) verifies that each quoted
 * claim actually appears in its cited source — but it can only check the quote
 * against `sources[].text` that the MODEL puts in the payload. A stdlib skill
 * subprocess cannot reach the Result Store where `web_fetch` spills large pages,
 * so for any non-trivial fetch the model has to re-type the source text from a
 * 600-token preview / memory. If it reconstructs the passage (even in good
 * faith), a fabricated quote can "verify" against the model's own paraphrase —
 * the audited party supplies the evidence.
 *
 * This tool closes that hole: the caller passes each source's Result Store
 * `result_ref` (returned by `web_fetch` when the page spilled) plus its
 * claims-with-quotes, and the HOST loads the real fetched text by ref and runs
 * the verification against text the model never re-typed. Quote matching is
 * formatting-insensitive but NOT paraphrase-tolerant, exactly mirroring the
 * skill's `citations.py` semantics (MIN_QUOTE_CHARS, NFKC + smart-quote/dash
 * normalization, strict DOI syntax) so the two stay one contract. Reference
 * numbering / presentation stays in the skill — it needs no source text and is
 * not a fabrication surface.
 *
 * A source given inline `text` with no `result_ref` (a small inline fetch the
 * model still holds verbatim) is still checked, but its verdicts are marked
 * `provenance: "model_supplied"` and counted in `unverified_provenance_claims`
 * so a report can tell independently-verified claims from model-retyped ones.
 *
 * Read-only, local, no Tool Execution Access. Owned by the deep-research + data
 * research agents (hidden from the commander). Pure helpers are exported for
 * unit testing without the Result Store.
 */

import * as fs from 'node:fs';
import type { AgentTool, ToolResult } from '#core-agent';
import { resolveToolResultRef } from './tool-result-tools';
import { createLogger } from '../../logger';

const log = createLogger('research-verify-tool');

// Mirror citations.py: a quote shorter than this (after normalization) trivially
// substring-matches almost any source, so it is "too_short", not "verified".
export const MIN_QUOTE_CHARS = 12;
// Bound host work per call; a research turn cites far fewer sources than this.
const MAX_SOURCES = 256;
const MAX_CLAIMS = 512;
// Cap the bytes we load per source so a hostile/huge spill can't blow memory.
const MAX_SOURCE_TEXT_BYTES = 4 * 1024 * 1024;

// DOI syntax per the DOI handbook (mirror of citations.py `_DOI_RE`).
const DOI_RE = /10\.\d{4,9}\/[-._;()/:a-z0-9]+/i;
const DOI_ANCHORED_RE = /^10\.\d{4,9}\/[-._;()/:a-z0-9]+$/i;

const SMART_MAP: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '–': '-', '—': '-', '―': '-', '−': '-',
  ' ': ' ', '…': '...',
};

/** Collapse away differences that are NOT fabrication: unicode form, smart
 *  quotes/dashes, case, whitespace runs. Word content is preserved, so a
 *  paraphrase still fails to match — mirror of citations.py `_normalize_text`. */
export function normalizeText(s: string): string {
  if (!s) return '';
  let out = s.normalize('NFKC');
  out = Array.from(out).map((ch) => SMART_MAP[ch] ?? ch).join('');
  out = out.replace(/\s+/g, ' ').trim();
  return out.toLowerCase();
}

/** Canonical key for citation-by-url resolution (mirror of `_normalize_url`):
 *  lowercase scheme+host, drop fragment and a trailing slash, keep path case. */
export function normalizeUrl(u: string): string {
  if (!u) return '';
  let parsed: URL;
  try {
    parsed = new URL(u.trim());
  } catch {
    return u.trim().toLowerCase();
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  let host = parsed.hostname.toLowerCase();
  if (parsed.port) host = `${host}:${parsed.port}`;
  let path = parsed.pathname || '';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const query = parsed.search ? parsed.search.slice(1) : '';
  return query ? `${scheme}://${host}${path}?${query}` : `${scheme}://${host}${path}`;
}

export type QuoteStatus = 'verified' | 'too_short' | 'not_found' | 'missing';
export type DoiStatus = 'verified' | 'malformed' | 'unverified' | 'absent';

/** verified | too_short | not_found | missing — formatting-insensitive substring
 *  test; a paraphrase or invented quote is `not_found` (mirror `_check_quote`). */
export function checkQuote(quote: string, sourceTextNorm: string): QuoteStatus {
  if (!quote) return 'missing';
  const nq = normalizeText(quote);
  if (nq.length < MIN_QUOTE_CHARS) return 'too_short';
  return nq && sourceTextNorm.includes(nq) ? 'verified' : 'not_found';
}

/** verified | malformed | unverified | absent — a well-formed DOI must resolve to
 *  the cited source (its `doi` field or its fetched text) (mirror `_check_doi`). */
export function checkDoi(doi: string, sourceDoi: string, sourceTextNorm: string): DoiStatus {
  if (!doi) return 'absent';
  if (!DOI_ANCHORED_RE.test(doi.trim())) return 'malformed';
  const norm = doi.trim().toLowerCase();
  const sd = (sourceDoi || '').trim().toLowerCase();
  if (sd) {
    const m = sd.match(DOI_RE);
    if (m && m[0].toLowerCase() === norm) return 'verified';
  }
  return sourceTextNorm.includes(norm) ? 'verified' : 'unverified';
}

export type SourceInput = {
  id?: unknown;
  result_ref?: unknown;
  url?: unknown;
  doi?: unknown;
  text?: unknown;
};

export type ResolvedSource = {
  id: string | undefined;
  url: string;
  doi: string;
  textNorm: string;
  provenance: 'fetched' | 'model_supplied' | 'none';
  loadError?: string;
};

/** Load each source's AUTHORITATIVE text: by Result Store ref (host-loaded, the
 *  model never re-typed it) when a `result_ref` is given, else the inline `text`
 *  flagged as model-supplied. Returns lookup maps by id and normalized url. */
export function resolveSources(
  sources: SourceInput[],
  loadRefText: (ref: string) => { ok: true; text: string } | { ok: false; error: string },
): { list: ResolvedSource[]; byId: Map<string, ResolvedSource>; byUrl: Map<string, ResolvedSource> } {
  const list: ResolvedSource[] = [];
  const byId = new Map<string, ResolvedSource>();
  const byUrl = new Map<string, ResolvedSource>();
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const id = src.id != null ? String(src.id) : undefined;
    const url = typeof src.url === 'string' ? src.url : '';
    const doi = typeof src.doi === 'string' ? src.doi : '';
    const ref = typeof src.result_ref === 'string' ? src.result_ref.trim() : '';
    const inlineText = typeof src.text === 'string' ? src.text : '';

    let textNorm = '';
    let provenance: ResolvedSource['provenance'] = 'none';
    let loadError: string | undefined;
    if (ref) {
      const loaded = loadRefText(ref);
      if (loaded.ok) {
        textNorm = normalizeText((loaded as { text: string }).text);
        provenance = 'fetched';
      } else {
        // Cast: tsconfig runs with strictNullChecks off, which collapses the
        // `ok: true | false` discriminant to `boolean` and defeats narrowing.
        loadError = (loaded as { error: string }).error;
        provenance = 'none';
      }
    } else if (inlineText) {
      textNorm = normalizeText(inlineText);
      provenance = 'model_supplied';
    }

    const resolved: ResolvedSource = { id, url, doi, textNorm, provenance, ...(loadError ? { loadError } : {}) };
    list.push(resolved);
    // First occurrence wins, keeping resolution stable (mirror `_index_sources`).
    if (id != null && !byId.has(id)) byId.set(id, resolved);
    const key = normalizeUrl(url);
    if (key && !byUrl.has(key)) byUrl.set(key, resolved);
  }
  return { list, byId, byUrl };
}

export type CitationInput = { source?: unknown; url?: unknown; quote?: unknown; doi?: unknown };
export type CitationVerdict = {
  source: unknown;
  url: unknown;
  resolved_by: 'id' | 'url' | 'unknown';
  quote_status: QuoteStatus | 'unverifiable';
  doi_status: DoiStatus | 'unverifiable';
  verdict: 'verified' | 'weak' | 'flagged';
  provenance: ResolvedSource['provenance'];
  source_load_error?: string;
};

/** Classify one citation against the host-loaded sources (mirror of
 *  `_classify_citation` + verdict rules in citations.py `verify`). */
export function classifyCitation(
  cit: CitationInput,
  byId: Map<string, ResolvedSource>,
  byUrl: Map<string, ResolvedSource>,
): CitationVerdict {
  const citSource = cit.source != null ? String(cit.source) : undefined;
  const citUrl = typeof cit.url === 'string' ? cit.url : '';
  let src: ResolvedSource | undefined;
  let how: 'id' | 'url' | 'unknown' = 'unknown';
  if (citSource != null && byId.has(citSource)) { src = byId.get(citSource); how = 'id'; }
  else {
    const key = normalizeUrl(citUrl);
    if (key && byUrl.has(key)) { src = byUrl.get(key); how = 'url'; }
  }

  const base = { source: cit.source ?? null, url: cit.url ?? null, resolved_by: how };
  if (!src) {
    // A citation to a source that was never fetched is the clearest fabrication
    // signal — no text exists to verify against.
    return { ...base, quote_status: 'unverifiable', doi_status: 'unverifiable', verdict: 'flagged', provenance: 'none' };
  }
  // A ref that was supplied but could not be loaded is treated the same as an
  // unfetched source: we have no authoritative text, so we cannot confirm it.
  if (src.provenance === 'none') {
    return {
      ...base,
      quote_status: 'unverifiable',
      doi_status: 'unverifiable',
      verdict: 'flagged',
      provenance: 'none',
      ...(src.loadError ? { source_load_error: src.loadError } : {}),
    };
  }

  const q = checkQuote(typeof cit.quote === 'string' ? cit.quote : '', src.textNorm);
  const d = checkDoi(typeof cit.doi === 'string' ? cit.doi : '', src.doi, src.textNorm);
  let verdict: CitationVerdict['verdict'];
  if (q === 'not_found' || d === 'malformed' || d === 'unverified') verdict = 'flagged';
  else if (q === 'verified') verdict = 'verified';
  else verdict = 'weak';
  return { ...base, quote_status: q, doi_status: d, verdict, provenance: src.provenance };
}

export type VerifyPayload = { sources?: unknown; claims?: unknown };

/** Run the full verification. Pure over an injected ref loader so it is
 *  unit-testable without the Result Store. */
export function verifyCitations(
  payload: VerifyPayload,
  loadRefText: (ref: string) => { ok: true; text: string } | { ok: false; error: string },
): Record<string, unknown> {
  const sources = Array.isArray(payload.sources) ? (payload.sources as SourceInput[]).slice(0, MAX_SOURCES) : [];
  const claims = Array.isArray(payload.claims) ? (payload.claims as Array<Record<string, unknown>>).slice(0, MAX_CLAIMS) : [];
  if (!sources.length) {
    return {
      abstain: true,
      abstain_reason: 'no_sources',
      summary: { claims: claims.length, supported: 0, unsupported: claims.length, citations: 0, verified: 0, weak: 0, flagged: 0, unverified_provenance_claims: 0 },
      claims: [],
      flags: [],
    };
  }

  const { byId, byUrl } = resolveSources(sources, loadRefText);
  let nVerified = 0, nWeak = 0, nFlagged = 0, nCit = 0, nSupported = 0, nUnverifiedProvenance = 0;
  const outClaims: Array<Record<string, unknown>> = [];
  const flags: Array<Record<string, unknown>> = [];

  claims.forEach((claim, ci) => {
    if (!claim || typeof claim !== 'object') return;
    const cits = Array.isArray(claim.citations) ? (claim.citations as CitationInput[]) : [];
    const classified: CitationVerdict[] = [];
    cits.forEach((cit, cj) => {
      if (!cit || typeof cit !== 'object') return;
      nCit += 1;
      const info = classifyCitation(cit, byId, byUrl);
      if (info.verdict === 'verified') nVerified += 1;
      else if (info.verdict === 'weak') nWeak += 1;
      else { nFlagged += 1; flags.push({ claim: ci, citation: cj, issue: flagIssue(info) }); }
      classified.push(info);
    });
    const supported = classified.some((c) => c.verdict === 'verified' || c.verdict === 'weak');
    if (supported) nSupported += 1;
    // A claim whose only support rests on model-retyped text is NOT independently
    // verified — surface it so the report can distinguish it.
    const onlyModelSupplied = supported
      && classified.every((c) => c.verdict === 'flagged' || c.provenance !== 'fetched')
      && classified.some((c) => c.provenance === 'model_supplied');
    if (onlyModelSupplied) nUnverifiedProvenance += 1;
    outClaims.push({
      text: claim.text ?? null,
      supported,
      ...(onlyModelSupplied ? { unverified_provenance: true } : {}),
      citations: classified,
    });
  });

  return {
    abstain: false,
    summary: {
      claims: outClaims.length,
      supported: nSupported,
      unsupported: outClaims.length - nSupported,
      citations: nCit,
      verified: nVerified,
      weak: nWeak,
      flagged: nFlagged,
      unverified_provenance_claims: nUnverifiedProvenance,
    },
    claims: outClaims,
    flags,
  };
}

function flagIssue(info: CitationVerdict): string {
  if (info.resolved_by === 'unknown') return 'phantom_source';
  if (info.provenance === 'none') return 'source_unreadable';
  if (info.quote_status === 'not_found') return 'quote_not_found';
  if (info.doi_status === 'malformed') return 'doi_malformed';
  if (info.doi_status === 'unverified') return 'doi_unverified';
  return 'flagged';
}

export function createResearchVerifyTool(opts: { toolResultsDir: string }): AgentTool {
  const loadRefText = (ref: string): { ok: true; text: string } | { ok: false; error: string } => {
    const resolved = resolveToolResultRef(opts.toolResultsDir, ref);
    // Cast on the false branch: strictNullChecks-off collapses the discriminant.
    if (!resolved.ok) return { ok: false, error: (resolved as { code: string }).code };
    try {
      const fd = fs.openSync(resolved.path, 'r');
      try {
        const buf = Buffer.allocUnsafe(MAX_SOURCE_TEXT_BYTES);
        const read = fs.readSync(fd, buf, 0, MAX_SOURCE_TEXT_BYTES, 0);
        return { ok: true, text: buf.subarray(0, read).toString('utf8') };
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return { ok: false, error: `E_RESULT_REF_READ: ${(err as Error).message}` };
    }
  };

  return {
    name: 'research_verify_citations',
    description:
      'Verify exact claim quotes and optional DOIs against fetched source text, returning per-citation verdicts and provenance. Prefer web_fetch result_ref evidence; inline text remains model-supplied and cannot establish fetched provenance. Formatting differences are tolerated, but paraphrases are not.',
    inputSchema: {
      type: 'object',
      properties: {
        sources: {
          type: 'array',
          description: 'Fetched sources. Prefer result_ref (the web_fetch Result Store ref) so verification uses host-loaded text; inline text is accepted but flagged as model_supplied.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable source id cited by claims.' },
              result_ref: { type: 'string', description: 'Result Store ref from web_fetch (authoritative text loaded host-side).' },
              url: { type: 'string', description: 'Source url (also used for citation-by-url resolution).' },
              doi: { type: 'string', description: 'Optional DOI of the source.' },
              text: { type: 'string', description: 'Inline source text — only for small inline fetches with no result_ref; flagged as model_supplied.' },
            },
          },
        },
        claims: {
          type: 'array',
          description: 'Claims to verify. Each has citations pointing at a source id/url with the exact quote (and optional DOI) that should back it.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The claim text (echoed back).' },
              citations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    source: { type: 'string', description: 'Cited source id.' },
                    url: { type: 'string', description: 'Cited source url (fallback resolution).' },
                    quote: { type: 'string', description: 'Exact quote that must appear in the cited source.' },
                    doi: { type: 'string', description: 'Optional DOI that must resolve to the cited source.' },
                  },
                },
              },
            },
          },
        },
      },
      required: ['sources', 'claims'],
    },
    async execute(input): Promise<ToolResult> {
      const payload = (input && typeof input === 'object') ? (input as VerifyPayload) : {};
      if (!Array.isArray(payload.sources) || !Array.isArray(payload.claims)) {
        return { content: 'sources and claims must both be arrays', isError: true };
      }
      try {
        const result = verifyCitations(payload, loadRefText);
        return { content: JSON.stringify(result) };
      } catch (err) {
        log.warn(`verify failed: ${(err as Error).message}`);
        return { content: `E_VERIFY_FAILED: ${(err as Error).message}`, isError: true };
      }
    },
  };
}
