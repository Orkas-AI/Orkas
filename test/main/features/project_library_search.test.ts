import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeMinimalPdf } from '../../fixtures/make-minimal-pdf';
import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';
import { makeMinimalPptx, makeMinimalXlsx } from '../../fixtures/make-minimal-office';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/main/features/kb_embed', () => ({
  embedTexts: async (texts: string[]) => texts.map((_text, index) => {
    const vector = new Array(512).fill(0);
    vector[index % vector.length] = 1;
    return vector;
  }),
}));

let tmpDir: string;
let previousWorkspace: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-library-search-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  try {
    const projectLibrary = await import('../../../src/main/features/project_library_indexer');
    projectLibrary._resetQueuesForTests();
    const vectorStore = await import('../../../src/main/features/vec_store');
    vectorStore.closeAllVecStores();
  } catch { /* ignore */ }
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('project Library interactive search', () => {
  it('does not create a vector store for a project with no existing index', async () => {
    const projectLibrary = await import('../../../src/main/features/project_library_indexer');
    const paths = await import('../../../src/main/paths');
    const vector = new Array(512).fill(0);

    expect(projectLibrary.searchExisting('user-a', 'project-a', vector, { k: 5 })).toEqual([]);
    expect(fs.existsSync(paths.projectLibraryVectorDbPath('user-a', 'project-a'))).toBe(false);
  });

  it('queries an existing project vector store without requiring reconciliation', async () => {
    const paths = await import('../../../src/main/paths');
    const vectorStore = await import('../../../src/main/features/vec_store');
    const projectLibrary = await import('../../../src/main/features/project_library_indexer');
    const vector = new Array(512).fill(0);
    vector[0] = 1;
    const dbPath = paths.projectLibraryVectorDbPath('user-a', 'project-a');
    const store = vectorStore.openVecStore(path.dirname(dbPath));
    await store.upsertFile({
      id: 'source.md',
      kind: 'text',
      bytes: 12,
      mtime: 1,
      sha1: 'source-sha1',
      chunks: [{
        title: 'Source',
        content: 'project body marker',
        embedding: vector,
      }],
    });

    const hits = projectLibrary.searchExisting(
      'user-a',
      'project-a',
      vector,
      { k: 5 },
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      rel_path: 'source.md',
      content: 'project body marker',
    });
  });

  it('indexes PDF and Office project sources into searchable chunks', async () => {
    const userId = 'user-a';
    const projectId = 'project-a';
    const paths = await import('../../../src/main/paths');
    const projectLibrary = await import('../../../src/main/features/project_library_indexer');
    const root = paths.projectFilesDir(userId, projectId);
    fs.mkdirSync(root, { recursive: true });
    const fixtures: Array<[string, Buffer, string]> = [
      ['report.pdf', makeMinimalPdf(['Project PDF marker 751']), 'Project PDF marker 751'],
      [
        'notes.docx',
        makeMinimalDocx({ paragraphs: ['Project DOCX marker 752'] }),
        'Project DOCX marker 752',
      ],
      [
        'scores.xlsx',
        makeMinimalXlsx({ rows: [['Metric'], ['Project XLSX marker 753']] }),
        'Project XLSX marker 753',
      ],
      [
        'slides.pptx',
        makeMinimalPptx({ slides: [['Roadmap', 'Project PPTX marker 754']] }),
        'Project PPTX marker 754',
      ],
    ];
    for (const [name, body] of fixtures) {
      fs.writeFileSync(path.join(root, name), body);
      projectLibrary.enqueue(userId, projectId, name);
    }

    await projectLibrary.drain(userId);

    for (const [name, _body, marker] of fixtures) {
      expect(projectLibrary.getFileByPath(userId, projectId, name)).toMatchObject({
        status: 'ready',
      });
      expect(
        projectLibrary.readFileChunks(userId, projectId, name)
          .map((chunk) => chunk.content)
          .join('\n'),
      ).toContain(marker);
    }
  });
});
