import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { xlsBufferToMarkdown, xlsBufferToHtml } from '../../../src/main/util/extract-xls';

const fixture = () => fs.readFileSync(path.join(__dirname, '../../fixtures/xls/inventory.xls'));

describe('legacy XLS extraction with the bundled reader', () => {
  it('reads every sheet and preserves Chinese, numeric types, dates, IDs and original row numbers', async () => {
    const bytes = fixture();
    const original = Buffer.from(bytes);
    const md = await xlsBufferToMarkdown(bytes);
    expect(md).toContain('## 设备清单');
    expect(md).toContain('Row 2: 00123\t冷却泵\t7\t2026-09-18');
    expect(md).toContain('Row 5: Spare\t\t12.5\t\tTRUE');
    expect(md).toContain('## Summary');
    expect(md).toContain('Inventory sentinel 8384');
    expect(md).toContain('Row 4: 0');
    expect(md).toContain('Row 5: -42');
    expect(bytes).toEqual(original);
  });

  it('escapes workbook text in the data preview without executing embedded markup', async () => {
    const html = await xlsBufferToHtml(fixture());
    expect(html).toContain('冷却泵');
    expect(html).toContain('Inventory sentinel 8384');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it.each(['renamed text', 'damaged workbook'])('rejects %s without reporting a successful partial extraction', async kind => {
    const bytes = kind === 'renamed text' ? Buffer.from('private document text') : fixture().subarray(0, 300);
    await expect(xlsBufferToMarkdown(bytes)).rejects.toThrow('Cannot read this XLS file');
  });

  it('reports password protection instead of exposing parser diagnostics', async () => {
    // BIFF8 workbook BOF followed by FILEPASS: the authoritative encryption flag.
    const bytes = Buffer.from('0908100000060500bb0dcc0741000000060000002f0006000000000000000a000000', 'hex');
    await expect(xlsBufferToMarkdown(bytes)).rejects.toThrow('password-protected');
  });

  it('bounds a failure burst and releases reader slots for a queued valid workbook', async () => {
    const calls = Array.from({ length: 35 }, (_, i) =>
      xlsBufferToMarkdown(i === 33 ? fixture() : Buffer.from('invalid workbook')));
    const results = await Promise.allSettled(calls);
    expect(results[33].status).toBe('fulfilled');
    expect((results[33] as PromiseFulfilledResult<string>).value).toContain('Inventory sentinel 8384');
    const reasons = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map(r => r.reason.message);
    expect(reasons.filter(message => message.includes('busy'))).toHaveLength(1);
    expect(reasons.filter(message => message.includes('Cannot read'))).toHaveLength(33);
    await expect(xlsBufferToMarkdown(fixture())).resolves.toContain('冷却泵');
  }, 15_000);

  it('refuses oversized input before spawning the parser', async () => {
    await expect(xlsBufferToMarkdown(Buffer.alloc(50 * 1024 * 1024 + 1))).rejects.toThrow('at most 50 MB');
  });
});
