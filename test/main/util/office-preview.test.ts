import { describe, expect, it } from 'vitest';

import { officeBufferToPreviewHtml } from '../../../src/main/util/office-preview';
import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';
import { makeMinimalPptx, makeMinimalXlsx } from '../../fixtures/make-minimal-office';

describe('office-preview', () => {
  it('renders blank Word documents without placeholder text', async () => {
    const docx = makeMinimalDocx({ paragraphs: [] });
    const preview = await officeBufferToPreviewHtml('word', 'blank.docx', docx);

    expect(preview.kind).toBe('word');
    expect(preview.html).toContain('office-preview office-word');
    expect(preview.html).not.toContain('(no previewable content)');
  });

  it('renders blank spreadsheets without placeholder text', async () => {
    const xlsx = makeMinimalXlsx({ rows: [] });
    const preview = await officeBufferToPreviewHtml('spreadsheet', 'blank.xlsx', xlsx);

    expect(preview.kind).toBe('spreadsheet');
    expect(preview.html).toContain('office-preview office-spreadsheet');
    expect(preview.html).not.toContain('(empty sheet)');
  });

  it('renders blank slides without placeholder text', async () => {
    const pptx = makeMinimalPptx({ slides: [[]] });
    const preview = await officeBufferToPreviewHtml('presentation', 'blank.pptx', pptx);

    expect(preview.kind).toBe('presentation');
    expect(preview.html).toContain('office-preview office-presentation');
    expect(preview.html).not.toContain('(no text)');
  });

  it('renders a presentation with no slides as a blank page', async () => {
    const pptx = makeMinimalPptx({ slides: [] });
    const preview = await officeBufferToPreviewHtml('presentation', 'empty.pptx', pptx);

    expect(preview.kind).toBe('presentation');
    expect(preview.html).toContain('class="office-slide office-slide-blank"');
    expect(preview.html).not.toContain('(no previewable content)');
  });
});
