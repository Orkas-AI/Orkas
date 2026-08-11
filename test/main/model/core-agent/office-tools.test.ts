import { createHash } from 'node:crypto';
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
  renderOfficePageToPng: vi.fn(),
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
vi.mock('../../../../src/main/features/office/office_page_renderer', () => ({
  renderOfficePageToPng: (...args: unknown[]) => h.renderOfficePageToPng(...args),
}));
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
    h.renderOfficePageToPng.mockReset();
    h.renderOfficePageToPng.mockResolvedValue(Buffer.from('png-bytes'));
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
    expect(docx.content).toContain('(2 paragraphs)');
    expect(xlsx.content).toContain('(4 cells)');
    expect(pptx.content).toContain('(1 slide)');
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

  it('exposes PPTX visual controls and emits native charts in the initial create batch', async () => {
    const tool = getTool('create_pptx');
    const schema = tool.inputSchema as any;
    const slideProps = schema.properties.slides.items.properties;
    expect(tool.description).toContain('native editable charts');
    expect(slideProps.shapes.items.properties.gradient).toBeDefined();
    expect(slideProps.shapes.items.properties.margin).toBeDefined();
    expect(slideProps.shapes.items.properties.shadow).toMatchObject({
      type: ['string', 'boolean'],
    });
    expect(slideProps.shapes.items.properties.shadow.description).toContain('Do not use preset names');
    expect(slideProps.images.items.properties.crop).toBeDefined();
    expect(slideProps.charts.items.properties.type.enum).toContain('waterfall');
    expect(slideProps.tables.items.properties.headerFill).toBeDefined();

    const imagePath = path.join(h.attachments, 'hero.png');
    fs.writeFileSync(imagePath, 'png');
    const result = await tool.execute({
      path: 'out/designed.pptx',
      slides: [{
        background: '#F7F8FC',
        shapes: [{
          text: '增长概览', x: '0.7in', y: '0.55in', width: '4in', height: '0.55in',
          gradient: '#5B5BD6-#8957E5-25', margin: '0.08in', line: '#FFFFFF', lineWidth: '1pt',
        }],
        images: [{ src: imagePath, x: '9.5in', y: '0.5in', width: '3in', height: '2in', crop: 'cover', alt: '产品界面' }],
        charts: [{
          type: 'column', data: '营收:32,48,66;利润:8,14,21', categories: 'Q1,Q2,Q3',
          x: '0.7in', y: '1.5in', width: '7.6in', height: '4.8in', colors: '#5B5BD6,#22A06B',
        }],
        tables: [{ rows: [['指标', '结果']], x: '8.7in', y: '3in', width: '3.8in', headerFill: '#111827', firstRow: true }],
      }],
      preview: false,
    }, ctx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('(1 slide)');
    expect(result.content).not.toContain('(5 slides)');
    const batchCall = h.runOfficeCli.mock.calls.find(([args]) => args[0] === 'batch');
    const operations = JSON.parse(batchCall?.[1]?.stdin as string);
    expect(operations).toContainEqual({
      command: 'add', parent: '/slide[1]', type: 'chart',
      props: {
        chartType: 'column', data: '营收:32,48,66;利润:8,14,21', categories: 'Q1,Q2,Q3',
        x: '0.7in', y: '1.5in', width: '7.6in', height: '4.8in', colors: '#5B5BD6,#22A06B',
      },
    });
    expect(operations).toContainEqual({
      command: 'add', parent: '/slide[1]', type: 'picture',
      props: {
        src: imagePath, x: '9.5in', y: '0.5in', width: '3in', height: '2in', crop: 'cover', alt: '产品界面',
      },
    });
    expect(operations).toContainEqual(expect.objectContaining({
      command: 'add', parent: '/slide[1]', type: 'table',
      props: expect.objectContaining({ headerFill: '#111827', firstRow: 'true' }),
    }));
  });

  it('allows intentionally repeated placeholder and shape copy', async () => {
    const result = await getTool('create_pptx').execute({
      path: 'out/duplicate-title.pptx',
      slides: [{
        title: 'One visible title',
        shapes: [{
          text: 'One visible title',
          x: '0.7in', y: '0.5in', width: '5in', height: '0.6in',
        }],
      }],
      preview: false,
    }, ctx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('(1 slide)');
    const batchCall = h.runOfficeCli.mock.calls.find(([args]) => args[0] === 'batch');
    const operations = JSON.parse(batchCall?.[1]?.stdin as string);
    expect(operations).toContainEqual(expect.objectContaining({
      command: 'add',
      parent: '/',
      type: 'slide',
      props: expect.objectContaining({ title: 'One visible title' }),
    }));
    expect(operations).toContainEqual(expect.objectContaining({
      command: 'add',
      parent: '/slide[1]',
      type: 'shape',
      props: expect.objectContaining({ text: 'One visible title' }),
    }));
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

  it('closes a stale Office resident and retries one busy batch exactly once', async () => {
    h.runOfficeCli.mockImplementationOnce(async (args: string[]) => {
      expect(args[0]).toBe('create');
      fs.mkdirSync(path.dirname(args[1]), { recursive: true });
      fs.writeFileSync(args[1], 'created-office-file');
      return { code: 0, stdout: 'ok', stderr: '' };
    });
    h.runOfficeCli.mockResolvedValueOnce({
      code: 3,
      stdout: '',
      stderr: 'Resident is running but the batch could not be delivered (main pipe busy or unresponsive).',
    });
    h.runOfficeCli.mockResolvedValueOnce({ code: 0, stdout: 'ok', stderr: '' });

    const result = await getTool('create_pptx').execute({
      path: 'retry-resident.pptx',
      slides: [{ title: 'Recovered' }],
      preview: false,
    }, ctx());

    expect(result.isError).toBeUndefined();
    const batchCalls = h.runOfficeCli.mock.calls.filter(([args]) => args[0] === 'batch');
    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[1][0][1]).toBe(batchCalls[0][0][1]);
    expect(h.closeOfficeFile).toHaveBeenCalledWith(
      batchCalls[0][0][1],
      path.dirname(batchCalls[0][0][1]),
    );
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

  it('keeps edit previews opt-in while preserving an explicit first-page preview', async () => {
    const file = path.join(h.workspace, 'intermediate.xlsx');
    const defaultOutput = path.join(h.workspace, 'intermediate-edited.xlsx');
    const previewOutput = path.join(h.workspace, 'review-now.xlsx');
    fs.writeFileSync(file, 'source-workbook');
    h.runOfficeCli.mockImplementation(async (args: string[]) => {
      if (args[0] === 'batch') fs.writeFileSync(args[1], 'edited-workbook');
      return { code: 0, stdout: 'ok', stderr: '' };
    });
    const edit = getTool('edit_office');
    const schema = edit.inputSchema as any;

    const intermediate = await edit.execute({
      path: file,
      operations: [{ action: 'set', path: '/Sheet1/A1', props: { value: 'draft' } }],
    }, ctx());

    expect(intermediate.isError).toBeUndefined();
    expect(intermediate.images).toBeUndefined();
    expect(fs.existsSync(defaultOutput)).toBe(true);
    expect(h.renderOfficePageToPng).not.toHaveBeenCalled();
    expect(schema.properties.preview.description).toContain('Default false');
    expect(edit.description).toContain('Preview rendering is opt-in with `preview:true`');

    const requested = await edit.execute({
      path: file,
      output_path: previewOutput,
      operations: [{ action: 'set', path: '/Sheet1/A1', props: { value: 'review' } }],
      preview: true,
    }, ctx());

    expect(requested.isError).toBeUndefined();
    expect(requested.images).toEqual([{
      data: Buffer.from('png-bytes').toString('base64'),
      mediaType: 'image/png',
    }]);
    expect(h.renderOfficePageToPng).toHaveBeenCalledTimes(1);
    expect(h.renderOfficePageToPng).toHaveBeenCalledWith(
      previewOutput,
      path.dirname(previewOutput),
      '1',
      undefined,
    );
  });

  it('regresses production table edits by seeding a grid into one atomic working-copy batch', async () => {
    const file = path.join(h.workspace, 'telemetry-report.docx');
    const output = path.join(h.workspace, 'telemetry-report-edited.docx');
    fs.writeFileSync(file, 'complete-original-document');
    h.runOfficeCli.mockImplementation(async (args: string[]) => {
      if (args[0] === 'batch') fs.writeFileSync(args[1], 'original-plus-section-3.2-table');
      return { code: 0, stdout: 'ok', stderr: '' };
    });

    const result = await getTool('edit_office').execute({
      path: file,
      operations: [{
        action: 'add',
        parent: '/body',
        type: 'table',
        props: {
          rows: [
            ['Parameter', 'Overall'],
            ['Records', 57_750],
            ['Completeness', '98.7%'],
          ],
          style: 'medium2',
        },
      }],
      preview: false,
    }, ctx());

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(`Edited ${output}`);
    expect(fs.readFileSync(file, 'utf8')).toBe('complete-original-document');
    expect(fs.readFileSync(output, 'utf8')).toBe('original-plus-section-3.2-table');
    const batchCalls = h.runOfficeCli.mock.calls.filter(([args]) => args[0] === 'batch');
    expect(batchCalls).toHaveLength(1);
    expect(JSON.parse(String(batchCalls[0]?.[1].stdin))).toEqual([{
      command: 'add',
      parent: '/body',
      type: 'table',
      props: {
        rows: '3', cols: '2', style: 'medium2',
        r1c1: 'Parameter', r1c2: 'Overall', r2c1: 'Records', r2c2: '57750',
        r3c1: 'Completeness', r3c2: '98.7%',
      },
    }]);
    expect(h.runOfficeCli.mock.calls.some(([args]) => args[0] === 'create')).toBe(false);
  });

  it('rejects invalid nested edit props before creating a working copy', async () => {
    const file = path.join(h.workspace, 'telemetry-report.docx');
    const output = path.join(h.workspace, 'telemetry-report-edited.docx');
    fs.writeFileSync(file, 'complete-original-document');

    const ragged = await getTool('edit_office').execute({
      path: file,
      operations: [{
        action: 'add', parent: '/body', type: 'table',
        props: { rows: [['Parameter', 'Overall'], ['Records']] },
      }],
      preview: false,
    }, ctx());

    expect(ragged).toMatchObject({ isError: true });
    expect(ragged.content).toContain('E_BAD_INPUT');
    expect(ragged.content).toContain('must be rectangular');
    expect(h.runOfficeCli).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe('complete-original-document');
    expect(fs.existsSync(output)).toBe(false);
  });

  it('documents add element types by Office format instead of mixing incompatible examples', () => {
    const edit = getTool('edit_office');
    const schema = edit.inputSchema as any;
    const typeDescription = schema.properties.operations.items.properties.type.description;

    expect(typeDescription).toContain('DOCX "p", "table", "picture"');
    expect(typeDescription).toContain('XLSX "cell", "table", "chart", "picture"');
    expect(typeDescription).toContain('PPTX "shape", "textbox", "picture", "chart", "table", "slide"');
    expect(typeDescription).toContain('DOCX "p" is invalid under a PPTX slide');
  });

  it('requires an explicit worksheet range before adding a populated XLSX table', async () => {
    const file = path.join(h.workspace, 'channel-report.xlsx');
    const output = path.join(h.workspace, 'channel-report-edited.xlsx');
    fs.writeFileSync(file, 'source-workbook');
    const edit = getTool('edit_office');
    const schema = edit.inputSchema as any;

    const missingPlacement = await edit.execute({
      path: file,
      operations: [{
        action: 'add', parent: '/渠道分析', type: 'table',
        props: { rows: [['渠道', '销售额'], ['淘宝天猫', 96_540]] },
      }],
      preview: false,
    }, ctx());

    expect(missingPlacement).toMatchObject({ isError: true });
    expect(missingPlacement.content).toContain('E_BAD_INPUT');
    expect(missingPlacement.content).toContain('requires props.ref or props.range');
    expect(h.runOfficeCli).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe('source-workbook');
    expect(fs.existsSync(output)).toBe(false);

    const result = await edit.execute({
      path: file,
      operations: [{
        action: 'add', parent: '/渠道分析', type: 'table',
        props: { ref: 'A1:B2', rows: [['渠道', '销售额'], ['淘宝天猫', 96_540]] },
      }],
      preview: false,
    }, ctx());

    expect(result.isError).toBeUndefined();
    expect(schema.properties.operations.items.properties.props.description).toContain('requires ref or range');
    const batchCall = h.runOfficeCli.mock.calls.find(([args]) => args[0] === 'batch');
    expect(JSON.parse(String(batchCall?.[1].stdin))).toEqual([{
      command: 'add',
      parent: '/渠道分析',
      type: 'table',
      props: {
        rows: '2', cols: '2', ref: 'A1:B2',
        r1c1: '渠道', r1c2: '销售额', r2c1: '淘宝天猫', r2c2: '96540',
      },
    }]);
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
    const artifactSha256 = `sha256:${createHash('sha256').update('fixture').digest('hex')}`;
    h.runOfficeCli
      .mockResolvedValueOnce({ code: 2, stdout: '{"valid":false,"errors":["bad rel"]}', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '{"issues":[{"type":"format"}]}', stderr: '' });

    const result = await getTool('office_check').execute({ path: file }, ctx());
    const payload = JSON.parse(result.content);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      valid: false,
      issue_count: 1,
      artifact_revision: artifactSha256.slice('sha256:'.length, 'sha256:'.length + 16),
      path: file,
      artifact_sha256: artifactSha256,
      validation_exit_code: 2,
      validation: { valid: false, errors: ['bad rel'] },
      issue_scan_ok: true,
      issues: { issues: [{ type: 'format' }] },
    });
    expect(result.observations).toEqual({
      fileReads: [{ path: file, hash: artifactSha256 }],
    });
    expect(h.runOfficeCli.mock.calls.map(([args]) => args)).toEqual([
      ['validate', file, '--json'],
      ['view', file, 'issues', '--json'],
    ]);
    expect(h.closeOfficeFile).toHaveBeenCalledWith(file, path.dirname(file));

    h.runOfficeCli.mockReset();
    h.runOfficeCli
      .mockResolvedValueOnce({ code: 0, stdout: '{"valid":true}', stderr: '' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: '{"success":true,"data":{"count":18,"issues":[{"type":"format","severity":"warning"}]}}',
        stderr: '',
      });
    const warningOnly = await getTool('office_check').execute({ path: file }, ctx());
    expect(warningOnly.isError).toBeUndefined();
    expect(JSON.parse(warningOnly.content)).toMatchObject({
      valid: true,
      issue_count: 18,
      artifact_revision: artifactSha256.slice('sha256:'.length, 'sha256:'.length + 16),
      issues: { data: { count: 18, issues: [{ severity: 'warning' }] } },
    });
  });

  it('supplements the PPTX issue scan with theme-aware contrast findings', async () => {
    const file = path.join(h.workspace, 'existing.pptx');
    fs.writeFileSync(file, 'fixture');
    h.runOfficeCli
      .mockResolvedValueOnce({ code: 0, stdout: '{"valid":true}', stderr: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '{"success":true,"data":{"count":0,"issues":[]}}', stderr: '' })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({
          success: true,
          data: {
            path: '/',
            type: 'presentation',
            format: { 'theme.color.dk1': '#000000', 'theme.color.lt1': '#FFFFFF' },
            children: [{
              path: '/slide[1]',
              type: 'slide',
              format: { background: '#0F172A' },
              children: [{
                path: '/slide[1]/shape[1]',
                type: 'placeholder',
                children: [{
                  path: '/slide[1]/shape[1]/p[1]/r[1]',
                  type: 'run',
                  text: 'AI 办公助手',
                  format: { 'effective.size': '44pt' },
                }],
              }],
            }],
          },
        }),
        stderr: '',
      });

    const result = await getTool('office_check').execute({ path: file }, ctx());
    const payload = JSON.parse(result.content);

    expect(result.isError).toBeUndefined();
    expect(payload).toMatchObject({
      valid: true,
      issue_count: 1,
      contrast_scan_ok: true,
      contrast_findings: 1,
      contrast_text_runs: 1,
      issues: {
        data: {
          count: 1,
          issues: [expect.objectContaining({
            subtype: 'low_contrast',
            severity: 'blocker',
            path: '/slide[1]/shape[1]',
          })],
        },
      },
    });
    expect(h.runOfficeCli.mock.calls.map(([args]) => args)).toEqual([
      ['validate', file, '--json'],
      ['view', file, 'issues', '--json'],
      ['get', file, '/', '--depth', '6', '--json'],
    ]);
  });

  it('renders a page to an inline PNG and validates the page before execution', async () => {
    const file = path.join(h.workspace, 'existing.pptx');
    fs.writeFileSync(file, 'fixture');
    const render = getTool('office_render');
    const schema = render.inputSchema as any;

    const result = await render.execute({
      path: file,
      page: '2',
      analysis_mode: 'quality_review',
    }, ctx());
    const invalid = await render.execute({ path: file, page: '--save=escaped.bin' }, ctx());
    const zero = await render.execute({ path: file, page: '0' }, ctx());
    const worksheetName = await render.execute({ path: file, page: '每日趋势' }, ctx());

    expect(result.isError).toBeUndefined();
    expect(schema.properties.analysis_mode.enum).toEqual(['understand', 'quality_review']);
    expect(schema.properties.analysis_mode.description).toContain('Default "understand"');
    expect(schema.properties.page.description).toContain('XLSX worksheet position in workbook order');
    expect(schema.properties.page.description).toContain('Never pass an XLSX worksheet name or cell range');
    expect(render.description).toContain('`analysis_mode:"quality_review"`');
    expect(render.description).toContain('use office_read mode "outline"');
    expect(render.description).toContain('available to the next inference only');
    expect(result.images).toEqual([{
      data: Buffer.from('png-bytes').toString('base64'),
      mediaType: 'image/png',
      analysisMode: 'quality_review',
    }]);
    const artifactSha256 = `sha256:${createHash('sha256').update('fixture').digest('hex')}`;
    const imageSha256 = `sha256:${createHash('sha256').update('png-bytes').digest('hex')}`;
    expect(result.content).toContain('page=2 mode=quality_review');
    expect(result.content).toContain(`artifact_revision=${artifactSha256.slice(7, 23)}`);
    expect(result.content).toContain(`image_revision=${imageSha256.slice(7, 23)}`);
    expect(result.observations).toEqual({
      fileReads: [{ path: file, hash: artifactSha256 }],
    });
    expect(invalid).toMatchObject({ isError: true });
    expect(invalid.content).toContain('positive integer');
    expect(zero).toMatchObject({ isError: true });
    expect(worksheetName).toMatchObject({ isError: true });
    expect(worksheetName.content).toContain('worksheet order, not a name or range');
    expect(h.renderOfficePageToPng).toHaveBeenCalledWith(file, path.dirname(file), '2', undefined);
    expect(h.renderOfficePageToPng).toHaveBeenCalledTimes(1);
    expect(h.runOfficeCli).not.toHaveBeenCalled();
    expect(h.closeOfficeFile).toHaveBeenCalledWith(file, path.dirname(file));
  });
});
