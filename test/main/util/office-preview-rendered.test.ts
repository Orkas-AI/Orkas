import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';
import { makeMinimalPptx, makeMinimalXlsx } from '../../fixtures/make-minimal-office';

const engine = vi.hoisted(() => ({
  available: true,
  closeOfficeFile: vi.fn(),
  runOfficeCli: vi.fn(),
}));

vi.mock('../../../src/main/features/office/office_engine', () => ({
  officeCliAvailable: () => engine.available,
  runOfficeCli: (...args: unknown[]) => engine.runOfficeCli(...args),
  closeOfficeFile: (...args: unknown[]) => engine.closeOfficeFile(...args),
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  activePresentationSlideIndex,
  officeFileToPreviewHtml,
  type OfficePreviewKind,
} from '../../../src/main/util/office-preview';

type PreviewCase = {
  kind: OfficePreviewKind;
  extension: '.docx' | '.xlsx' | '.pptx';
  macroExtension: '.docm' | '.xlsm' | '.pptm';
  buffer: () => Buffer;
  renderedClass: string;
  styleToken: string;
  fallbackToken: string;
};

const previewCases: PreviewCase[] = [
  {
    kind: 'word',
    extension: '.docx',
    macroExtension: '.docm',
    buffer: () => makeMinimalDocx({ paragraphs: ['Styled Word Preview'] }),
    renderedClass: 'page',
    styleToken: 'padding:72pt 90pt',
    fallbackToken: 'office-preview office-word',
  },
  {
    kind: 'spreadsheet',
    extension: '.xlsx',
    macroExtension: '.xlsm',
    buffer: () => makeMinimalXlsx({ rows: [['Revenue dashboard'], ['Q1', '125000']] }),
    renderedClass: 'sheet-content',
    styleToken: 'background:#2563EB',
    fallbackToken: 'office-preview office-spreadsheet',
  },
  {
    kind: 'presentation',
    extension: '.pptx',
    macroExtension: '.pptm',
    buffer: () => makeMinimalPptx({ slides: [['Styled slide']] }),
    renderedClass: 'slide',
    styleToken: 'background:#123456',
    fallbackToken: 'office-preview office-presentation',
  },
];

function renderedHtmlFor(workFile: string): string {
  const extension = path.extname(workFile).toLowerCase();
  if (extension === '.docx') {
    return '<div class="page" style="padding:72pt 90pt">Styled Word Preview</div>';
  }
  if (extension === '.xlsx') {
    return '<div class="sheet-content active"><table><td style="background:#2563EB">Revenue dashboard</td></table></div>';
  }
  return `<div class="sidebar"><div class="thumb" data-slide="1"></div></div>
<div class="main"><div class="slide-container" data-slide="1"><div class="slide" style="background:#123456">Styled slide</div></div></div>
<script>(function() {
    const main = document.querySelector('.main');
    let currentSlide = 0;
    let isFullscreen = false;
    let scrollObserver = new IntersectionObserver(() => {}, { root: main, threshold: 0.3 });
    function getContainers() { return [...document.querySelectorAll('.main > .slide-container')]; }
    function getThumbs() { return [...document.querySelectorAll('.sidebar > .thumb')]; }
    function getTotal() { return getContainers().length; }
    function setActiveThumb(idx) {
      getThumbs().forEach((thumb, index) => thumb.classList.toggle('active', index === idx));
      currentSlide = idx;
    }
    // ===== Fullscreen mode =====
    void currentSlide; void isFullscreen; void getTotal;
})();</script>`;
}

describe('rendered Office preview', () => {
  let tempDir = '';
  let renderedSourceBytes = Buffer.alloc(0);

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-office-preview-test-'));
    renderedSourceBytes = Buffer.alloc(0);
    engine.available = true;
    engine.closeOfficeFile.mockReset().mockResolvedValue(undefined);
    engine.runOfficeCli.mockReset().mockImplementation(async (args: string[]) => {
      const workFile = args[1];
      const output = args[args.indexOf('-o') + 1];
      renderedSourceBytes = fs.readFileSync(workFile);
      fs.writeFileSync(output, `<!doctype html>
<html><head><base href="https://untrusted.example/"><style>.fixture{color:red}</style></head>
<body>${renderedHtmlFor(workFile)}<a href="javascript:alert(1)">unsafe</a>
<script>window.previewNavigationReady = true;</script></body></html>`);
      return { code: 0, stdout: output, stderr: '' };
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(previewCases)(
    'uses the Office layout renderer, hardens HTML, and caches unchanged $kind files',
    async ({ kind, extension, buffer, renderedClass, styleToken }) => {
      const source = buffer();
      const sourcePath = path.join(tempDir, `styled${extension}`);
      fs.writeFileSync(sourcePath, source);

      const first = await officeFileToPreviewHtml(kind, path.basename(sourcePath), sourcePath, source);
      const second = await officeFileToPreviewHtml(kind, path.basename(sourcePath), sourcePath, source);

      expect(first).toMatchObject({ kind, allowScripts: true, layoutRendered: true });
      expect(first.html).toContain(`class="${renderedClass}`);
      expect(first.html).toContain(styleToken);
      expect(first.html).toContain('Content-Security-Policy');
      expect(first.html).toContain("connect-src 'none'");
      expect(first.html).not.toContain('<base ');
      expect(first.html).not.toContain('javascript:alert');
      expect(second).toBe(first);
      expect(engine.runOfficeCli).toHaveBeenCalledTimes(1);
      const args = engine.runOfficeCli.mock.calls[0][0] as string[];
      expect(args).toEqual([
        'view', expect.stringMatching(new RegExp(`styled\\${extension}$`)),
        'html', '-o', expect.stringMatching(/preview\.html$/),
      ]);
      expect(args[1]).not.toBe(sourcePath);
      expect(renderedSourceBytes).toEqual(source);
      expect(fs.readFileSync(sourcePath)).toEqual(source);
      expect(engine.closeOfficeFile).toHaveBeenCalledWith(args[1], path.dirname(args[1]));
    },
  );

  it('keeps the first slide selected on open and selects the centered slide while scrolling a three-slide deck', () => {
    const slideBounds = [
      { top: 20, bottom: 392 },
      { top: 416, bottom: 788 },
      { top: 812, bottom: 1184 },
    ];

    // Both slides 1 and 2 exceed the renderer's old 30% visibility threshold
    // at the top. Opening the preview must still start on slide 1.
    expect(activePresentationSlideIndex(0, 700, slideBounds, true)).toBe(0);
    expect(activePresentationSlideIndex(250, 950, slideBounds)).toBe(1);
    expect(activePresentationSlideIndex(484, 1184, slideBounds)).toBe(2);
  });

  it('stabilizes the rendered presentation navigation without changing other Office previews', async () => {
    const presentation = previewCases[2];
    const source = presentation.buffer();
    const sourcePath = path.join(tempDir, 'three-slide-navigation.pptx');
    fs.writeFileSync(sourcePath, source);

    const result = await officeFileToPreviewHtml(
      presentation.kind,
      path.basename(sourcePath),
      sourcePath,
      source,
    );

    expect(result.html).toContain('orkas-presentation-navigation:v1');
    expect(result.html).toContain('scrollObserver.disconnect()');

    const word = previewCases[0];
    const wordSource = word.buffer();
    const wordPath = path.join(tempDir, 'navigation-control.docx');
    fs.writeFileSync(wordPath, wordSource);
    const wordResult = await officeFileToPreviewHtml(
      word.kind,
      path.basename(wordPath),
      wordPath,
      wordSource,
    );
    expect(wordResult.html).not.toContain('orkas-presentation-navigation:v1');
  });

  it('coalesces concurrent renders and invalidates the cache when a file changes', async () => {
    const original = previewCases[1].buffer();
    const sourcePath = path.join(tempDir, 'changing.xlsx');
    fs.writeFileSync(sourcePath, original);

    const [first, duplicate] = await Promise.all([
      officeFileToPreviewHtml('spreadsheet', 'changing.xlsx', sourcePath, original),
      officeFileToPreviewHtml('spreadsheet', 'changing.xlsx', sourcePath, original),
    ]);
    expect(duplicate).toBe(first);
    expect(engine.runOfficeCli).toHaveBeenCalledTimes(1);

    const updated = makeMinimalXlsx({
      rows: [['Revenue dashboard updated'], ['Q1', '125000'], ['Q2', '150000']],
    });
    fs.writeFileSync(sourcePath, updated);
    const refreshed = await officeFileToPreviewHtml('spreadsheet', 'changing.xlsx', sourcePath, updated);

    expect(refreshed).not.toBe(first);
    expect(engine.runOfficeCli).toHaveBeenCalledTimes(2);
    expect(renderedSourceBytes).toEqual(updated);
  });

  it.each(previewCases)(
    'renders macro-enabled $kind files through a temporary standard-extension copy',
    async ({ kind, extension, macroExtension, buffer }) => {
      const source = buffer();
      const sourcePath = path.join(tempDir, `macro${macroExtension}`);
      fs.writeFileSync(sourcePath, source);

      const result = await officeFileToPreviewHtml(kind, path.basename(sourcePath), sourcePath, source);

      expect(result).toMatchObject({ kind, allowScripts: true, layoutRendered: true });
      const workFile = engine.runOfficeCli.mock.calls[0][0][1] as string;
      expect(path.extname(workFile)).toBe(extension);
      expect(workFile).not.toBe(sourcePath);
      expect(renderedSourceBytes).toEqual(source);
      expect(fs.readFileSync(sourcePath)).toEqual(source);
    },
  );

  it.each(previewCases)(
    'falls back to lightweight $kind content when the bundled renderer is unavailable',
    async ({ kind, extension, buffer, fallbackToken }) => {
      engine.available = false;
      const source = buffer();
      const sourcePath = path.join(tempDir, `fallback${extension}`);
      fs.writeFileSync(sourcePath, source);

      const result = await officeFileToPreviewHtml(kind, path.basename(sourcePath), sourcePath, source);

      expect(result.kind).toBe(kind);
      expect(result.layoutRendered).toBeUndefined();
      expect(result.allowScripts).toBeUndefined();
      expect(result.html).toContain(fallbackToken);
      expect(engine.runOfficeCli).not.toHaveBeenCalled();
      expect(engine.closeOfficeFile).not.toHaveBeenCalled();
    },
  );

  it('falls back and closes the temporary copy when the layout renderer fails', async () => {
    const source = previewCases[1].buffer();
    const sourcePath = path.join(tempDir, 'failed.xlsx');
    fs.writeFileSync(sourcePath, source);
    engine.runOfficeCli.mockResolvedValue({ code: 2, stdout: '', stderr: 'render failed' });

    const result = await officeFileToPreviewHtml('spreadsheet', 'failed.xlsx', sourcePath, source);

    expect(result.layoutRendered).toBeUndefined();
    expect(result.html).toContain('office-preview office-spreadsheet');
    const workFile = engine.runOfficeCli.mock.calls[0][0][1] as string;
    expect(engine.closeOfficeFile).toHaveBeenCalledWith(workFile, path.dirname(workFile));
    expect(fs.readFileSync(sourcePath)).toEqual(source);
  });
});
