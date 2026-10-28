import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runOfficeCli: vi.fn(),
}));

vi.mock('../../../../src/main/features/office/office_engine', () => ({
  runOfficeCli: (...args: unknown[]) => mocks.runOfficeCli(...args),
}));

import { renderOfficePageToPng } from '../../../../src/main/features/office/office_page_renderer';
import { PPTX_TEXT_COLLISION_SCRIPT, unassessedTextCollision } from '../../../../src/main/features/office/pptx_text_collision';

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler = vi.fn();
  executeJavaScript = vi.fn(async (script: string) => (
    script.includes("document.querySelectorAll('.slide')")
      ? { width: 1280, height: 720 }
      : true
  ));
  resizedImage = { toPNG: () => Buffer.from('electron-png') };
  nativeImage = {
    getSize: () => ({ width: 2560, height: 1440 }),
    resize: vi.fn(() => this.resizedImage),
    toPNG: () => Buffer.from('retina-png'),
  };
  capturePage = vi.fn(async () => this.nativeImage);
}

class FakeBrowserWindow {
  static instances: FakeBrowserWindow[] = [];
  webContents = new FakeWebContents();
  loadURL = vi.fn(async (_url: string) => undefined);
  setContentSize = vi.fn();
  destroy = vi.fn();
  constructor(readonly options: Record<string, unknown>) {
    FakeBrowserWindow.instances.push(this);
  }
}

function fakeSession() {
  const handlers: Array<(details: { url: string }, callback: (result: { cancel: boolean }) => void) => void> = [];
  return {
    handlers,
    webRequest: { onBeforeRequest: vi.fn((handler: any) => { if (handler) handlers.push(handler); }) },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    clearCache: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
  };
}

describe('embedded Office page renderer', () => {
  beforeEach(() => {
    mocks.runOfficeCli.mockReset();
    FakeBrowserWindow.instances = [];
  });

  it.each([false, true])('keeps the image and reports audit coverage when collection fails=%s', async (fails) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-office-audit-'));
    const audit = { ...unassessedTextCollision('unsupported_text_container'), status: 'partial' };
    const onTextCollisionAudit = vi.fn();
    const ses = fakeSession();
    mocks.runOfficeCli.mockImplementation(async (args: string[]) => {
      fs.writeFileSync(args[args.indexOf('-o') + 1], '<html></html>');
      return { code: 0, stdout: '', stderr: '' };
    });
    class AuditWindow extends FakeBrowserWindow {
      constructor(options: Record<string, unknown>) {
        super(options);
        const ordinary = this.webContents.executeJavaScript.getMockImplementation()!;
        this.webContents.executeJavaScript.mockImplementation(async script => {
          if (script !== PPTX_TEXT_COLLISION_SCRIPT) return ordinary(script);
          if (fails) throw new Error('test collection failure');
          return audit as any;
        });
      }
    }
    try {
      const png = await renderOfficePageToPng(path.join(cwd, 'deck.pptx'), cwd, '1', undefined, {
        loadElectron: async () => ({ BrowserWindow: AuditWindow as any, session: { fromPartition: () => ses as any } }),
        onTextCollisionAudit,
      });
      expect(png).toEqual(Buffer.from('electron-png'));
      expect(onTextCollisionAudit).toHaveBeenCalledWith(fails ? unassessedTextCollision('collection_failed') : audit);
      expect(FakeBrowserWindow.instances[0].destroy).toHaveBeenCalled();
      expect(ses.clearStorageData).toHaveBeenCalled();
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it('renders OfficeCLI HTML in embedded Electron without invoking its screenshot backend', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-office-page-renderer-'));
    const source = path.join(cwd, 'deck.pptx');
    fs.writeFileSync(source, 'fixture');
    const ses = fakeSession();
    mocks.runOfficeCli.mockImplementation(async (args: string[]) => {
      const output = args[args.indexOf('-o') + 1];
      fs.writeFileSync(output, '<!doctype html><html><body><div class="slide"></div></body></html>');
      return { code: 0, stdout: '', stderr: '' };
    });

    try {
      const png = await renderOfficePageToPng(source, cwd, '2', undefined, {
        loadElectron: async () => ({
          BrowserWindow: FakeBrowserWindow as any,
          session: { fromPartition: () => ses as any },
        }),
      });

      expect(png).toEqual(Buffer.from('electron-png'));
      expect(mocks.runOfficeCli).toHaveBeenCalledWith(
        ['view', source, 'html', '-o', expect.stringMatching(/preview\.html$/), '--page', '2'],
        { cwd, timeoutMs: 60_000 },
      );
      expect(mocks.runOfficeCli.mock.calls[0][0]).not.toContain('screenshot');
      const win = FakeBrowserWindow.instances[0];
      expect(win.loadURL).toHaveBeenCalledWith(expect.stringMatching(/^file:.*preview\.html#screenshot$/));
      expect(win.setContentSize).toHaveBeenCalledWith(1280, 720, false);
      expect(win.webContents.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 1280, height: 720 });
      expect(win.webContents.nativeImage.resize).toHaveBeenCalledWith({
        width: 1280,
        height: 720,
        quality: 'best',
      });
      expect(win.destroy).toHaveBeenCalled();
      expect(ses.clearStorageData).toHaveBeenCalled();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('restricts the renderer to its temp files and trusted Office asset hosts', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-office-page-renderer-'));
    const source = path.join(cwd, 'deck.pptx');
    fs.writeFileSync(source, 'fixture');
    const ses = fakeSession();
    mocks.runOfficeCli.mockImplementation(async (args: string[]) => {
      fs.writeFileSync(args[args.indexOf('-o') + 1], '<html></html>');
      return { code: 0, stdout: '', stderr: '' };
    });

    try {
      await renderOfficePageToPng(source, cwd, '1', undefined, {
        loadElectron: async () => ({
          BrowserWindow: FakeBrowserWindow as any,
          session: { fromPartition: () => ses as any },
        }),
      });
      const requestHandler = ses.handlers[0];
      const allowed = vi.fn();
      requestHandler({ url: 'https://d.officecli.ai/assets/katex.js' }, allowed);
      expect(allowed).toHaveBeenLastCalledWith({ cancel: false });
      requestHandler({ url: 'https://example.com/tracker.js' }, allowed);
      expect(allowed).toHaveBeenLastCalledWith({ cancel: true });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects failed pagination without publishing an unpaginated image and releases the renderer', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-office-pagination-'));
    const ses = fakeSession();
    mocks.runOfficeCli.mockImplementation(async (args: string[]) => {
      fs.writeFileSync(args[args.indexOf('-o') + 1], '<html></html>');
      return { code: 0, stdout: '', stderr: '' };
    });
    class FailedPaginationWindow extends FakeBrowserWindow {
      constructor(options: Record<string, unknown>) {
        super(options);
        const ordinary = this.webContents.executeJavaScript.getMockImplementation()!;
        this.webContents.executeJavaScript.mockImplementation(async script => {
          if (script.includes('window._wordPaginate')) throw new Error('native pagination failed');
          return ordinary(script);
        });
      }
    }
    try {
      await expect(renderOfficePageToPng(path.join(cwd, 'handover.docx'), cwd, '1', undefined, {
        loadElectron: async () => ({
          BrowserWindow: FailedPaginationWindow as any,
          session: { fromPartition: () => ses as any },
        }),
      })).rejects.toThrow('native pagination failed');
      const win = FakeBrowserWindow.instances[0];
      expect(win.webContents.capturePage).not.toHaveBeenCalled();
      expect(win.destroy).toHaveBeenCalled();
      expect(ses.clearStorageData).toHaveBeenCalled();
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it('installs the Office policy before generated scripts and preserves the source document', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-office-policy-'));
    const source = path.join(cwd, 'fixture.docx');
    fs.writeFileSync(source, 'source must not change');
    const ses = fakeSession();
    mocks.runOfficeCli.mockImplementation(async (args: string[]) => {
      fs.writeFileSync(args[args.indexOf('-o') + 1], '<!doctype html><html><head><script>window.ready=true</script>'
        + '<base href="https://untrusted.example/"></head><body><div class="page"></div></body></html>');
      return { code: 0, stdout: '', stderr: '' };
    });
    class PolicyWindow extends FakeBrowserWindow {
      loadURL = vi.fn(async (url: string) => {
        const html = fs.readFileSync(fileURLToPath(new URL(url)), 'utf8');
        expect(html.indexOf('Content-Security-Policy')).toBeGreaterThan(0);
        expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));
        expect(html).toContain("connect-src 'none'");
        expect(html).toContain("object-src 'none'");
        expect(html).not.toContain("'unsafe-eval'");
        expect(html).not.toContain('<base ');
      });
    }
    try {
      await renderOfficePageToPng(source, cwd, '1', undefined, {
        loadElectron: async () => ({ BrowserWindow: PolicyWindow as any, session: { fromPartition: () => ses as any } }),
      });
      expect(fs.readFileSync(source, 'utf8')).toBe('source must not change');
      expect(FakeBrowserWindow.instances[0].webContents.capturePage).toHaveBeenCalledOnce();
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
