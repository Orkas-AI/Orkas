import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  execGranted: true,
  engineAvailable: true,
  workspace: '',
  attachments: '',
  runOfficeCli: vi.fn(),
  closeOfficeFile: vi.fn(),
}));

vi.mock('../../../../src/main/features/permissions', () => ({
  getLocalExecGranted: () => h.execGranted,
}));
vi.mock('../../../../src/main/features/user_workspace', () => ({
  getWorkspacePath: () => h.workspace,
}));
vi.mock('../../../../src/main/util/project-layout', () => ({
  chatAttachmentDirForConversation: () => h.attachments,
}));
vi.mock('../../../../src/main/features/office/office_engine', () => {
  class MockOfficeCliError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    OfficeCliError: MockOfficeCliError,
    officeCliAvailable: () => h.engineAvailable,
    runOfficeCli: (...args: unknown[]) => h.runOfficeCli(...args),
    closeOfficeFile: (...args: unknown[]) => h.closeOfficeFile(...args),
  };
});
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../src/main/util/log-redact', () => ({
  logErrorRef: (error: unknown) => String(error),
  logPathRef: (value: unknown) => String(value),
  maskId: (value: unknown) => String(value),
}));

import { createOfficeTools } from '../../../../src/main/model/core-agent/office-tools';

describe('Office built-in tools', () => {
  let tmpDir = '';
  let onFileWritten: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-office-tools-'));
    h.workspace = path.join(tmpDir, 'workspace with spaces');
    h.attachments = path.join(tmpDir, 'attachments');
    fs.mkdirSync(h.workspace, { recursive: true });
    fs.mkdirSync(h.attachments, { recursive: true });
    h.execGranted = true;
    h.engineAvailable = true;
    h.runOfficeCli.mockReset();
    h.closeOfficeFile.mockReset();
    h.runOfficeCli.mockResolvedValue({ code: 0, stdout: 'ok', stderr: '' });
    h.closeOfficeFile.mockResolvedValue(undefined);
    onFileWritten = vi.fn();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function tools() {
    return createOfficeTools({ userId: 'user-1', cid: 'conversation-1', onFileWritten });
  }

  function getTool(name: string) {
    const found = tools().find((tool) => tool.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  }

  function ctx(overrides: Record<string, unknown> = {}) {
    return { workingDir: h.workspace, state: {}, ...overrides } as any;
  }

  it('does not expose Office tools without a user-scoped workspace', () => {
    expect(createOfficeTools()).toEqual([]);
    expect(tools().map((tool) => tool.name)).toEqual([
      'create_docx',
      'create_xlsx',
      'create_pptx',
      'office_read',
      'edit_office',
      'office_render',
    ]);
  });

  it('enforces Tool Execution Access and engine availability before spawning OfficeCLI', async () => {
    h.execGranted = false;
    for (const officeTool of tools()) {
      const result = await officeTool.execute({}, ctx());
      expect(result).toMatchObject({ isError: true });
      expect(result.content).toContain('E_TOOL_EXECUTION_ACCESS_DISABLED');
    }
    expect(h.runOfficeCli).not.toHaveBeenCalled();

    h.execGranted = true;
    h.engineAvailable = false;
    const missing = await getTool('create_docx').execute({ path: 'report.docx' }, ctx());
    expect(missing).toMatchObject({ isError: true });
    expect(missing.content).toContain('E_OFFICE_ENGINE_MISSING');
    expect(h.runOfficeCli).not.toHaveBeenCalled();
  });

  it('rejects missing, wrong-extension, and outside-scope output paths', async () => {
    const docx = getTool('create_docx');
    await expect(docx.execute({}, ctx())).resolves.toMatchObject({ isError: true });
    const wrong = await docx.execute({ path: 'report.xlsx' }, ctx());
    expect(wrong.content).toContain('requires a `.docx` path');
    const outside = await docx.execute({ path: path.join(tmpDir, 'outside.docx') }, ctx());
    expect(outside.content).toContain('E_PATH_OUT_OF_SCOPE');
    expect(h.runOfficeCli).not.toHaveBeenCalled();
  });

  it('creates docx/xlsx/pptx through argv arrays and always closes the resident file', async () => {
    const controller = new AbortController();
    const docx = await getTool('create_docx').execute({
      path: 'out/report.docx',
      title: 'Status',
      paragraphs: [{ text: 'Works on Windows and macOS' }],
      preview: false,
    }, ctx({ signal: controller.signal }));
    const xlsx = await getTool('create_xlsx').execute({
      path: 'out/data.xlsx',
      rows: [['OS', 'status'], ['Windows', 'ok']],
      preview: false,
    }, ctx());
    const pptx = await getTool('create_pptx').execute({
      path: 'out/deck.pptx',
      slides: [{ title: 'Cross-platform', body: 'No shell quoting required' }],
      preview: false,
    }, ctx());

    expect(docx.isError).toBeUndefined();
    expect(xlsx.isError).toBeUndefined();
    expect(pptx.isError).toBeUndefined();
    const report = path.join(h.workspace, 'out', 'report.docx');
    const data = path.join(h.workspace, 'out', 'data.xlsx');
    const deck = path.join(h.workspace, 'out', 'deck.pptx');
    expect(h.runOfficeCli).toHaveBeenCalledWith(
      ['create', report, '--force'],
      expect.objectContaining({ cwd: path.dirname(report), signal: controller.signal }),
    );
    expect(h.runOfficeCli).toHaveBeenCalledWith(
      ['create', data, '--force'],
      expect.objectContaining({ cwd: path.dirname(data) }),
    );
    expect(h.runOfficeCli).toHaveBeenCalledWith(
      ['create', deck, '--force'],
      expect.objectContaining({ cwd: path.dirname(deck) }),
    );
    expect(h.runOfficeCli.mock.calls.every(([args]) => Array.isArray(args))).toBe(true);
    expect(h.closeOfficeFile).toHaveBeenCalledWith(report, path.dirname(report));
    expect(h.closeOfficeFile).toHaveBeenCalledWith(data, path.dirname(data));
    expect(h.closeOfficeFile).toHaveBeenCalledWith(deck, path.dirname(deck));
    expect(onFileWritten.mock.calls.map(([file]) => file)).toEqual([report, data, deck]);
  });

  it('returns typed create/batch failures and still closes OfficeCLI state', async () => {
    h.runOfficeCli.mockResolvedValueOnce({ code: 2, stdout: '', stderr: 'create failed' });
    const createFailed = await getTool('create_docx').execute({ path: 'failed.docx', preview: false }, ctx());
    expect(createFailed.content).toContain('E_OFFICE_CREATE_FAILED: create failed');
    expect(h.closeOfficeFile).toHaveBeenCalledTimes(1);

    h.runOfficeCli
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ code: 3, stdout: '', stderr: 'batch failed' });
    const batchFailed = await getTool('create_xlsx').execute({
      path: 'failed.xlsx',
      rows: [['value']],
      preview: false,
    }, ctx());
    expect(batchFailed.content).toContain('E_OFFICE_BATCH_FAILED: batch failed');
    expect(h.closeOfficeFile).toHaveBeenCalledTimes(2);
  });

  it('reads every supported mode with positional argv tokens and rejects option injection', async () => {
    const file = path.join(h.workspace, 'existing.docx');
    fs.writeFileSync(file, 'fixture');
    const read = getTool('office_read');

    const text = await read.execute({ path: file }, ctx());
    const outline = await read.execute({ path: file, mode: 'outline' }, ctx());
    const get = await read.execute({ path: file, mode: 'get', target: '/body/p[1]' }, ctx());
    const query = await read.execute({ path: file, mode: 'query', target: 'p.title' }, ctx());
    const injected = await read.execute({ path: file, mode: 'get', target: '--save=escaped.bin' }, ctx());

    expect(text.content).toBe('ok');
    expect(outline.content).toBe('ok');
    expect(get.content).toBe('ok');
    expect(query.content).toBe('ok');
    expect(injected).toMatchObject({ isError: true });
    expect(injected.content).toContain('must not start with');
    expect(h.runOfficeCli.mock.calls.map(([args]) => args)).toEqual([
      ['view', file, 'text'],
      ['view', file, 'outline'],
      ['get', file, '/body/p[1]', '--json'],
      ['query', file, 'p.title', '--json'],
    ]);
    expect(h.closeOfficeFile).toHaveBeenCalledTimes(4);
  });

  it('edits in place with a JSON batch, reports failures, and closes the file', async () => {
    const file = path.join(h.workspace, 'existing.xlsx');
    fs.writeFileSync(file, 'fixture');
    const edit = getTool('edit_office');

    const result = await edit.execute({
      path: file,
      operations: [{ action: 'set', path: '/Sheet1/A1', props: { value: 'updated' } }],
      preview: false,
    }, ctx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(`Edited ${file}`);
    expect(h.runOfficeCli).toHaveBeenCalledWith(
      ['batch', file, '--stop-on-error'],
      expect.objectContaining({ cwd: path.dirname(file), stdin: expect.stringContaining('updated') }),
    );
    expect(onFileWritten).toHaveBeenCalledWith(file);
    expect(h.closeOfficeFile).toHaveBeenCalledWith(file, path.dirname(file));

    h.runOfficeCli.mockResolvedValueOnce({ code: 4, stdout: '', stderr: 'edit failed' });
    const failed = await edit.execute({
      path: file,
      operations: [{ action: 'remove', path: '/Sheet1/A1' }],
      preview: false,
    }, ctx());
    expect(failed.content).toContain('E_OFFICE_EDIT_FAILED: edit failed');
    expect(h.closeOfficeFile).toHaveBeenCalledTimes(2);
  });

  it('renders a page to an inline PNG and validates the page before execution', async () => {
    const file = path.join(h.workspace, 'existing.pptx');
    fs.writeFileSync(file, 'fixture');
    h.runOfficeCli.mockImplementation(async (args: string[]) => {
      if (args[0] === 'view' && args[2] === 'screenshot') {
        const output = args[args.indexOf('-o') + 1];
        fs.writeFileSync(output, 'png-bytes');
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const render = getTool('office_render');

    const result = await render.execute({ path: file, page: '2' }, ctx());
    const invalid = await render.execute({ path: file, page: '--save=escaped.bin' }, ctx());

    expect(result.isError).toBeUndefined();
    expect(result.images).toEqual([{ data: Buffer.from('png-bytes').toString('base64'), mediaType: 'image/png' }]);
    expect(invalid).toMatchObject({ isError: true });
    expect(invalid.content).toContain('positive integer');
    expect(h.runOfficeCli).toHaveBeenCalledTimes(1);
    expect(h.closeOfficeFile).toHaveBeenCalledWith(file, path.dirname(file));
  });
});
