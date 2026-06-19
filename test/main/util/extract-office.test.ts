import { describe, it, expect } from 'vitest';

import {
  xlsxBufferToHtml,
  xlsxBufferToMarkdown,
  pptxBufferToHtml,
  pptxBufferToMarkdown,
} from '../../../src/main/util/extract-office';
import { makeMinimalXlsx, makeMinimalPptx } from '../../fixtures/make-minimal-office';

describe('extract-office › xlsxBufferToMarkdown', () => {
  it('extracts shared-string worksheet rows', () => {
    const md = xlsxBufferToMarkdown(makeMinimalXlsx({
      sheetName: 'Scores',
      rows: [
        ['Name', 'Score'],
        ['Ada', '99'],
      ],
    }));

    expect(md).toContain('# Spreadsheet');
    expect(md).toContain('## Scores');
    expect(md).toContain('Row 1: Name\tScore');
    expect(md).toContain('Row 2: Ada\t99');
  });

  it('rejects empty buffers', () => {
    expect(() => xlsxBufferToMarkdown(Buffer.alloc(0))).toThrow(/empty|invalid/i);
  });
});

describe('extract-office › xlsxBufferToHtml', () => {
  it('renders worksheet rows as escaped table HTML', () => {
    const html = xlsxBufferToHtml(makeMinimalXlsx({
      sheetName: 'Scores & Totals',
      rows: [
        ['Name', 'Score'],
        ['Ada <admin>', '99'],
      ],
    }));

    expect(html).toContain('class="office-sheet"');
    expect(html).toContain('<table>');
    expect(html).toContain('Scores &amp; Totals');
    expect(html).toContain('Ada &lt;admin&gt;');
  });
});

describe('extract-office › pptxBufferToMarkdown', () => {
  it('extracts slide text nodes', () => {
    const md = pptxBufferToMarkdown(makeMinimalPptx({
      slides: [
        ['Roadmap', 'Launch in June'],
        ['Risks', 'Capacity'],
      ],
    }));

    expect(md).toContain('# Presentation');
    expect(md).toContain('## Slide 1');
    expect(md).toContain('- Roadmap');
    expect(md).toContain('- Launch in June');
    expect(md).toContain('## Slide 2');
    expect(md).toContain('- Risks');
  });

  it('rejects empty buffers', () => {
    expect(() => pptxBufferToMarkdown(Buffer.alloc(0))).toThrow(/empty|invalid/i);
  });
});

describe('extract-office › pptxBufferToHtml', () => {
  it('renders slide text as escaped readonly sections', () => {
    const html = pptxBufferToHtml(makeMinimalPptx({
      slides: [
        ['Roadmap', 'Launch <June>'],
      ],
    }));

    expect(html).toContain('class="office-slide"');
    expect(html).toContain('aria-label="Slide 1"');
    expect(html).toContain('<p>Roadmap</p>');
    expect(html).toContain('Launch &lt;June&gt;');
  });
});
