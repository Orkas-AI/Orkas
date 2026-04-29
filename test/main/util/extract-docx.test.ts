import { describe, it, expect } from 'vitest';
import { docxBufferToMarkdown } from '../../../src/main/util/extract-docx';
import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';

describe('extract-docx › docxBufferToMarkdown', () => {
  it('extracts plain paragraphs', async () => {
    const docx = makeMinimalDocx({ paragraphs: ['First paragraph.', 'Second paragraph.'] });
    const md = await docxBufferToMarkdown(docx);
    // mammoth markdown-escapes literal periods to "\." — match either form.
    expect(md).toMatch(/First paragraph\\?\./);
    expect(md).toMatch(/Second paragraph\\?\./);
  });

  it('emits a markdown heading for Heading1 paragraphs', async () => {
    const docx = makeMinimalDocx({ heading: 'Title Here', paragraphs: ['Body line.'] });
    const md = await docxBufferToMarkdown(docx);
    expect(md).toMatch(/^#\s+Title Here/m);
    expect(md).toMatch(/Body line\\?\./);
  });

  it('rejects empty buffer', async () => {
    await expect(docxBufferToMarkdown(Buffer.alloc(0))).rejects.toThrow(/empty|invalid/i);
  });
});
