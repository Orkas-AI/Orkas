import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
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

  it('does not replace evidence with a compacted cache replay', () => {
    const capture = captureDeepResearchWebFetchEvidence({
      content: [
        'WEB_FETCH_RUN_CACHE_HIT: no network request was made.',
        'URL: https://example.test/guide',
      ].join('\n'),
    }, '/unused/evidence.jsonl');

    expect(capture).toEqual({ captured: false, reason: 'cache_replay' });
  });

  it('does not persist failed or URL-less tool output as source evidence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-deep-evidence-'));
    try {
      const file = deepResearchEvidenceFile(root);
      const failed = captureDeepResearchWebFetchEvidence({
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
