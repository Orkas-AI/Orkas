import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MAX_EVIDENCE_FILE_BYTES,
  _resetDeepResearchEvidenceIndexForTest,
  captureDeepResearchWebFetchEvidence,
  deepResearchEvidenceFile,
} from '../../../../src/main/model/core-agent/deep-research-evidence';

describe('deep research evidence capture', () => {
  it('persists a hashed host snapshot from a successful web fetch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-deep-evidence-'));
    try {
      const file = deepResearchEvidenceFile(root);
      const capture = captureDeepResearchWebFetchEvidence({
        content: [
          'Title: Official guide',
          'URL: https://example.test/guide#install',
          'Accessed at: 2026-08-21T00:00:00.000Z',
          '',
          'The desktop application supports Windows and macOS.',
        ].join('\n'),
      }, file, '2026-08-21T00:00:00.000Z');

      expect(capture).toEqual({ captured: true });
      const row = JSON.parse(fs.readFileSync(file, 'utf8').trim());
      expect(row).toMatchObject({
        schema_version: 1,
        canonical_url: 'https://example.test/guide',
        captured_at: '2026-08-21T00:00:00.000Z',
      });
      expect(row.content_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(row.text).toContain('supports Windows and macOS');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stores one snapshot per source and keeps the file under the verifier cap', () => {
    // Past 4 MiB the skill discards every snapshot; repeated fetches of the
    // same page across turns used to grow the file without bound
    // (2026-08-28 review C-3).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-deep-evidence-'));
    try {
      const file = deepResearchEvidenceFile(root);
      const fetchOf = (n: number) => ({
        content: ['Title: Page', `URL: https://example.test/page-${n}`, '', 'body '.repeat(2500)].join('\n'),
      });
      expect(captureDeepResearchWebFetchEvidence(fetchOf(1), file)).toEqual({ captured: true });
      expect(captureDeepResearchWebFetchEvidence(fetchOf(1), file)).toEqual({ captured: false, reason: 'duplicate' });
      expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);

      for (let n = 2; n <= 400; n += 1) captureDeepResearchWebFetchEvidence(fetchOf(n), file);
      const size = fs.statSync(file).size;
      expect(size).toBeLessThanOrEqual(MAX_EVIDENCE_FILE_BYTES);
      const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(rows.at(-1).canonical_url).toBe('https://example.test/page-400');
      expect(rows.length).toBeGreaterThan(250);
      expect(rows.length).toBeLessThan(400);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('dedupes from the per-file index and rebuilds it when the file changes underneath', () => {
    // Every successful fetch used to read and JSON.parse the whole evidence
    // file for one key. With the index, a duplicate check needs no read at
    // all (proved by observing actual reads), while an external rewrite
    // is still honored because the index is keyed on the file revision.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-deep-evidence-index-'));
    try {
      _resetDeepResearchEvidenceIndexForTest();
      const file = deepResearchEvidenceFile(root);
      const fetchOf = (n: number) => ({
        content: ['Title: Page', `URL: https://example.test/page-${n}`, '', `body ${n}`].join('\n'),
      });
      expect(captureDeepResearchWebFetchEvidence(fetchOf(1), file)).toEqual({ captured: true });
      const readSpy = vi.spyOn(fs, 'readFileSync');
      syncBuiltinESMExports();
      try {
        expect(captureDeepResearchWebFetchEvidence(fetchOf(1), file)).toEqual({ captured: false, reason: 'duplicate' });
        expect(readSpy.mock.calls.filter(([target]) => String(target) === file)).toHaveLength(0);
      } finally {
        readSpy.mockRestore();
        syncBuiltinESMExports();
      }

      // Another process (or a crash trim) rewrites the file: the next capture
      // must see its rows rather than the stale index.
      const external = JSON.parse(fs.readFileSync(file, 'utf8').trim());
      const foreign = { ...external, canonical_url: 'https://example.test/page-2', content_sha256: 'x'.repeat(64) };
      fs.writeFileSync(file, `${JSON.stringify(external)}\n${JSON.stringify(foreign)}\n`, 'utf8');
      const secondFetch = fetchOf(2);
      // Same URL as the foreign row but different content hash: not a duplicate.
      expect(captureDeepResearchWebFetchEvidence(secondFetch, file)).toEqual({ captured: true });
      expect(captureDeepResearchWebFetchEvidence(secondFetch, file)).toEqual({ captured: false, reason: 'duplicate' });
      expect(fs.readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not replace evidence with a compacted cache replay', () => {
    const capture = captureDeepResearchWebFetchEvidence({
      webSourceUrl: 'https://example.test/guide',
      content: [
        'WEB_FETCH_RUN_CACHE_HIT: no network request was made.',
        'URL: https://example.test/guide',
      ].join('\n'),
    }, '/unused/evidence.jsonl');

    expect(capture).toEqual({ captured: false, reason: 'cache_replay' });
  });

  it('uses the fetched response identity instead of a URL line supplied by the page', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-evidence-origin-'));
    const body = 'URL: https://unrelated.test/spoofed\nThe app requires an initial download.';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
      headers: { 'content-type': 'text/plain' },
    })));
    try {
      const { webFetchTool } = await import('../../../../src/core-agent/src/tools/web-fetch');
      const result = await webFetchTool.execute({ url: 'https://example.test/official' }, { state: {} });
      const file = deepResearchEvidenceFile(root);
      // Ordinary result transformations copy the envelope; provenance follows it.
      expect(captureDeepResearchWebFetchEvidence({ ...result }, file).captured).toBe(true);
      const row = JSON.parse(fs.readFileSync(file, 'utf8').trim());
      expect(row).toMatchObject({ canonical_url: 'https://example.test/official', text: body });
    } finally {
      vi.unstubAllGlobals();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['not a URL', 'file:///private/source', 'javascript:alert(1)'])('rejects invalid explicit source identity %s', (webSourceUrl) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-evidence-invalid-origin-'));
    try {
      const file = deepResearchEvidenceFile(root);
      expect(captureDeepResearchWebFetchEvidence({
        webSourceUrl, content: 'URL: https://unrelated.test/fallback\nClaimed source fact.',
      }, file)).toEqual({ captured: false, reason: 'not_web_source' });
      expect(fs.existsSync(file)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['overwrite', 'replace'])('recaptures evidence after a same-size %s preserving mtime', async (operation) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-evidence-preserved-time-'));
    try {
      const file = deepResearchEvidenceFile(root);
      const fetched = { content: 'Title: Page\nURL: https://example.test/page-1\nsource evidence' };
      expect(captureDeepResearchWebFetchEvidence(fetched, file).captured).toBe(true);
      const fixedTime = new Date('2026-01-01T00:00:00Z');
      fs.utimesSync(file, fixedTime, fixedTime);
      expect(captureDeepResearchWebFetchEvidence(fetched, file).reason).toBe('duplicate');
      const before = fs.readFileSync(file, 'utf8');
      await new Promise(resolve => setTimeout(resolve, 20));
      const target = operation === 'replace' ? `${file}.replacement` : file;
      fs.writeFileSync(target, before.replace('example.test/page-1', 'example.test/page-2'));
      fs.utimesSync(target, fixedTime, fixedTime);
      if (operation === 'replace') fs.renameSync(target, file);
      expect(fs.statSync(file).size).toBe(Buffer.byteLength(before));
      expect(fs.statSync(file).mtimeMs).toBe(fixedTime.getTime());

      expect(captureDeepResearchWebFetchEvidence(fetched, file)).toEqual({ captured: true });
      const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows).toHaveLength(2);
      expect(rows.at(-1)).toMatchObject({ canonical_url: 'https://example.test/page-1', text: fetched.content });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      _resetDeepResearchEvidenceIndexForTest();
    }
  });

  it('captures a continuation window of a long page as another snapshot of the same source', async () => {
    // A decisive passage below the first 12,000 characters must remain
    // verifiable after the Agent reads it through an offset window.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-deep-evidence-window-'));
    const html = '<html><head><title>Model release</title></head><body>'
      + `<p>${'Opening background sentence. '.repeat(500)}</p>`
      + '<h2>Results</h2><p>LATE_RESULT_QUOTE: the model scored 95.9 on the held-out suite.</p>'
      + '</body></html>';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })));
    try {
      const { webFetchTool } = await import('../../../../src/core-agent/src/tools/web-fetch');
      const file = deepResearchEvidenceFile(root);
      const ctx = { state: { runScopedLedger: new Map<string, unknown>() } };
      const first = await webFetchTool.execute({ url: 'https://example.test/release', maxChars: 12_000 }, ctx);
      const offset = Number(/"offset": (\d+)/.exec(first.content)?.[1]);
      const window = await webFetchTool.execute(
        { url: 'https://example.test/release', maxChars: 12_000, offset },
        ctx,
      );

      expect(captureDeepResearchWebFetchEvidence(first, file)).toEqual({ captured: true });
      expect(captureDeepResearchWebFetchEvidence(window, file)).toEqual({ captured: true });
      const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(rows.map((row) => row.canonical_url)).toEqual([
        'https://example.test/release',
        'https://example.test/release',
      ]);
      expect(rows[0].text).not.toContain('LATE_RESULT_QUOTE');
      expect(rows[1].text).toContain('LATE_RESULT_QUOTE: the model scored 95.9 on the held-out suite.');
    } finally {
      vi.unstubAllGlobals();
      _resetDeepResearchEvidenceIndexForTest();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not persist failed or URL-less tool output as source evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-deep-evidence-'));
    try {
      const file = deepResearchEvidenceFile(root);
      const failed = captureDeepResearchWebFetchEvidence({
        webSourceUrl: 'https://example.test/guide',
        content: [
          'URL: https://example.test/guide',
          'E_FETCH_FAILED: upstream request timed out',
        ].join('\n'),
        isError: true,
      }, file);
      const urlLess = captureDeepResearchWebFetchEvidence({
        content: 'The model supplied text without a fetched source URL.',
      }, file);

      expect(failed).toEqual({ captured: false, reason: 'not_web_source' });
      expect(urlLess).toEqual({ captured: false, reason: 'not_web_source' });
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
