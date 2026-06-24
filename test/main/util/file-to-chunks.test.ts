import { describe, expect, it } from 'vitest';

import { fileToChunks } from '../../../src/main/util/file_to_chunks';
import { makeMinimalPptx, makeMinimalXlsx } from '../../fixtures/make-minimal-office';

describe('file_to_chunks › office files', () => {
  it('chunks spreadsheet text extracted from xlsx', async () => {
    const chunks = await fileToChunks({
      kind: 'spreadsheet',
      buf: makeMinimalXlsx({
        sheetName: 'Metrics',
        rows: [
          ['Name', 'Score'],
          ['Ada', '99'],
        ],
      }),
    });

    expect(chunks.map((c) => c.content).join('\n')).toContain('Row 2: Ada\t99');
  });

  it('chunks presentation text extracted from pptx', async () => {
    const chunks = await fileToChunks({
      kind: 'presentation',
      buf: makeMinimalPptx({ slides: [['Roadmap', 'Launch in June']] }),
    });

    expect(chunks.map((c) => c.content).join('\n')).toContain('- Launch in June');
  });
});
