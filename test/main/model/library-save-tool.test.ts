import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Keep the test hermetic: mock the project_files feature so we assert
// library_save's OWN logic (workspace-scope sandbox gate, arg mapping, result
// passthrough) without the real copy or the KB indexer. copyProjectEntryFromPath
// is exercised by the project_files tests.
const { copyMock, checkoutMock, replaceMock } = vi.hoisted(() => ({
  copyMock: vi.fn(), checkoutMock: vi.fn(), replaceMock: vi.fn(),
}));
vi.mock('../../../src/main/features/project_files', () => ({
  copyProjectEntryFromPath: (...args: unknown[]) => copyMock(...args),
  checkoutProjectFile: (...args: unknown[]) => checkoutMock(...args),
  replaceProjectFileFromPath: (...args: unknown[]) => replaceMock(...args),
}));

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-libsave-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  copyMock.mockReset();
  checkoutMock.mockReset();
  replaceMock.mockReset();
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser('u1');
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const PID = 'p_aaaaaaaaaaaa';

async function librarySaveTool(projectId?: string) {
  const lt = await import('../../../src/main/model/core-agent/local-tools');
  const ws = await import('../../../src/main/features/user_workspace');
  const res = ws.setWorkspacePath('u1', tmpDir);
  if (!res.ok) throw new Error(`setWorkspacePath failed: ${res.error}`);
  return lt.createLocalTools({ userId: 'u1', ...(projectId ? { projectId } : {}) })
    .find((t) => t.name === 'library_save');
}

function ctx() { return { workingDir: tmpDir, state: {} } as any; }

describe('local-tools › library_save', () => {
  it('keeps only selection-relevant behavior in the model-visible description', async () => {
    const tool = await librarySaveTool(PID);
    expect(tool?.description).toContain('durable, searchable deliverable');
    expect(tool?.description).toContain('not scratch files');
    expect(tool?.description).not.toContain('set it as the task result_ref');
  });

  it('is offered only inside a project conversation', async () => {
    const lt = await import('../../../src/main/model/core-agent/local-tools');
    expect(lt.createLocalTools({ userId: 'u1' }).some((t) => t.name === 'library_save')).toBe(false);
    expect(lt.createLocalTools({ userId: 'u1', projectId: PID }).some((t) => t.name === 'library_save')).toBe(true);
  });

  it('rejects a source_path outside the workspace scope', async () => {
    const tool = await librarySaveTool(PID);
    expect(tool).toBeTruthy();
    const res = await tool!.execute({ source_path: '/etc/hosts' }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('E_PATH_OUT_OF_SCOPE');
    expect(copyMock).not.toHaveBeenCalled();
  });

  it('copies an in-workspace file into the library and returns its path', async () => {
    const tool = await librarySaveTool(PID);
    fs.writeFileSync(path.join(tmpDir, 'report.pdf'), 'x');
    copyMock.mockResolvedValue({ ok: true, name: 'report.pdf', fileCount: 1, bytes: 1 });
    const res = await tool!.execute({ source_path: 'report.pdf' }, ctx());
    expect(res.isError).toBeFalsy();
    expect(copyMock).toHaveBeenCalledWith('u1', PID, path.join(tmpDir, 'report.pdf'), 'report.pdf');
    expect(JSON.parse(res.content)).toMatchObject({ ok: true, path: 'report.pdf' });
  });

  it('uses the optional name for the library filename', async () => {
    const tool = await librarySaveTool(PID);
    fs.writeFileSync(path.join(tmpDir, 'out.pdf'), 'x');
    copyMock.mockResolvedValue({ ok: true, name: 'Q3 report.pdf', fileCount: 1, bytes: 1 });
    await tool!.execute({ source_path: 'out.pdf', name: 'Q3 report.pdf' }, ctx());
    expect(copyMock).toHaveBeenCalledWith('u1', PID, path.join(tmpDir, 'out.pdf'), 'Q3 report.pdf');
  });

  it('surfaces a copy failure as an error result', async () => {
    const tool = await librarySaveTool(PID);
    fs.writeFileSync(path.join(tmpDir, 'dup.pdf'), 'x');
    copyMock.mockResolvedValue({ ok: false, error: 'target_exists' });
    const res = await tool!.execute({ source_path: 'dup.pdf' }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('target_exists');
  });

  it('requires source_path', async () => {
    const tool = await librarySaveTool(PID);
    const res = await tool!.execute({}, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('E_BAD_INPUT');
    expect(copyMock).not.toHaveBeenCalled();
  });

  it('checks out and explicitly replaces only the bound project file', async () => {
    const tool = await librarySaveTool(PID);
    const revision = 'a'.repeat(64);
    checkoutMock.mockResolvedValue({ ok: true, name: 'report.pdf', bytes: 1, revision });
    const read = await tool!.execute({ action: 'checkout', name: 'report.pdf', source_path: 'edit.pdf' }, ctx());
    expect(checkoutMock).toHaveBeenCalledWith('u1', PID, 'report.pdf', path.join(tmpDir, 'edit.pdf'));
    expect(JSON.parse(read.content)).toMatchObject({ path: 'report.pdf', revision });
    replaceMock.mockResolvedValue({ ok: false, error: 'conflict' });
    const saved = await tool!.execute({ source_path: 'edit.pdf', name: 'report.pdf', expected_revision: revision }, ctx());
    expect(replaceMock).toHaveBeenCalledWith('u1', PID, path.join(tmpDir, 'edit.pdf'), 'report.pdf', revision);
    expect(saved.isError).toBe(true);
    expect(JSON.parse(saved.content)).toMatchObject({ error: 'conflict' });
    expect(copyMock).not.toHaveBeenCalled();
  });

  it.each([
    { action: 'checkout' },
    { action: 'checkout', name: 'file.md', expected_revision: 'a'.repeat(64) },
    { expected_revision: '' },
    { action: 'overwrite' },
    { project_id: 'p_forged' },
    { action: 'checkout', name: 'file.md', source_path: '/etc/new.md' },
  ])('rejects invalid editing arguments without calling storage: %j', async (args) => {
    const tool = await librarySaveTool(PID);
    expect((await tool!.execute({ source_path: 'edit.md', ...args }, ctx())).isError).toBe(true);
    expect(copyMock).not.toHaveBeenCalled();
    expect(checkoutMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
