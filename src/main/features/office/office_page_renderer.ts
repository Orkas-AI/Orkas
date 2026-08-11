import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { BrowserWindow as ElectronBrowserWindow, Session } from 'electron';

import { isPathAllowed } from '../../util/path-sandbox';
import { hardenedWebPreferences } from '../../util/window-security';
import { runOfficeCli } from './office_engine';

const OFFICE_RENDER_TIMEOUT_MS = 60_000;
const DEFAULT_SCREENSHOT_WIDTH = 1600;
const DEFAULT_SCREENSHOT_HEIGHT = 1200;
const MAX_SCREENSHOT_DIMENSION = 1920;
const TRUSTED_RENDER_HOSTS = new Set([
  'd.officecli.ai',
  'cdn.jsdelivr.net',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
]);

type ElectronRuntime = {
  BrowserWindow?: new (options: Record<string, unknown>) => ElectronBrowserWindow;
  session?: {
    fromPartition(partition: string): Session;
  };
};

export interface OfficePageRendererDeps {
  loadElectron?: () => Promise<ElectronRuntime>;
}

const READY_SCRIPT = `(async () => {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const images = Array.from(document.images || []);
  await Promise.all(images.map((img) => img.complete ? Promise.resolve() : new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  })));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return true;
})()`;

const CONTENT_SIZE_SCRIPT = `(() => {
  const visible = (element) => element && element.offsetParent !== null;
  const slide = Array.from(document.querySelectorAll('.slide')).find(visible);
  const page = Array.from(document.querySelectorAll('.page')).find(visible);
  const target = slide || page;
  if (!target) return { width: 1600, height: 1200 };
  return {
    width: Math.max(1, Math.ceil(target.offsetWidth || 0)),
    height: Math.max(1, Math.ceil(target.offsetHeight || 0)),
  };
})()`;

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), OFFICE_RENDER_TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('E_OFFICE_ABORTED: Office preview render aborted');
}

function normalizeContentSize(value: unknown): { width: number; height: number } {
  const candidate = value && typeof value === 'object'
    ? value as { width?: unknown; height?: unknown }
    : {};
  let width = Math.max(1, Number(candidate.width) || DEFAULT_SCREENSHOT_WIDTH);
  let height = Math.max(1, Number(candidate.height) || DEFAULT_SCREENSHOT_HEIGHT);
  const max = Math.max(width, height);
  if (max > MAX_SCREENSHOT_DIMENSION) {
    const scale = MAX_SCREENSHOT_DIMENSION / max;
    width *= scale;
    height *= scale;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

function renderRequestAllowed(raw: string, renderRoot: string): boolean {
  if (/^(?:data|blob|about):/i.test(raw)) return true;
  if (raw.startsWith('file:')) {
    try {
      const requested = fs.realpathSync(fileURLToPath(raw));
      return isPathAllowed(requested, [renderRoot]);
    } catch {
      return false;
    }
  }
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && TRUSTED_RENDER_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function isolateRenderSession(ses: Session, renderRoot: string): void {
  ses.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: !renderRequestAllowed(String(details.url || ''), renderRoot),
  }));
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  ses.on('will-download', (event) => event.preventDefault());
}

async function clearRenderSession(ses: Session): Promise<void> {
  try { ses.webRequest.onBeforeRequest(null); } catch { /* best effort */ }
  try { ses.removeAllListeners('will-download'); } catch { /* best effort */ }
  try { ses.setPermissionCheckHandler(null); } catch { /* best effort */ }
  try { ses.setPermissionRequestHandler(null); } catch { /* best effort */ }
  try { ses.setDevicePermissionHandler(null); } catch { /* best effort */ }
  try { ses.setDisplayMediaRequestHandler(null); } catch { /* best effort */ }
  await Promise.allSettled([ses.clearCache(), ses.clearStorageData()]);
}

/**
 * Render one Office page with Orkas's embedded Electron/Chromium runtime.
 * OfficeCLI only emits trusted-layout HTML here; it never enters its own
 * screenshot backend, so it cannot discover or launch an installed browser.
 */
export async function renderOfficePageToPng(
  file: string,
  cwd: string,
  page: string,
  signal?: AbortSignal,
  deps: OfficePageRendererDeps = {},
): Promise<Buffer> {
  assertNotAborted(signal);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-office-render-'));
  const htmlPath = path.join(tempDir, 'preview.html');
  let win: ElectronBrowserWindow | null = null;
  let ses: Session | null = null;
  let onAbort: (() => void) | null = null;
  try {
    const rendered = await runOfficeCli(
      ['view', file, 'html', '-o', htmlPath, '--page', page],
      { cwd, timeoutMs: OFFICE_RENDER_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    );
    if (rendered.code !== 0 || !fs.existsSync(htmlPath)) {
      throw new Error(rendered.stderr || rendered.stdout || `OfficeCLI exited ${rendered.code}`);
    }
    assertNotAborted(signal);

    const electron = await (deps.loadElectron?.() ?? import('electron') as Promise<ElectronRuntime>);
    const BrowserWindow = electron.BrowserWindow;
    if (!BrowserWindow || !electron.session) {
      throw new Error('E_OFFICE_RENDERER_UNAVAILABLE: Electron BrowserWindow is unavailable');
    }

    const partition = `office-render-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    ses = electron.session.fromPartition(partition);
    isolateRenderSession(ses, fs.realpathSync(tempDir));
    win = new BrowserWindow({
      show: false,
      width: DEFAULT_SCREENSHOT_WIDTH,
      height: DEFAULT_SCREENSHOT_HEIGHT,
      useContentSize: true,
      backgroundColor: '#ffffff',
      webPreferences: hardenedWebPreferences({ session: ses, backgroundThrottling: false }),
    });
    win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event: { preventDefault(): void }, target: string) => {
      if (target !== `${pathToFileURL(htmlPath).toString()}#screenshot`) event.preventDefault();
    });
    if (signal) {
      onAbort = () => {
        try { win?.destroy(); } catch { /* best effort */ }
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const entryUrl = `${pathToFileURL(htmlPath).toString()}#screenshot`;
    await withTimeout(win.loadURL(entryUrl), 'E_OFFICE_RENDER_LOAD_TIMEOUT: preview HTML did not load');
    await withTimeout(
      win.webContents.executeJavaScript(READY_SCRIPT, true),
      'E_OFFICE_RENDER_READY_TIMEOUT: fonts or images did not settle',
    );
    assertNotAborted(signal);

    const size = normalizeContentSize(await win.webContents.executeJavaScript(CONTENT_SIZE_SCRIPT, true));
    win.setContentSize(size.width, size.height, false);
    await withTimeout(
      win.webContents.executeJavaScript(READY_SCRIPT, true),
      'E_OFFICE_RENDER_RESIZE_TIMEOUT: resized preview did not settle',
    );
    assertNotAborted(signal);

    const image = await withTimeout(
      win.webContents.capturePage({ x: 0, y: 0, width: size.width, height: size.height }),
      'E_OFFICE_RENDER_CAPTURE_TIMEOUT: preview screenshot timed out',
    );
    // capturePage uses the display's backing scale on Retina Macs. Normalize
    // back to the requested CSS-pixel dimensions so a 1280x720 slide does not
    // unexpectedly become a 2560x1440 payload (and exceed multimodal limits).
    const capturedSize = image.getSize();
    const normalizedImage = capturedSize.width === size.width && capturedSize.height === size.height
      ? image
      : image.resize({ width: size.width, height: size.height, quality: 'best' });
    const png = normalizedImage.toPNG();
    if (!png.length) throw new Error('E_OFFICE_RENDER_EMPTY: preview screenshot was empty');
    return png;
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    try { win?.destroy(); } catch { /* best effort */ }
    if (ses) await clearRenderSession(ses);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
