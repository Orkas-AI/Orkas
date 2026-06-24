import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeMinimalPptx, makeMinimalXlsx } from '../../fixtures/make-minimal-office';

let tmpDir: string;
let prevWs: string | undefined;

const enqueueCalls: Array<{ userId: string; projectId: string; name: string; op: string }> = [];

vi.mock('../../../src/main/features/projects', () => ({
  projectExists: async () => true,
}));

vi.mock('../../../src/main/features/project_library_indexer', () => ({
  enqueue: (userId: string, projectId: string, name: string, op = 'upsert') => {
    enqueueCalls.push({ userId, projectId, name, op });
  },
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-files-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  enqueueCalls.length = 0;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('project_files › modern Office support', () => {
  it('accepts spreadsheets and presentations into project files', async () => {
    const projectFiles = await import('../../../src/main/features/project_files');
    const sheet = await projectFiles.uploadProjectFile('u1', 'p1', 'sources/scores.xlsx', makeMinimalXlsx());
    const deck = await projectFiles.uploadProjectFile('u1', 'p1', 'slides.pptx', makeMinimalPptx());

    expect(sheet.ok).toBe(true);
    expect(deck.ok).toBe(true);
    expect((sheet as any).info.kind).toBe('spreadsheet');
    expect((deck as any).info.kind).toBe('presentation');
    expect(enqueueCalls).toContainEqual({ userId: 'u1', projectId: 'p1', name: 'sources/scores.xlsx', op: 'upsert' });
    expect(enqueueCalls).toContainEqual({ userId: 'u1', projectId: 'p1', name: 'slides.pptx', op: 'upsert' });
  });

  it('renders project Office previews', async () => {
    const projectFiles = await import('../../../src/main/features/project_files');
    await projectFiles.uploadProjectFile('u1', 'p1', 'scores.xlsx', makeMinimalXlsx({
      rows: [['Name'], ['Ada']],
    }));

    const preview = await projectFiles.readProjectOfficeHtml('u1', 'p1', 'scores.xlsx');
    expect(preview.ok).toBe(true);
    expect((preview as any).kind).toBe('spreadsheet');
    expect((preview as any).html).toContain('Ada');
    expect((preview as any).html).toContain('office-preview office-spreadsheet');
  });
});
