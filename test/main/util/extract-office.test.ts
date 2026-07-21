import AdmZip from 'adm-zip';
import { describe, it, expect } from 'vitest';

import {
  xlsxBufferToHtml,
  xlsxBufferToMarkdown,
  pptxBufferToHtml,
  pptxBufferToMarkdown,
} from '../../../src/main/util/extract-office';
import {
  makeMinimalXlsx,
  makeNamespacedDirectXlsx,
  makeReorderedPptx,
  makeReorderedSheetsXlsx,
  makeSparseXlsx,
  makeMinimalPptx,
} from '../../fixtures/make-minimal-office';

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

  it('extracts namespaced direct-string worksheet rows', () => {
    const md = xlsxBufferToMarkdown(makeNamespacedDirectXlsx({
      sheetName: 'Sheet1',
      rows: [
        ['序号', '姓名', '身高(cm)'],
        ['1', '张伟', '178'],
      ],
    }));

    expect(md).toContain('## Sheet1');
    expect(md).toContain('Row 1: 序号\t姓名\t身高(cm)');
    expect(md).toContain('Row 2: 1\t张伟\t178');
  });

  it('preserves blank columns instead of shifting sparse worksheet cells left', () => {
    const md = xlsxBufferToMarkdown(makeSparseXlsx());

    expect(md).toContain('Row 1: Left\t\tRight');
    expect(md).toContain('Row 2: \t\tOnly C');
  });

  it('uses workbook sheet order instead of worksheet filename order', () => {
    const md = xlsxBufferToMarkdown(makeReorderedSheetsXlsx());

    expect(md.indexOf('## First In Workbook')).toBeLessThan(md.indexOf('## Second In Workbook'));
    expect(md.indexOf('First sheet body')).toBeLessThan(md.indexOf('Second sheet body'));
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

  it('renders namespaced direct-string worksheets without treating them as empty', () => {
    const html = xlsxBufferToHtml(makeNamespacedDirectXlsx({
      rows: [
        ['姓名', '身高(cm)'],
        ['张伟', '178'],
      ],
    }));

    expect(html).toContain('张伟');
    expect(html).toContain('身高(cm)');
    expect(html).not.toContain('(empty sheet)');
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

  it('uses presentation slide order instead of slide filename order', () => {
    const md = pptxBufferToMarkdown(makeReorderedPptx());

    expect(md.indexOf('- First slide in deck')).toBeLessThan(md.indexOf('- Second slide in deck'));
    expect(md).toContain('## Slide 1\n- First slide in deck');
    expect(md).toContain('## Slide 2\n- Second slide in deck');
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

  it('renders a valid zero-slide presentation as a blank page', () => {
    const html = pptxBufferToHtml(makeMinimalPptx({ slides: [] }));

    expect(html).toContain('class="office-slide office-slide-blank"');
    expect(html).toContain('aria-label="Blank presentation"');
  });

  it('rejects a presentation that declares a slide but has no slide data', () => {
    const zip = new AdmZip(makeMinimalPptx({ slides: [['Missing']] }));
    zip.deleteFile('ppt/slides/slide1.xml');

    expect(() => pptxBufferToHtml(zip.toBuffer())).toThrow(/slide data is missing/i);
  });
});
