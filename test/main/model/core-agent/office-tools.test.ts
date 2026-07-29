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
  let produced: Set<string>;

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
    h.runOfficeCli.mockImplementation(async (args: string[]) => {
      if (args[0] === 'create' && args[1]) {
        fs.mkdirSync(path.dirname(args[1]), { recursive: true });
        fs.writeFileSync(args[1], 'created-office-file');
      }
      return { code: 0, stdout: 'ok', stderr: '' };
    });
    h.closeOfficeFile.mockResolvedValue(undefined);
    produced = new Set<string>();
    onFileWritten = vi.fn((absPath: string) => { produced.add(path.resolve(absPath)); });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function tools() {
    return createOfficeTools({
      userId: 'user-1',
      cid: 'conversation-1',
      onFileWritten,
      hasProducedPath: (absPath) => produced.has(path.resolve(absPath)),
    });
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
      'office_check',
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
    const createCalls = h.runOfficeCli.mock.calls.filter(([args]) => args[0] === 'create');
    expect(createCalls.map(([args]) => path.basename(args[1]))).toEqual([
      'report.docx',
      'data.xlsx',
      'deck.pptx',
    ]);
    for (const [args, options] of createCalls) {
      expect(path.basename(path.dirname(args[1]))).toMatch(/^\.orkas-office-create-/);
      expect(options.cwd).toBe(path.dirname(args[1]));
    }
    expect(createCalls[0][1]).toEqual(expect.objectContaining({ signal: controller.signal }));
    expect(h.runOfficeCli.mock.calls.every(([args]) => Array.isArray(args))).toBe(true);
    expect(h.closeOfficeFile).toHaveBeenCalledWith(report, path.dirname(report));
    expect(h.closeOfficeFile).toHaveBeenCalledWith(data, path.dirname(data));
    expect(h.closeOfficeFile).toHaveBeenCalledWith(deck, path.dirname(deck));
    expect(onFileWritten.mock.calls.map(([file]) => file)).toEqual([report, data, deck]);
  });

  it('exposes native editable XLSX charts and emits them in the initial create batch', async () => {
    const tool = getTool('create_xlsx');
    const schema = tool.inputSchema as any;
    expect(tool.description).toContain('native editable charts');
    expect(tool.description).toContain('instead of calling create_xlsx again');
    expect(schema.properties.charts.items.properties.type.enum).toContain('line');
    expect(schema.properties.sheets.items.properties.charts.items.properties.dataRange)
      .toBeDefined();

    const result = await tool.execute({
      path: 'out/charted.xlsx',
      rows: [['日期', '销售额'], ['7月1日', 120], ['7月2日', 180]],
      charts: [{
        type: 'line',
        dataRange: 'Sheet1!B1:B3',
        categories: 'Sheet1!A2:A3',
        title: '销售趋势',
        anchor: 'D2:L18',
        axismin: 0,
      }],
      preview: false,
    }, ctx());

    expect(result.isError).toBeUndefined();
    const batchCall = h.runOfficeCli.mock.calls.find(([args]) => args[0] === 'batch');
    const operations = JSON.parse(batchCall?.[1]?.stdin as string);
    expect(operations.at(-2)).toEqual({
      command: 'add',
      parent: '/Sheet1',
      type: 'chart',
      props: {
        chartType: 'line',
        dataRange: 'Sheet1!B1:B3',
        categories: 'Sheet1!A2:A3',
        title: '销售趋势',
        anchor: 'D2:L18',
        axismin: '0',
      },
    });
    expect(operations.at(-1)).toEqual({
      command: 'set',
      path: '/Sheet1/chart[1]',
      props: { axismin: '0' },
    });
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
    expect(fs.existsSync(path.join(h.workspace, 'failed.xlsx'))).toBe(false);
    expect(h.closeOfficeFile).toHaveBeenCalledTimes(2);
  });

  it('keeps a prior conversation-produced workbook intact when a recreate batch fails', async () => {
    const tool = getTool('create_xlsx');
    const first = await tool.execute({
      path: 'stable.xlsx',
      rows: [['original']],
      preview: false,
    }, ctx());
    expect(first.isError).toBeUndefined();
    const stable = path.join(h.workspace, 'stable.xlsx');
    const before = fs.readFileSync(stable);

    h.runOfficeCli.mockImplementation(async (args: string[]) => {
      if (args[0] === 'create' && args[1]) {
        fs.mkdirSync(path.dirname(args[1]), { recursive: true });
        fs.writeFileSync(args[1], 'replacement');
        return { code: 0, stdout: 'ok', stderr: '' };
      }
      if (args[0] === 'batch') {
        return { code: 3, stdout: '', stderr: 'invalid chart property' };
      }
      return { code: 0, stdout: 'ok', stderr: '' };
    });
    const failed = await tool.execute({
      path: 'stable.xlsx',
      rows: [['replacement']],
      preview: false,
    }, ctx());

    expect(failed).toMatchObject({ isError: true });
    expect(failed.content).toContain('E_OFFICE_BATCH_FAILED');
    expect(fs.readFileSync(stable)).toEqual(before);
    expect(fs.readdirSync(h.workspace).some((name) => name.startsWith('.orkas-office-create-')))
      .toBe(false);
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

  it('edits a pre-existing Office source through a validated copy and leaves the source byte-identical', async () => {
    const file = path.join(h.workspace, 'existing.xlsx');
    const output = path.join(h.workspace, 'existing-edited.xlsx');
    fs.writeFileSync(file, 'source-bytes');
    h.runOfficeCli.mockImplementation(async (args: string[]) => {
      if (args[0] === 'batch') fs.writeFileSync(args[1], 'edited-bytes');
      return { code: 0, stdout: 'ok', stderr: '' };
    });
    const edit = getTool('edit_office');

    const result = await edit.execute({
      path: file,
      operations: [{ action: 'set', path: '/Sheet1/A1', props: { value: 'updated' } }],
      preview: false,
    }, ctx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(`Edited ${output}`);
    expect(result.content).toContain(`source preserved: ${file}`);
    expect(fs.readFileSync(file, 'utf8')).toBe('source-bytes');
    expect(fs.readFileSync(output, 'utf8')).toBe('edited-bytes');
    const batchArgs = h.runOfficeCli.mock.calls.find(([args]) => args[0] === 'batch')?.[0] as string[];
    const validateArgs = h.runOfficeCli.mock.calls.find(([args]) => args[0] === 'validate')?.[0] as string[];
    expect(batchArgs[1]).not.toBe(file);
    expect(batchArgs).toContain('--stop-on-error');
    expect(validateArgs).toEqual(['validate', batchArgs[1], '--json']);
    expect(onFileWritten).toHaveBeenCalledWith(output);
  });

  it('refines a conversation-produced Office file in place through an atomic validated temporary copy', async () => {
    const file = path.join(h.workspace, 'generated.docx');
    fs.writeFileSync(file, 'generated-v1');
    produced.add(file);
    h.runOfficeCli.mockImplementation(async (args: string[]) => {
      if (args[0] === 'batch') fs.writeFileSync(args[1], 'generated-v2');
      return { code: 0, stdout: 'ok', stderr: '' };
    });

    const result = await getTool('edit_office').execute({
      path: file,
      operations: [{ action: 'set', path: '/body/p[1]', props: { text: 'updated' } }],
      preview: false,
    }, ctx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(`Edited ${file}`);
    expect(result.content).not.toContain('source preserved');
    expect(fs.readFileSync(file, 'utf8')).toBe('generated-v2');
    expect(onFileWritten).toHaveBeenCalledWith(file);
  });

  it('does not overwrite an existing working-copy name when deriving the safe output path', async () => {
    const source = path.join(h.workspace, 'review.xlsx');
    const occupied = path.join(h.workspace, 'review-edited.xlsx');
    const output = path.join(h.workspace, 'review-edited-2.xlsx');
    fs.writeFileSync(source, 'source');
    fs.writeFileSync(occupied, 'someone-else-output');
    h.runOfficeCli.mockImplementation(async (args: string[]) => {
      if (args[0] === 'batch') fs.writeFileSync(args[1], 'new-output');
      return { code: 0, stdout: 'ok', stderr: '' };
    });

    const result = await getTool('edit_office').execute({
      path: source,
      operations: [{ action: 'set', path: '/Sheet1/A1', props: { value: 'new' } }],
      preview: false,
    }, ctx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(output);
    expect(result.content).toContain('<file-renamed>');
    expect(fs.readFileSync(source, 'utf8')).toBe('source');
    expect(fs.readFileSync(occupied, 'utf8')).toBe('someone-else-output');
    expect(fs.readFileSync(output, 'utf8')).toBe('new-output');
  });

  it('rejects source overwrite and removes failed or invalid working copies without changing the source', async () => {
    const file = path.join(h.workspace, 'contract.docx');
    const output = path.join(h.workspace, 'contract-edited.docx');
    fs.writeFileSync(file, 'source-contract');
    const edit = getTool('edit_office');

    const overwrite = await edit.execute({
      path: file,
      output_path: file,
      operations: [{ action: 'remove', path: '/body/p[1]' }],
      preview: false,
    }, ctx());
    expect(overwrite).toMatchObject({ isError: true });
    expect(overwrite.content).toContain('E_SOURCE_OVERWRITE');
    expect(h.runOfficeCli).not.toHaveBeenCalled();

    h.runOfficeCli.mockImplementationOnce(async (args: string[]) => {
      fs.writeFileSync(args[1], 'partial-edit');
      return { code: 4, stdout: '', stderr: 'edit failed' };
    });
    const failed = await edit.execute({
      path: file,
      operations: [{ action: 'remove', path: '/Sheet1/A1' }],
      preview: false,
    }, ctx());
    expect(failed.content).toContain('E_OFFICE_EDIT_FAILED: edit failed');
    expect(fs.readFileSync(file, 'utf8')).toBe('source-contract');
    expect(fs.existsSync(output)).toBe(false);

    h.runOfficeCli.mockReset();
    h.runOfficeCli
      .mockImplementationOnce(async (args: string[]) => {
        fs.writeFileSync(args[1], 'structurally-invalid');
        return { code: 0, stdout: '', stderr: '' };
      })
      .mockResolvedValueOnce({ code: 2, stdout: '{"valid":false}', stderr: '' });
    const invalid = await edit.execute({
      path: file,
      operations: [{ action: 'set', path: '/body/p[1]', props: { text: 'bad package' } }],
      preview: false,
    }, ctx());
    expect(invalid.content).toContain('E_OFFICE_VALIDATION_FAILED');
    expect(fs.readFileSync(file, 'utf8')).toBe('source-contract');
    expect(fs.existsSync(output)).toBe(false);
    expect(onFileWritten).not.toHaveBeenCalled();
  });

  it('normalizes sandboxed file props and rejects external, missing, or unsafe references before editing', async () => {
    const file = path.join(h.workspace, 'deck.pptx');
    const image = path.join(h.attachments, 'logo.png');
    fs.writeFileSync(file, 'source-deck');
    fs.writeFileSync(image, 'png');
    const edit = getTool('edit_office');

    await edit.execute({
      path: file,
      operations: [{ action: 'add', parent: '/slide[1]', type: 'picture', props: { src: image } }],
      preview: false,
    }, ctx());
    const batchCall = h.runOfficeCli.mock.calls.find(([args]) => args[0] === 'batch');
    expect(batchCall?.[1].stdin).toBeTypeOf('string');
    const normalizedOperations = JSON.parse(String(batchCall?.[1].stdin)) as Array<{
      props?: { src?: string };
    }>;
    expect(normalizedOperations[0]?.props?.src).toBe(image);

    h.runOfficeCli.mockClear();
    const outside = path.join(tmpDir, 'secret.png');
    fs.writeFileSync(outside, 'private');
    const outsideResult = await edit.execute({
      path: file,
      operations: [{ action: 'add', parent: '/slide[1]', type: 'picture', props: { src: outside } }],
      preview: false,
    }, ctx());
    const remoteResult = await edit.execute({
      path: file,
      operations: [{ action: 'add', parent: '/slide[1]', type: 'picture', props: { src: 'https://example.com/logo.png' } }],
      preview: false,
    }, ctx());
    const nestedOutsideResult = await edit.execute({
      path: file,
      operations: [{
        action: 'add',
        parent: '/slide[1]',
        type: 'picture',
        props: { media: { image_src: outside } },
      }],
      preview: false,
    }, ctx());
    const activeLinkResult = await edit.execute({
      path: file,
      operations: [{ action: 'set', path: '/slide[1]/shape[1]', props: { href: 'javascript:alert(1)' } }],
      preview: false,
    }, ctx());

    expect(outsideResult).toMatchObject({ isError: true });
    expect(outsideResult.content).toContain('outside the conversation');
    expect(remoteResult).toMatchObject({ isError: true });
    expect(remoteResult.content).toContain('does not accept URI');
    expect(nestedOutsideResult).toMatchObject({ isError: true });
    expect(nestedOutsideResult.content).toContain('outside the conversation');
    expect(activeLinkResult).toMatchObject({ isError: true });
    expect(activeLinkResult.content).toContain('unsafe URI scheme');
    expect(h.runOfficeCli).not.toHaveBeenCalled();
  });

  it('checks OpenXML validity and document issues without hiding validation findings', async () => {
    const file = path.join(h.workspace, 'existing.docx');
    fs.writeFileSync(file, 'fixture');
    h.runOfficeCli
      .mockResolvedValueOnce({ code: 2, stdout: '{"valid":false,"errors":["bad rel"]}', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '{"issues":[{"type":"format"}]}', stderr: '' });

    const result = await getTool('office_check').execute({ path: file }, ctx());
    const payload = JSON.parse(result.content);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      path: file,
      valid: false,
      validation_exit_code: 2,
      validation: { valid: false, errors: ['bad rel'] },
      issue_scan_ok: true,
      issues: { issues: [{ type: 'format' }] },
    });
    expect(h.runOfficeCli.mock.calls.map(([args]) => args)).toEqual([
      ['validate', file, '--json'],
      ['view', file, 'issues', '--json'],
    ]);
    expect(h.closeOfficeFile).toHaveBeenCalledWith(file, path.dirname(file));

    h.runOfficeCli.mockReset();
    h.runOfficeCli
      .mockResolvedValueOnce({ code: 0, stdout: '{"valid":true}', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '{"issues":[{"type":"format","severity":"warning"}]}', stderr: '' });
    const warningOnly = await getTool('office_check').execute({ path: file }, ctx());
    expect(warningOnly.isError).toBeUndefined();
    expect(JSON.parse(warningOnly.content)).toMatchObject({
      valid: true,
      issues: { issues: [{ severity: 'warning' }] },
    });
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
