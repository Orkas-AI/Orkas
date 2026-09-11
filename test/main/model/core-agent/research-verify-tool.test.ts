import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createResearchVerifyTool,
  verifyCitations,
  normalizeText,
  normalizeUrl,
  checkQuote,
  checkDoi,
} from '../../../../src/main/model/core-agent/research-verify-tool';

// A verified/weak/flagged verdict never depends on model-supplied text when a
// result_ref is present: the loader returns the REAL fetched text.
const loaderFrom = (byRef: Record<string, string>) =>
  (ref: string): { ok: true; text: string } | { ok: false; error: string } =>
    ref in byRef ? { ok: true, text: byRef[ref] } : { ok: false, error: 'E_RESULT_REF_MISSING' };

const claim = (quote: string, extra: Record<string, unknown> = {}) => ({
  text: 'a claim',
  citations: [{ source: 's1', quote, ...extra }],
});

describe('research_verify_citations › host-loaded text is authoritative (DR-1)', () => {
  it('verifies a quote that appears in the REF-loaded text, not the model inline text', () => {
    const out = verifyCitations({
      // The model supplies a paraphrase inline, but a real ref is present.
      sources: [{ id: 's1', result_ref: 'web_fetch.' + 'a'.repeat(64), text: 'The sky is green and made of cheese.' }],
      claims: [claim('The sky is blue')],
    }, loaderFrom({ ['web_fetch.' + 'a'.repeat(64)]: 'Observations confirm the sky is blue on a clear day.' }));
    expect((out.summary as any).verified).toBe(1);
    expect((out.claims as any[])[0].supported).toBe(true);
    expect((out.claims as any[])[0].citations[0].provenance).toBe('fetched');
  });

  it('FLAGS a fabricated quote even when the model inline text contains it (ref wins)', () => {
    const out = verifyCitations({
      // Inline text = the model's fabrication; ref text = what was actually fetched.
      sources: [{ id: 's1', result_ref: 'web_fetch.' + 'b'.repeat(64), text: 'The sky is green and made of cheese.' }],
      claims: [claim('the sky is green and made of cheese')],
    }, loaderFrom({ ['web_fetch.' + 'b'.repeat(64)]: 'Observations confirm the sky is blue on a clear day.' }));
    expect((out.summary as any).flagged).toBe(1);
    expect((out.summary as any).verified).toBe(0);
    expect((out.claims as any[])[0].supported).toBe(false);
    expect((out.flags as any[])[0].issue).toBe('quote_not_found');
  });

  it('flags a citation whose result_ref cannot be loaded (no authoritative text)', () => {
    const out = verifyCitations({
      sources: [{ id: 's1', result_ref: 'web_fetch.' + 'c'.repeat(64), text: 'model text that must not be trusted' }],
      claims: [claim('model text that must not be trusted')],
    }, loaderFrom({})); // ref not found
    expect((out.summary as any).flagged).toBe(1);
    expect((out.claims as any[])[0].citations[0].provenance).toBe('none');
    expect((out.flags as any[])[0].issue).toBe('source_unreadable');
  });
});

describe('research_verify_citations › verdicts mirror citations.py semantics', () => {
  const src = (text: string, extra: Record<string, unknown> = {}) =>
    [{ id: 's1', result_ref: 'web_fetch.' + 'd'.repeat(64), ...extra }];
  const load = (text: string) => loaderFrom({ ['web_fetch.' + 'd'.repeat(64)]: text });

  it('flags a phantom source (cited id was never fetched)', () => {
    const out = verifyCitations({
      sources: [{ id: 's1', result_ref: 'web_fetch.' + 'd'.repeat(64) }],
      claims: [{ text: 'x', citations: [{ source: 'nope', quote: 'anything at all here' }] }],
    }, load('some fetched text'));
    expect((out.flags as any[])[0].issue).toBe('phantom_source');
    expect((out.claims as any[])[0].citations[0].verdict).toBe('flagged');
  });

  it('reports a too-short quote as weak, not verified', () => {
    const out = verifyCitations({ sources: src(''), claims: [claim('short')] }, load('short appears in here'));
    expect((out.claims as any[])[0].citations[0].quote_status).toBe('too_short');
    expect((out.claims as any[])[0].citations[0].verdict).toBe('weak');
    expect((out.claims as any[])[0].supported).toBe(true); // weak still supports
  });

  it('flags a malformed DOI and verifies a real one present in the source text', () => {
    const bad = verifyCitations({ sources: src(''), claims: [claim('a sufficiently long verified quote', { doi: 'nonsense' })] },
      load('a sufficiently long verified quote is right here'));
    expect((bad.claims as any[])[0].citations[0].doi_status).toBe('malformed');
    expect((bad.claims as any[])[0].citations[0].verdict).toBe('flagged');

    const good = verifyCitations({ sources: src(''), claims: [claim('a sufficiently long verified quote', { doi: '10.1000/xyz123' })] },
      load('a sufficiently long verified quote and doi 10.1000/xyz123 here'));
    expect((good.claims as any[])[0].citations[0].doi_status).toBe('verified');
    expect((good.claims as any[])[0].citations[0].verdict).toBe('verified');
  });

  it('abstains when there are no sources', () => {
    const out = verifyCitations({ sources: [], claims: [claim('anything long enough')] }, loaderFrom({}));
    expect(out.abstain).toBe(true);
    expect(out.abstain_reason).toBe('no_sources');
  });
});

describe('research_verify_citations › provenance surfacing (DR-2)', () => {
  it('marks a claim resting only on inline model_supplied text as unverified provenance', () => {
    const out = verifyCitations({
      sources: [{ id: 's1', text: 'the model supplied this passage verbatim inline' }], // no result_ref
      claims: [claim('the model supplied this passage verbatim inline')],
    }, loaderFrom({}));
    expect((out.claims as any[])[0].citations[0].provenance).toBe('model_supplied');
    expect((out.claims as any[])[0].unverified_provenance).toBe(true);
    expect((out.summary as any).unverified_provenance_claims).toBe(1);
  });

  it('does NOT count ref-backed claims as unverified provenance', () => {
    const out = verifyCitations({
      sources: [{ id: 's1', result_ref: 'web_fetch.' + 'e'.repeat(64) }],
      claims: [claim('a real quote loaded from the store')],
    }, loaderFrom({ ['web_fetch.' + 'e'.repeat(64)]: 'here is a real quote loaded from the store indeed' }));
    expect((out.summary as any).unverified_provenance_claims).toBe(0);
    expect((out.claims as any[])[0].unverified_provenance).toBeUndefined();
  });
});

describe('research_verify_citations › pure helpers mirror citations.py', () => {
  it('normalizeText collapses smart quotes / dashes / whitespace / case but not words', () => {
    expect(normalizeText('  The  “Sky”—is\tBLUE  ')).toBe('the "sky"-is blue');
    expect(normalizeText('paraphrased differently')).not.toBe(normalizeText('the original wording'));
  });
  it('checkQuote is formatting-insensitive substring, not paraphrase', () => {
    const t = normalizeText('The quick brown fox jumps over the lazy dog.');
    expect(checkQuote('the QUICK  brown fox', t)).toBe('verified');
    expect(checkQuote('a nimble auburn fox', t)).toBe('not_found');
    expect(checkQuote('short', t)).toBe('too_short');
    expect(checkQuote('', t)).toBe('missing');
  });
  it('checkDoi validates syntax and resolution', () => {
    const t = normalizeText('body mentions 10.1234/abcd here');
    expect(checkDoi('10.1234/abcd', '', t)).toBe('verified');
    expect(checkDoi('10.9999/zzzz', '', t)).toBe('unverified');
    expect(checkDoi('not-a-doi', '', t)).toBe('malformed');
    expect(checkDoi('', '', t)).toBe('absent');
  });
  it('normalizeUrl lowercases host+scheme, drops fragment and trailing slash', () => {
    expect(normalizeUrl('HTTPS://Example.com/Path/#frag')).toBe('https://example.com/Path');
    // Root '/' is kept (only paths longer than 1 char drop the trailing slash),
    // matching citations.py `_normalize_url`; consistency across source+citation
    // is what resolution needs.
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });
});

describe('research_verify_citations › tool reads a real Result Store ref file', () => {
  it('keeps selection and provenance semantics in a compact model-visible description', () => {
    const tool = createResearchVerifyTool({ toolResultsDir: os.tmpdir() });
    expect(tool.description).toContain('returning per-citation verdicts and provenance');
    expect(tool.description).toContain('inline text remains model-supplied');
    expect(tool.description).toContain('paraphrases are not');
    expect(tool.description).not.toContain('no Tool Execution Access');
  });

  it('loads authoritative text from disk by ref and verifies against it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-verify-'));
    try {
      const id = 'f'.repeat(64);
      fs.writeFileSync(path.join(dir, `web_fetch.${id}.txt`), 'The report states that revenue grew 40% year over year.');
      const tool = createResearchVerifyTool({ toolResultsDir: dir });
      const res = await tool.execute({
        sources: [{ id: 's1', result_ref: `web_fetch.${id}`, text: 'revenue fell 40% year over year' }],
        claims: [claim('revenue grew 40% year over year')],
      } as any, {} as any);
      const out = JSON.parse(res.content as string);
      expect(out.summary.verified).toBe(1);
      expect(out.claims[0].citations[0].provenance).toBe('fetched');

      // The model's inline paraphrase ("fell") must NOT verify against the file.
      const res2 = await tool.execute({
        sources: [{ id: 's1', result_ref: `web_fetch.${id}`, text: 'revenue fell 40% year over year' }],
        claims: [claim('revenue fell 40% year over year')],
      } as any, {} as any);
      const out2 = JSON.parse(res2.content as string);
      expect(out2.summary.flagged).toBe(1);
      expect(out2.summary.verified).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('errors when sources/claims are not arrays', async () => {
    const tool = createResearchVerifyTool({ toolResultsDir: os.tmpdir() });
    const res = await tool.execute({ sources: 'x', claims: [] } as any, {} as any);
    expect(res.isError).toBe(true);
  });
});
