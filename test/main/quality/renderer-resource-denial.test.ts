import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { analyzeWebAppLogs, expectedBrowserDenialIndices, expectedResourceDenialIndex,
  type BrowserDenialObservation } from '../../e2e/fixtures/web-app-log-analysis';

const detail = 'Failed to load resource: the server responded with a status of 403 (Forbidden)';
const url = 'chat-app://fixture/index.html?denial-probe=one';
const record = { diagnosticIndex: 2, type: 'error', url, detail };
const request = { url, after: 2, status: 403 };
const receipt = { start: 2, end: 2, diagnosticIndex: 2, reason: 'expected-resource-denial' as const,
  requestHash: 'a'.repeat(64), status: 403 };
const log = `[main:stdout] fixture ready\n[renderer:error] ${detail}\n`;

describe('expected browser resource denial evidence', () => {
  it('attributes only the exact request and phase while retaining original severity', () => {
    expect(expectedResourceDenialIndex([record], request)).toBe(2);
    expect(analyzeWebAppLogs(log).passed).toBe(false);
    const result = analyzeWebAppLogs(log, [receipt]);
    expect(result).toMatchObject({ passed: true, requiresReview: true, coveragePassed: true,
      expectedResourceDenialCount: 1, originalLevelCounts: { error: 1 }, levelCounts: { error: 0, warn: 1 } });
    expect(result.analyzedLineCount).toBe(result.capturedLineCount);
    expect(result.findings).toContainEqual(expect.objectContaining({ source: 'expected-resource-denial', severity: 'warning' }));
  });
  it.each([
    ['different request', { ...record, url: url + '-other' }],
    ['earlier phase', { ...record, diagnosticIndex: 1 }],
    ['page exception', { ...record, type: 'pageerror' }],
    ['different error', { ...record, detail: 'Unexpected permission failure' }],
    ['missing browser location', { ...record, url: undefined }],
  ])('rejects %s', (_name, candidate) => {
    expect(() => expectedResourceDenialIndex([candidate], request)).toThrow('exactly one attributed');
  });
  it('rejects missing, duplicate and successful response evidence', () => {
    expect(() => expectedResourceDenialIndex([], request)).toThrow();
    expect(() => expectedResourceDenialIndex([record, { ...record, diagnosticIndex: 3 }], request)).toThrow();
    expect(() => expectedResourceDenialIndex([record], { ...request, status: 200 })).toThrow();
  });
  it('keeps an unrelated or later identical 403 fatal', () => {
    const result = analyzeWebAppLogs(log + `[renderer:error] ${detail}\n`, [receipt]);
    expect(result).toMatchObject({ passed: false, coveragePassed: true, expectedResourceDenialCount: 1,
      originalLevelCounts: { error: 2 }, levelCounts: { error: 1, warn: 1 } });
  });
  it.each([
    { ...receipt, status: 200 }, { ...receipt, requestHash: '' }, { ...receipt, end: 3 },
  ])('fails closed on invalid denial receipts', candidate => {
    expect(() => analyzeWebAppLogs(log, [candidate])).toThrow();
  });
  it('cannot classify an unrelated error using a denial receipt', () => {
    expect(() => analyzeWebAppLogs(log.replace(detail, 'Unexpected error'), [receipt])).toThrow();
  });
});

describe('expected CORS/CSP denial receipts', () => {
  const target = 'chat-app://foreign/index.html';
  const origin = 'chat-app://current';
  const cases: Array<[BrowserDenialObservation['kind'], string, string]> = [
    ['cors-preflight',
      `Access to fetch at '${target}' from origin '${origin}' has been blocked by CORS policy: Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present on the requested resource.`,
      'Failed to load resource: net::ERR_FAILED'],
    ['cors-scheme',
      `Access to fetch at '${target}' from origin '${origin}' has been blocked by CORS policy: Cross origin requests are only supported for protocol schemes: chat-media, chrome, chrome-extension, chrome-untrusted, data, http, https.`,
      'Failed to load resource: net::ERR_FAILED'],
    ['csp-connect',
      `Connecting to '${target}' violates the following Content Security Policy directive: "connect-src 'self' http: https: ws: wss:". The action has been blocked.`,
      `Fetch API cannot load ${target}. Refused to connect because it violates the document's Content Security Policy.`],
  ];
  it.each(cases)('attributes only the observed %s pair and preserves raw errors', (kind, first, second) => {
    const records = [first, second].map((detail, i) => ({ type: 'error', diagnosticIndex: i + 2, detail }));
    const observation = { kind, url: target, origin, after: 2 };
    expect(expectedBrowserDenialIndices(records, observation)).toEqual([2, 3]);
    const raw = [first, second].map(detail => `[renderer:error] ${detail}`).join('\n');
    expect(analyzeWebAppLogs(raw).passed).toBe(false);
    const receipts = [first, second].map((detail, i) => ({ start: i + 1, end: i + 1, diagnosticIndex: i + 2,
      reason: 'expected-browser-denial' as const, messageHash: createHash('sha256').update(detail).digest('hex') }));
    expect(analyzeWebAppLogs(raw, receipts)).toMatchObject({ passed: true, coveragePassed: true,
      originalLevelCounts: { error: 2 }, levelCounts: { error: 0, warn: 2 }, expectedBrowserDenialCount: 2 });
    expect(analyzeWebAppLogs(raw + '\n[renderer:error] Failed to load resource: net::ERR_FAILED', receipts).passed).toBe(false);
    for (const wrong of [{ ...observation, url: target + '-other' }, { ...observation, after: 3 }]) {
      expect(() => expectedBrowserDenialIndices(records, wrong)).toThrow();
    }
    expect(() => expectedBrowserDenialIndices(records.slice(0, 1), observation)).toThrow();
    expect(() => expectedBrowserDenialIndices([...records, { ...records[1], diagnosticIndex: 4 }], observation)).toThrow();
    expect(() => expectedBrowserDenialIndices(records.map(record => ({ ...record, type: 'pageerror' })), observation)).toThrow();
    expect(() => analyzeWebAppLogs(raw.replace(first, 'Unrelated error'), receipts)).toThrow();
    expect(() => analyzeWebAppLogs(raw, [{ ...receipts[0], end: 2 }])).toThrow();
  });
  it('rejects missing/invalid observations before accepting any receipt', () => {
    const request: BrowserDenialObservation = { kind: 'cors-preflight', url: target, origin, after: 0 };
    for (const wrong of [{ ...request, origin: '' }, { ...request, after: -1 },
      { ...request, url: target + '\nforged' }, { ...request, kind: 'unknown' as any }]) {
      expect(() => expectedBrowserDenialIndices([], wrong)).toThrow();
    }
  });
});
