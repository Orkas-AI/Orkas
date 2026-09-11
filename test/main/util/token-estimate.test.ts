import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  capToolResult,
  estimateToolResultTokens,
  persistStreamedToolResult,
  TOOL_RESULT_INLINE_LEDGER_STATE_KEY,
} from '../../../src/main/util/tool-result-cap';

const numericCsv = 'record_id,quantity,price\n' + Array.from({ length: 300 }, (_, i) => (
  `REC-${String(i).padStart(5, '0')},${i % 10},12.75\n`
)).join('');

// Frozen independent counts from tiktoken's o200k_base, not computed by the
// estimator under test. No tokenizer or model service is needed in production
// or CI. These are calibration samples, not claims about every provider's BPE.
const denseSamples = [
  { name: 'numeric CSV with short fields', text: numericCsv, tokens: 3307 },
  {
    name: 'JSON records with identifiers and booleans',
    text: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
      id: `REC-${String(i).padStart(5, '0')}`, quantity: i % 10, active: true,
    }))),
    tokens: 1502,
  },
  {
    name: 'paths with dates and batch numbers',
    text: Array.from({ length: 100 }, (_, i) => (
      `/workspace/reports/2026-09-08/batch-${String(i).padStart(3, '0')}/result.json\n`
    )).join(''),
    tokens: 1800,
  },
  { name: 'unbroken numeric data', text: '1234567890'.repeat(100), tokens: 334 },
];

describe('runtime text-budget calibration', () => {
  it.each(denseSamples)('bounds estimation error for $name', async ({ text, tokens }) => {
    const { estimateTextTokens } = await import('../../../src/core-agent/src/agent/session');
    const estimate = estimateToolResultTokens(text);
    // A lightweight estimate may err in either direction, but must not treat
    // dense data as prose (~2x undercount), or solve that by doubling all input.
    expect(estimate).toBeGreaterThanOrEqual(tokens * 0.8);
    expect(estimate).toBeLessThanOrEqual(tokens * 1.4);
    expect(estimateTextTokens(text)).toBe(estimate);
  });

  it('does not materially inflate ordinary prose or punctuation runs', () => {
    const prose = 'The archive contains completed orders. Read the policy before calculating the totals.\n'.repeat(40);
    expect(estimateToolResultTokens(prose)).toBeLessThanOrEqual(Math.ceil(prose.length / 4) * 1.1);
    for (const symbol of ['-', '=', '_', ' ']) {
      const text = symbol.repeat(1000);
      expect(estimateToolResultTokens(text)).toBeLessThanOrEqual(251);
    }
    const code = 'def total(rows):\n    return sum(row["quantity"] * row["price"] for row in rows)\n'.repeat(40);
    expect(estimateToolResultTokens(code)).toBeLessThanOrEqual(840 * 1.3);
  });

  it('keeps prefix estimates monotone for paging through mixed structured text', async () => {
    const { estimateTextTokens } = await import('../../../src/core-agent/src/agent/session');
    const text = '记录😀\n1\tREC-01234,0,12.75\n{"id":"REC-00123","ok":true}\n---\n';
    let previous = 0;
    for (let end = 0; end <= text.length; end++) {
      const prefix = text.slice(0, end);
      const estimate = estimateToolResultTokens(prefix);
      expect(estimate).toBeGreaterThanOrEqual(previous);
      expect(estimateTextTokens(prefix)).toBe(estimate);
      previous = estimate;
    }
  });

  it('spills dense data losslessly instead of admitting it as low-token prose', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-token-calibration-'));
    try {
      const result = capToolResult('read_files', { content: numericCsv }, { state: {} }, {
        maxInlineTokens: 2000, toolResultsDir: dir,
      });
      expect(result.persistedOutput).toBeDefined();
      expect(result.content).toContain('<persisted-output');
      expect(fs.readFileSync(result.persistedOutput!.path, 'utf8')).toBe(numericCsv);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('charges dense results against the shared round allowance across tools', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-token-calibration-'));
    try {
      const ctx = { state: { [TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
        initialTokens: 6000, remainingTokens: 6000, perResultTokens: 3500,
      } } };
      const opts = { maxInlineTokens: 3500, toolResultsDir: dir };
      expect(capToolResult('read_files', { content: numericCsv }, ctx, opts).content).toBe(numericCsv);
      const second = capToolResult('bash', { content: numericCsv }, ctx, opts);
      expect(second.persistedOutput).toBeDefined();
      expect(fs.readFileSync(second.persistedOutput!.path, 'utf8')).toBe(numericCsv);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['1234567890', '---::___', '记录😀123---'])('matches streaming and inline counts across a 64 KiB boundary: %s', (tail) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-token-calibration-'));
    try {
      // Split digit/punctuation runs and UTF-8 sequences inside decoder chunks.
      const original = 'a'.repeat(65534) + tail.repeat(20_000);
      const source = path.join(dir, '.stream.tmp');
      fs.writeFileSync(source, original);
      const result = persistStreamedToolResult(dir, 'bash', source);
      expect(result.estimatedTokens).toBe(estimateToolResultTokens(original));
      expect(result.bytes).toBe(Buffer.byteLength(original));
      expect(fs.readFileSync(result.path, 'utf8')).toBe(original);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
