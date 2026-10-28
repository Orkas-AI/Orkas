import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('electron', () => ({ shell: { showItemInFolder: vi.fn() } }));
vi.mock('../../../src/main/logger', () => ({
  createLogger: (name: string) => ({ debug: vi.fn(), info: vi.fn(), error: vi.fn(),
    warn: name === 'contexts' ? diagnostics.warn : vi.fn() }),
}));
vi.mock('../../../src/main/features/office/office_engine', () => ({
  officeCliAvailable: () => false, runOfficeCli: vi.fn(), closeOfficeFile: vi.fn(),
}));
vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: vi.fn(), kbEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock('../../../src/main/features/search', () => ({ upsertContext: vi.fn(), dropContext: vi.fn() }));

let workspace = '', previousWorkspace: string | undefined;
const filename = 'private-fixture-document.docx';
beforeEach(async () => {
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-office-diagnostics-'));
  process.env.ORKAS_WORKSPACE_ROOT = workspace;
  diagnostics.warn.mockClear(); vi.resetModules();
  const users = await import('../../../src/main/features/users'); users.activateUser('fixture-user');
  fs.mkdirSync(path.join(workspace, 'fixture-user/cloud/contexts'), { recursive: true });
});
afterEach(async () => {
  await drainMainRuntimeForTest();
  if (previousWorkspace === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(workspace, { force: true, recursive: true });
});
const absoluteFile = () => path.join(workspace, 'fixture-user/cloud/contexts', filename);
function expectSafeDiagnostics() {
  expect(diagnostics.warn).toHaveBeenCalledExactlyOnceWith('context Office preview failed', {
    path: expect.objectContaining({ path_hash: expect.stringMatching(/^[a-f0-9]{12}$/), ext: '.docx' }),
    error: expect.objectContaining({ message_hash: expect.stringMatching(/^[a-f0-9]{12}$/), message_chars: expect.any(Number) }),
  });
  const saved = JSON.stringify(diagnostics.warn.mock.calls);
  for (const privateValue of [filename, workspace, 'PRIVATE_DIAGNOSTIC_PAYLOAD']) expect(saved).not.toContain(privateValue);
}

describe('context Office failure diagnostics', () => {
  it('retains useful read-error attribution without recording paths or raw errors', async () => {
    fs.writeFileSync(absoluteFile(), makeMinimalDocx({ paragraphs: ['Normal fixture'] }));
    const contexts = await import('../../../src/main/features/contexts');
    const originalRead = fs.readFileSync;
    const failure = Object.assign(new Error(`EACCES: ${absoluteFile()} PRIVATE_DIAGNOSTIC_PAYLOAD`), { code: 'EACCES' });
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
      if (String(file) === absoluteFile()) throw failure;
      return (originalRead as any)(file, ...args);
    }) as any); syncBuiltinESMExports();
    try {
      expect((await contexts.readContextOfficeHtml(filename)).ok).toBe(false);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expectSafeDiagnostics();
    expect(diagnostics.warn.mock.calls[0][1].error).toMatchObject({ code: 'EACCES', message_chars: failure.message.length });
  });

  it('redacts malformed-document preview failures without losing the failure result', async () => {
    fs.writeFileSync(absoluteFile(), Buffer.from('not a document'));
    const contexts = await import('../../../src/main/features/contexts');
    expect((await contexts.readContextOfficeHtml(filename)).ok).toBe(false);
    expectSafeDiagnostics();
  });

  it('keeps valid lightweight Word preview and the source file intact', async () => {
    const bytes = makeMinimalDocx({ paragraphs: ['Independent preview sentinel'] }); fs.writeFileSync(absoluteFile(), bytes);
    const contexts = await import('../../../src/main/features/contexts');
    const result = await contexts.readContextOfficeHtml(filename);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected a valid preview');
    expect(result.html).toContain('Independent preview sentinel'); expect(result.allowScripts).not.toBe(true);
    expect(fs.readFileSync(absoluteFile())).toEqual(bytes); expect(diagnostics.warn).not.toHaveBeenCalled();
  });
});


function expectClosedDiagnostic(message: string, rawMessage: string) {
  expect(diagnostics.warn).toHaveBeenCalledExactlyOnceWith(message, {
    message_hash: expect.stringMatching(/^[a-f0-9]{12}$/), message_chars: rawMessage.length,
  });
  for (const value of [workspace, filename, 'PRIVATE_DIAGNOSTIC_PAYLOAD']) {
    expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain(value);
  }
}

it('keeps legacy Word-preview failure diagnostics private', async () => {
  fs.writeFileSync(absoluteFile(), Buffer.from('not a document'));
  const contexts = await import('../../../src/main/features/contexts');
  const read = fs.readFileSync;
  const message = `EACCES: ${absoluteFile()} PRIVATE_DIAGNOSTIC_PAYLOAD`;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
    if (String(file) === absoluteFile()) throw Object.assign(new Error(message), { code: 'EACCES' });
    return (read as any)(file, ...args);
  }) as any); syncBuiltinESMExports();
  try { expect((await contexts.readContextDocxHtml(filename)).ok).toBe(false); }
  finally { spy.mockRestore(); syncBuiltinESMExports(); }
  expectClosedDiagnostic('context Word preview failed', message);
});

it('keeps folder-reveal failure diagnostics private without retrying the OS action', async () => {
  fs.writeFileSync(absoluteFile(), 'Owned fixture source');
  const contexts = await import('../../../src/main/features/contexts');
  const electron = await import('electron');
  const message = `EACCES: ${absoluteFile()} PRIVATE_DIAGNOSTIC_PAYLOAD`;
  const reveal = vi.mocked(electron.shell.showItemInFolder);
  reveal.mockClear(); reveal.mockImplementationOnce(() => { throw new Error(message); });
  expect((await contexts.showContextFileInSystem(filename)).ok).toBe(false);
  expect(reveal).toHaveBeenCalledExactlyOnceWith(absoluteFile());
  expectClosedDiagnostic('context file reveal failed', message);
});

it('retains a successful source write when duplicate lookup fails, without private diagnostics', async () => {
  const contexts = await import('../../../src/main/features/contexts');
  const kb = await import('../../../src/main/features/kb_vector');
  const message = `Database failure ${absoluteFile()} PRIVATE_DIAGNOSTIC_PAYLOAD`;
  const spy = vi.spyOn(kb, 'findBySha1').mockImplementation(() => { throw new Error(message); });
  try { expect(contexts.writeContextFile('note.md', 'Saved owned source')).toMatchObject({ ok: true }); }
  finally { spy.mockRestore(); }
  expect(fs.readFileSync(path.join(workspace, 'fixture-user/cloud/contexts/note.md'), 'utf8')).toBe('Saved owned source');
  expectClosedDiagnostic('duplicate content check skipped', message);
});

it('reports index-rebuild failure privately and rebuilds after the filesystem recovers', async () => {
  const root = path.join(workspace, 'fixture-user/cloud/contexts');
  const source = path.join(root, 'note.md'); fs.writeFileSync(source, '# Preserved owned source');
  const contexts = await import('../../../src/main/features/contexts');
  const mkdir = fs.mkdirSync;
  const message = `EACCES: ${root} PRIVATE_DIAGNOSTIC_PAYLOAD`;
  const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((directory: any, ...args: any[]) => {
    if (String(directory) === root) throw Object.assign(new Error(message), { code: 'EACCES' });
    return (mkdir as any)(directory, ...args);
  }) as any); syncBuiltinESMExports();
  try { expect(() => contexts.invalidateIndex()).not.toThrow(); }
  finally { spy.mockRestore(); syncBuiltinESMExports(); }
  expectClosedDiagnostic('context index rebuild failed', message);
  expect(await contexts.getContextIndexMarkdown()).toContain('Preserved owned source');
  expect(fs.readFileSync(source, 'utf8')).toBe('# Preserved owned source');
});
