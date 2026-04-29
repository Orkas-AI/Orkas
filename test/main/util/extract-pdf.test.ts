import { describe, it, expect } from 'vitest';
import { pdfBufferToChunks } from '../../../src/main/util/extract-pdf';
import { makeMinimalPdf } from '../../fixtures/make-minimal-pdf';

describe('extract-pdf › pdfBufferToChunks', () => {
  it('extracts text from a single-page PDF', async () => {
    const pdf = makeMinimalPdf(['Hello PDF World']);
    const chunks = await pdfBufferToChunks(pdf);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].pageStart).toBe(1);
    expect(chunks[0].pageEnd).toBe(1);
    expect(chunks[0].text).toContain('Hello PDF World');
  });

  it('packs multiple small pages into one chunk', async () => {
    const pdf = makeMinimalPdf(['Page one text', 'Page two text', 'Page three text']);
    const chunks = await pdfBufferToChunks(pdf, { maxChars: 12_000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].pageStart).toBe(1);
    expect(chunks[0].pageEnd).toBe(3);
    expect(chunks[0].text).toContain('Page one text');
    expect(chunks[0].text).toContain('Page two text');
    expect(chunks[0].text).toContain('Page three text');
  });

  it('breaks pages into multiple chunks when maxChars is small', async () => {
    const pdf = makeMinimalPdf(['Aaaa one', 'Bbbb two', 'Cccc three']);
    const chunks = await pdfBufferToChunks(pdf, { maxChars: 12 });
    // Each page is ~8 chars, so each goes into its own chunk (12 cap).
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].pageStart).toBe(1);
    expect(chunks[chunks.length - 1].pageEnd).toBe(3);
  });

  it('rejects empty buffer', async () => {
    await expect(pdfBufferToChunks(Buffer.alloc(0))).rejects.toThrow(/empty|invalid/i);
  });
});
