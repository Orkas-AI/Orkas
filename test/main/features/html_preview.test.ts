import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  renderInteractiveHtmlSmoke,
  renderResponsiveHtmlPreview,
  type HtmlPreviewRuntimeDeps,
} from '../../../src/main/features/html_preview';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-html-preview-feature-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><main>Preview</main>');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function pageEvidence(width: number, overflow = 0) {
  return {
    readyState: 'complete',
    title: 'Preview',
    visibleTextChars: 7,
    scrollWidth: width + overflow,
    scrollHeight: 900,
    horizontalOverflowPx: overflow,
    focusableCount: 1,
    headingCount: 1,
    missingAltCount: 0,
    failedImageCount: 0,
    layoutIssues: overflow
      ? [{ selector: '.cta', kind: 'right-overflow', pixels: overflow }]
      : [],
  };
}

function fakeRuntime(options: {
  mobileOverflow?: number;
  externalRequest?: boolean;
  consoleError?: string;
  downloadCandidate?: boolean;
  downloadObserved?: boolean;
  downloadBytes?: number;
  keyboardFocusIndicator?: boolean;
  controlsExercised?: number;
  stateChangesObserved?: number;
  artifactMessagesObserved?: number;
  stateControlsFound?: number;
  stateControlsExercised?: number;
  stateTransitionsObserved?: number;
  formsFound?: number;
  formsSubmitted?: number;
  interactionFailures?: string[];
  loadFailure?: boolean;
} = {}): {
  deps: HtmlPreviewRuntimeDeps;
  windows: Array<{ options: Record<string, any>; destroyed: boolean }>;
  requestDecisions: Array<{ url: string; cancel: boolean }>;
  permissionDecisions: {
    check: boolean[];
    request: boolean[];
    device: boolean[];
    display: Array<Record<string, unknown>>;
  };
  sessionCleanup: { cache: boolean; storage: boolean };
  loadedEntryUrls: string[];
  bridgeAvailableAtLoad: boolean[];
  interactionExecutions: string[];
} {
  const windows: Array<{ options: Record<string, any>; destroyed: boolean }> = [];
  const requestDecisions: Array<{ url: string; cancel: boolean }> = [];
  const permissionDecisions = {
    check: [] as boolean[],
    request: [] as boolean[],
    device: [] as boolean[],
    display: [] as Array<Record<string, unknown>>,
  };
  const sessionCleanup = { cache: false, storage: false };
  const loadedEntryUrls: string[] = [];
  const bridgeAvailableAtLoad: boolean[] = [];
  const interactionExecutions: string[] = [];
  let requestHandler: ((details: { url: string }, callback: (decision: { cancel: boolean }) => void) => void) | undefined;
  const sessionListeners = new Map<string, Function>();
  let tabKeyDowns = 0;

  class FakeBrowserWindow {
    options: Record<string, any>;
    destroyed = false;
    webContents: any;

    constructor(windowOptions: Record<string, any>) {
      this.options = windowOptions;
      const listeners = new Map<string, Function>();
      this.webContents = {
        setWindowOpenHandler: () => undefined,
        on: (name: string, listener: Function) => listeners.set(name, listener),
        focus: () => undefined,
        sendInputEvent: (event: { type: string; keyCode?: string }) => {
          if (event.type === 'keyDown' && event.keyCode === 'Tab') tabKeyDowns += 1;
        },
        executeJavaScript: async (script: string) => {
          if (script.includes('document.body.setAttribute')) return true;
          if (script.includes('visibleFocusIndicator')) {
            return tabKeyDowns
              ? {
                fingerprint: 'button||||Contact',
                label: 'Contact',
                visible: true,
                visibleFocusIndicator: options.keyboardFocusIndicator !== false,
              }
              : null;
          }
          if (script.includes('downloadCandidates')) {
            interactionExecutions.push(String(windowOptions.width));
            if (options.downloadObserved) {
              sessionListeners.get('will-download')?.(
                { preventDefault: () => undefined },
                {
                  getURL: () => 'blob:file-preview',
                  getFilename: () => 'resume.txt',
                  getMimeType: () => 'text/plain',
                  getTotalBytes: () => options.downloadBytes ?? 128,
                },
              );
            }
            return {
              controlsExercised: options.controlsExercised ?? 1,
              stateChangesObserved: options.stateChangesObserved ?? 0,
              artifactMessagesObserved: options.artifactMessagesObserved ?? 0,
              stateControlsFound: options.stateControlsFound ?? 0,
              stateControlsExercised: options.stateControlsExercised ?? 0,
              stateTransitionsObserved: options.stateTransitionsObserved ?? 0,
              downloadCandidates: options.downloadCandidate ? ['Download resume'] : [],
              formsFound: options.formsFound ?? 0,
              formsSubmitted: options.formsSubmitted ?? 0,
              hashLinksChecked: 0,
              mailtoLinksChecked: 0,
              failures: options.interactionFailures ?? [],
            };
          }
          return script.startsWith('(async')
            ? true
            : pageEvidence(
              Number(windowOptions.width),
              Number(windowOptions.width) <= 480 ? options.mobileOverflow ?? 0 : 0,
            );
        },
        capturePage: async () => ({
          getSize: () => ({ width: Number(windowOptions.width), height: Number(windowOptions.height) }),
          toPNG: () => Buffer.from(`png:${windowOptions.width}x${windowOptions.height}`),
        }),
      };
      (windows as any).push(this);
    }

    async loadURL(url: string) {
      loadedEntryUrls.push(url);
      const entryPath = fileURLToPath(url);
      bridgeAvailableAtLoad.push(fs.existsSync(path.join(path.dirname(entryPath), '__orkas', 'bridge.js')));
      requestHandler?.({ url }, (decision) => requestDecisions.push({ url, cancel: decision.cancel }));
      if (options.loadFailure) throw new Error('synthetic preview load failure');
      if (options.externalRequest) {
        const external = 'https://example.invalid/tracker.png';
        requestHandler?.(
          { url: external },
          (decision) => requestDecisions.push({ url: external, cancel: decision.cancel }),
        );
      }
      if (options.consoleError) {
        const listener = this.webContents.on && undefined;
        void listener;
      }
    }

    destroy() {
      this.destroyed = true;
    }
  }

  const deps: HtmlPreviewRuntimeDeps = {
    loadElectron: async () => ({
      BrowserWindow: FakeBrowserWindow as any,
      session: {
        fromPartition: () => ({
          on: (name: string, listener: Function) => sessionListeners.set(name, listener),
          removeAllListeners: (name: string) => sessionListeners.delete(name),
          setPermissionCheckHandler: (handler: Function | null) => {
            if (handler) permissionDecisions.check.push(handler(null, 'clipboard-read', 'file://preview', {}));
          },
          setPermissionRequestHandler: (handler: Function | null) => {
            if (handler) {
              handler(null, 'media', (allowed: boolean) => permissionDecisions.request.push(allowed), {});
            }
          },
          setDevicePermissionHandler: (handler: Function | null) => {
            if (handler) permissionDecisions.device.push(handler({ deviceType: 'usb' }));
          },
          setDisplayMediaRequestHandler: (handler: Function | null) => {
            if (handler) {
              handler({}, (streams: Record<string, unknown>) => {
                permissionDecisions.display.push(streams);
              });
            }
          },
          clearCache: async () => { sessionCleanup.cache = true; },
          clearStorageData: async () => { sessionCleanup.storage = true; },
          webRequest: {
            onBeforeRequest: (handler: typeof requestHandler) => {
              requestHandler = handler;
            },
          },
        } as any),
      },
    }),
  };
  return {
    deps,
    windows,
    requestDecisions,
    permissionDecisions,
    sessionCleanup,
    loadedEntryUrls,
    bridgeAvailableAtLoad,
    interactionExecutions,
  };
}

const viewports = [
  { name: 'desktop' as const, width: 1440, height: 900 },
  { name: 'mobile' as const, width: 390, height: 844 },
] as const;

describe('responsive HTML preview renderer', () => {
  it('uses hardened isolated windows and returns ordered desktop/mobile screenshots', async () => {
    const runtime = fakeRuntime();
    const result = await renderResponsiveHtmlPreview(
      path.join(root, 'index.html'),
      viewports,
      runtime.deps,
    );

    expect(result.evidence.ok).toBe(true);
    expect(result.evidence.viewports.map((item) => item.name)).toEqual(['desktop', 'mobile']);
    expect(result.evidence.screenshotCaptures).toEqual([
      { viewport: 'desktop', width: 1440, height: 900, captured: true },
      { viewport: 'mobile', width: 390, height: 844, captured: true },
    ]);
    expect(result.evidence.interactions.keyboard).toMatchObject({
      method: 'tab-key',
      focusableFound: 1,
      uniqueTabStopsVisited: 1,
      visibleFocusIndicators: 1,
      sequence: ['Contact'],
      failures: [],
    });
    expect(result.evidence.interactions.performed).toBe(true);
    expect(runtime.interactionExecutions).toEqual(['1440']);
    expect(result.screenshots.map((value) => value.toString())).toEqual([
      'png:1440x900',
      'png:390x844',
    ]);
    expect(runtime.windows).toHaveLength(2);
    for (const win of runtime.windows) {
      expect(win.options).toMatchObject({
        show: false,
        useContentSize: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          backgroundThrottling: false,
        },
      });
      expect(win.destroyed).toBe(true);
    }
    const entryUrl = pathToFileURL(fs.realpathSync(path.join(root, 'index.html'))).toString();
    expect(runtime.requestDecisions).toEqual([
      { url: entryUrl, cancel: false },
      { url: entryUrl, cancel: false },
    ]);
    expect(runtime.permissionDecisions).toEqual({
      check: [false],
      request: [false],
      device: [false],
      display: [{}],
    });
    expect(runtime.sessionCleanup).toEqual({ cache: true, storage: true });
  });

  it('renders and audits only the one fixed viewport requested by the caller', async () => {
    const runtime = fakeRuntime();
    const mobileOnly = [{ name: 'mobile' as const, width: 390, height: 844 }];

    const result = await renderResponsiveHtmlPreview(
      path.join(root, 'index.html'),
      mobileOnly,
      runtime.deps,
    );

    expect(result.evidence.ok).toBe(true);
    expect(result.evidence.viewports.map((item) => item.name)).toEqual(['mobile']);
    expect(result.evidence.screenshotCaptures).toEqual([
      { viewport: 'mobile', width: 390, height: 844, captured: true },
    ]);
    expect(result.evidence.interactions.viewport).toBe('mobile');
    expect(result.screenshots.map((value) => value.toString())).toEqual(['png:390x844']);
    expect(runtime.windows).toHaveLength(1);
    expect(runtime.windows[0].destroyed).toBe(true);
  });

  it('preserves render, layout, screenshot, and keyboard evidence without exercising UI behavior', async () => {
    const runtime = fakeRuntime({
      controlsExercised: 7,
      formsSubmitted: 3,
      interactionFailures: ['enabled control produced no observable outcome: Sign in'],
    });

    const result = await renderResponsiveHtmlPreview(
      path.join(root, 'index.html'),
      [{ name: 'desktop', width: 1440, height: 900 }],
      runtime.deps,
      { interactions: false },
    );

    expect(result.evidence.ok).toBe(true);
    expect(result.evidence.viewports).toMatchObject([{
      name: 'desktop',
      readyState: 'complete',
      horizontalOverflowPx: 0,
      consoleErrors: [],
    }]);
    expect(result.evidence.screenshotCaptures).toEqual([
      { viewport: 'desktop', width: 1440, height: 900, captured: true },
    ]);
    expect(result.evidence.interactions).toMatchObject({
      performed: false,
      controlsExercised: 0,
      formsSubmitted: 0,
      failures: [],
      keyboard: {
        method: 'tab-key',
        uniqueTabStopsVisited: 1,
        visibleFocusIndicators: 1,
        failures: [],
      },
    });
    expect(runtime.interactionExecutions).toEqual([]);
    expect(result.screenshots.map((value) => value.toString())).toEqual(['png:1440x900']);
  });

  it('turns mobile overflow into a blocking result instead of a successful screenshot-only claim', async () => {
    const runtime = fakeRuntime({ mobileOverflow: 28 });
    const result = await renderResponsiveHtmlPreview(
      path.join(root, 'index.html'),
      viewports,
      runtime.deps,
    );

    expect(result.evidence.ok).toBe(false);
    expect(result.evidence.viewports[1]).toMatchObject({
      name: 'mobile',
      width: 390,
      scrollWidth: 418,
      horizontalOverflowPx: 28,
    });
    expect(result.evidence.blockers).toContain(
      'mobile: horizontal overflow is 28px (scrollWidth 418px > viewport 390px)',
    );
  });

  it('destroys the window and clears the isolated session after a render failure', async () => {
    const runtime = fakeRuntime({ loadFailure: true });

    await expect(renderResponsiveHtmlPreview(
      path.join(root, 'index.html'),
      viewports,
      runtime.deps,
    )).rejects.toThrow('synthetic preview load failure');

    expect(runtime.windows).toHaveLength(1);
    expect(runtime.windows[0]?.destroyed).toBe(true);
    expect(runtime.sessionCleanup).toEqual({ cache: true, storage: true });
  });

  it('blocks remote resources and reports only a bounded origin label', async () => {
    const runtime = fakeRuntime({ externalRequest: true });
    const result = await renderResponsiveHtmlPreview(
      path.join(root, 'index.html'),
      viewports,
      runtime.deps,
    );

    expect(result.evidence.ok).toBe(false);
    expect(result.evidence.blockedResourceCount).toBe(2);
    expect(result.evidence.blockedResourceSamples).toEqual(['https://example.invalid']);
    expect(result.evidence.blockers).toContain(
      '2 external or out-of-directory resource request(s) were blocked',
    );
    expect(runtime.requestDecisions.filter((item) => item.url.startsWith('https:')))
      .toEqual([
        { url: 'https://example.invalid/tracker.png', cancel: true },
        { url: 'https://example.invalid/tracker.png', cancel: true },
      ]);
  });

  it('records observed download metadata and rejects a download control that produces nothing', async () => {
    const observed = fakeRuntime({ downloadCandidate: true, downloadObserved: true });
    const passed = await renderResponsiveHtmlPreview(
      path.join(root, 'index.html'),
      viewports,
      observed.deps,
    );
    expect(passed.evidence.ok).toBe(true);
    expect(passed.evidence.interactions).toMatchObject({
      downloadCandidates: ['Download resume'],
      downloads: [{
        filename: 'resume.txt',
        mimeType: 'text/plain',
        totalBytes: 128,
        urlKind: 'blob',
      }],
    });

    const missing = fakeRuntime({ downloadCandidate: true });
    const failed = await renderResponsiveHtmlPreview(
      path.join(root, 'index.html'),
      viewports,
      missing.deps,
    );
    expect(failed.evidence.ok).toBe(false);
    expect(failed.evidence.blockers).toContain(
      '1 download action(s) were exercised but only 0 download(s) were observed',
    );

    const empty = fakeRuntime({
      downloadCandidate: true,
      downloadObserved: true,
      downloadBytes: 0,
    });
    const emptyPayload = await renderResponsiveHtmlPreview(
      path.join(root, 'index.html'),
      viewports,
      empty.deps,
    );
    expect(emptyPayload.evidence.ok).toBe(false);
    expect(emptyPayload.evidence.blockers).toContain(
      '1 observed download(s) lacked a filename, MIME type, or non-empty payload',
    );
  });

  it('rejects keyboard traversal when focused controls have no visible indicator', async () => {
    const runtime = fakeRuntime({ keyboardFocusIndicator: false });
    const result = await renderResponsiveHtmlPreview(
      path.join(root, 'index.html'),
      viewports,
      runtime.deps,
    );

    expect(result.evidence.ok).toBe(false);
    expect(result.evidence.interactions.keyboard).toMatchObject({
      method: 'tab-key',
      uniqueTabStopsVisited: 1,
      visibleFocusIndicators: 0,
      failures: ['Tab traversal found no visible focus indicator'],
    });
    expect(result.evidence.blockers).toContain('1 keyboard traversal check(s) failed');
  });

  it('returns multi-state coverage and blocks a control with no observable outcome', async () => {
    const runtime = fakeRuntime({
      controlsExercised: 7,
      stateChangesObserved: 5,
      stateControlsFound: 3,
      stateControlsExercised: 3,
      stateTransitionsObserved: 2,
      formsFound: 3,
      formsSubmitted: 3,
      interactionFailures: ['enabled control produced no observable outcome: Create account'],
    });
    const result = await renderResponsiveHtmlPreview(
      path.join(root, 'index.html'),
      [{ name: 'desktop', width: 1440, height: 900 }],
      runtime.deps,
    );

    expect(result.evidence.ok).toBe(false);
    expect(result.evidence.interactions).toMatchObject({
      stateControlsFound: 3,
      stateControlsExercised: 3,
      stateTransitionsObserved: 2,
      formsFound: 3,
      formsSubmitted: 3,
    });
    expect(result.evidence.blockers).toContain('1 safe interaction check(s) failed');
  });

  it('requires an observable behavior only for interactive artifact smoke', async () => {
    const staticRuntime = fakeRuntime({ controlsExercised: 1, stateChangesObserved: 0 });
    const staticResult = await renderInteractiveHtmlSmoke(
      path.join(root, 'index.html'),
      staticRuntime.deps,
    );
    expect(staticResult.evidence.ok).toBe(false);
    expect(staticResult.evidence.blockers).toContain(
      'interactive artifact smoke observed no visible state change, artifact submission, or download',
    );

    const downloadRuntime = fakeRuntime({
      controlsExercised: 1,
      downloadCandidate: true,
      downloadObserved: true,
    });
    const downloadResult = await renderInteractiveHtmlSmoke(
      path.join(root, 'index.html'),
      downloadRuntime.deps,
    );
    expect(downloadResult.evidence.ok).toBe(true);

    const interactiveRuntime = fakeRuntime({ controlsExercised: 2, stateChangesObserved: 1 });
    const interactiveResult = await renderInteractiveHtmlSmoke(
      path.join(root, 'index.html'),
      interactiveRuntime.deps,
      { bridgeJavaScript: 'window.orkasArtifact = { send() {} };' },
    );
    expect(interactiveResult.evidence.ok).toBe(true);
    expect(interactiveResult.evidence.interactions).toMatchObject({
      controlsExercised: 2,
      stateChangesObserved: 1,
    });
    expect(interactiveRuntime.bridgeAvailableAtLoad).toEqual([true, true]);
    expect(interactiveRuntime.loadedEntryUrls.every((url) => (
      !fs.existsSync(path.dirname(fileURLToPath(url)))
    ))).toBe(true);
  });
});
