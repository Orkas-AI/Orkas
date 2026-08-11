import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runOfficeCli: vi.fn(),
}));

vi.mock('../../../../src/main/features/office/office_engine', () => ({
  runOfficeCli: (...args: unknown[]) => mocks.runOfficeCli(...args),
}));

import { renderOfficePageToPng } from '../../../../src/main/features/office/office_page_renderer';

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
  loadURL = vi.fn(async () => undefined);
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
});
