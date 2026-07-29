import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { BrowserWindow as ElectronBrowserWindow, Session } from 'electron';

import { isPathAllowed } from '../util/path-sandbox';
import { hardenedWebPreferences } from '../util/window-security';

const HTML_PREVIEW_TIMEOUT_MS = 20_000;
const HTML_PREVIEW_MAX_BLOCKED_RESOURCE_SAMPLES = 8;
const HTML_PREVIEW_MAX_DIAGNOSTICS = 12;

export type HtmlPreviewViewportName = 'desktop' | 'mobile';

export interface HtmlPreviewViewport {
  name: HtmlPreviewViewportName;
  width: number;
  height: number;
}

export interface HtmlPreviewLayoutIssue {
  selector: string;
  kind: 'left-overflow' | 'right-overflow';
  pixels: number;
}

export interface HtmlPreviewViewportEvidence {
  name: HtmlPreviewViewportName;
  width: number;
  height: number;
  screenshotWidth: number;
  screenshotHeight: number;
  readyState: string;
  title: string;
  visibleTextChars: number;
  scrollWidth: number;
  scrollHeight: number;
  horizontalOverflowPx: number;
  focusableCount: number;
  headingCount: number;
  missingAltCount: number;
  failedImageCount: number;
  layoutIssues: HtmlPreviewLayoutIssue[];
  consoleErrors: string[];
}

export interface HtmlPreviewDownloadEvidence {
  filename: string;
  mimeType: string;
  totalBytes: number;
  urlKind: 'data' | 'blob' | 'file' | 'other';
}

export interface HtmlPreviewKeyboardEvidence {
  method: 'tab-key';
  focusableFound: number;
  tabStopsVisited: number;
  uniqueTabStopsVisited: number;
  visibleFocusIndicators: number;
  sequence: string[];
  failures: string[];
}

export interface HtmlPreviewInteractionEvidence {
  viewport: HtmlPreviewViewportName;
  downloadCandidates: string[];
  formsFound: number;
  formsSubmitted: number;
  hashLinksChecked: number;
  mailtoLinksChecked: number;
  downloads: HtmlPreviewDownloadEvidence[];
  keyboard: HtmlPreviewKeyboardEvidence;
  failures: string[];
}

export interface HtmlPreviewEvidence {
  ok: boolean;
  entryPath: string;
  blockedResourceCount: number;
  blockedResourceSamples: string[];
  blockers: string[];
  warnings: string[];
  viewports: HtmlPreviewViewportEvidence[];
  screenshotCaptures: Array<{
    viewport: HtmlPreviewViewportName;
    width: number;
    height: number;
    captured: true;
  }>;
  interactions: HtmlPreviewInteractionEvidence;
}

export interface HtmlPreviewRenderResult {
  evidence: HtmlPreviewEvidence;
  screenshots: Buffer[];
}

type ElectronRuntime = {
  BrowserWindow?: new (options: Record<string, unknown>) => ElectronBrowserWindow;
  session?: {
    fromPartition(partition: string): Session;
  };
};

export interface HtmlPreviewRuntimeDeps {
  loadElectron?: () => Promise<ElectronRuntime>;
}

type PageEvidence = Omit<
  HtmlPreviewViewportEvidence,
  'name' | 'width' | 'height' | 'screenshotWidth' | 'screenshotHeight' | 'consoleErrors'
>;

type PageInteractionEvidence = Omit<
  HtmlPreviewInteractionEvidence,
  'viewport' | 'downloads' | 'keyboard'
>;

type RenderInteractionEvidence = PageInteractionEvidence & {
  keyboard: HtmlPreviewKeyboardEvidence;
};

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

const EVIDENCE_SCRIPT = `(() => {
  const viewportWidth = Math.max(1, document.documentElement.clientWidth || window.innerWidth || 1);
  const viewportHeight = Math.max(1, document.documentElement.clientHeight || window.innerHeight || 1);
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) > 0 && rect.width > 0.5 && rect.height > 0.5;
  };
  const selector = (element) => {
    if (element.id) return '#' + CSS.escape(element.id);
    const classes = Array.from(element.classList || []).slice(0, 2).map((value) => '.' + CSS.escape(value)).join('');
    return String(element.tagName || 'element').toLowerCase() + classes;
  };
  const issues = [];
  for (const element of Array.from(document.body?.querySelectorAll('*') || [])) {
    if (issues.length >= ${HTML_PREVIEW_MAX_DIAGNOSTICS} || !visible(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.left < -1) {
      issues.push({ selector: selector(element), kind: 'left-overflow', pixels: Math.ceil(Math.abs(rect.left)) });
    }
    if (issues.length < ${HTML_PREVIEW_MAX_DIAGNOSTICS} && rect.right > viewportWidth + 1) {
      issues.push({ selector: selector(element), kind: 'right-overflow', pixels: Math.ceil(rect.right - viewportWidth) });
    }
  }
  const focusableSelector = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
    'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]'
  ].join(',');
  const focusableCount = Array.from(document.querySelectorAll(focusableSelector)).filter(visible).length;
  const bodyText = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
  const images = Array.from(document.images || []);
  const scrollWidth = Math.max(
    document.documentElement.scrollWidth || 0,
    document.body?.scrollWidth || 0,
    viewportWidth
  );
  return {
    readyState: String(document.readyState || ''),
    title: String(document.title || '').slice(0, 200),
    visibleTextChars: bodyText.length,
    scrollWidth,
    scrollHeight: Math.max(document.documentElement.scrollHeight || 0, document.body?.scrollHeight || 0),
    horizontalOverflowPx: Math.max(0, Math.ceil(scrollWidth - viewportWidth)),
    focusableCount,
    headingCount: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
    missingAltCount: images.filter((img) => !img.hasAttribute('alt')).length,
    failedImageCount: images.filter((img) => img.complete && img.naturalWidth === 0).length,
    layoutIssues: issues
  };
})()`;

const INTERACTION_SCRIPT = `(async () => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) > 0 && rect.width > 0.5 && rect.height > 0.5;
  };
  const label = (element) => String(
    element.getAttribute?.('aria-label')
    || element.getAttribute?.('download')
    || element.textContent
    || element.id
    || element.tagName
    || 'control'
  ).replace(/\\s+/g, ' ').trim().slice(0, 120);
  const failures = [];
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const hashLinks = Array.from(document.querySelectorAll('a[href^="#"]')).filter(visible);
  let hashLinksChecked = 0;
  for (const link of hashLinks.slice(0, 20)) {
    try {
      const href = String(link.getAttribute('href') || '');
      const target = href && href !== '#' ? document.querySelector(href) : null;
      if (target) hashLinksChecked += 1;
      else failures.push('missing hash target for ' + label(link));
    } catch {
      failures.push('invalid hash target for ' + label(link));
    }
  }

  const mailtoLinks = Array.from(document.querySelectorAll('a[href^="mailto:"]')).filter(visible);
  let mailtoLinksChecked = 0;
  for (const link of mailtoLinks.slice(0, 10)) {
    try {
      const url = new URL(link.href);
      if (url.protocol === 'mailto:' && url.pathname.includes('@')) mailtoLinksChecked += 1;
      else failures.push('invalid mailto target for ' + label(link));
    } catch {
      failures.push('invalid mailto target for ' + label(link));
    }
  }

  const explicitDownloads = Array.from(document.querySelectorAll('a[download]')).filter(visible);
  const namedDownloadButtons = Array.from(document.querySelectorAll('button,[role="button"]'))
    .filter((element) => visible(element) && /download|resume|cv|简历|下载/i.test(label(element)));
  const downloadControls = [...explicitDownloads, ...namedDownloadButtons]
    .filter((element, index, values) => values.indexOf(element) === index)
    .slice(0, 10);
  const downloadCandidates = downloadControls.map(label);
  for (const control of downloadControls) {
    try {
      control.click();
      await sleep(120);
    } catch (error) {
      failures.push('download action failed for ' + label(control) + ': ' + String(error?.message || error));
    }
  }

  const forms = Array.from(document.forms || []).filter(visible).slice(0, 6);
  let formsSubmitted = 0;
  for (const form of forms) {
    try {
      for (const field of Array.from(form.elements || [])) {
        if (!visible(field) || field.disabled) continue;
        const type = String(field.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          if (field.required) field.checked = true;
        } else if (field instanceof HTMLSelectElement) {
          const option = Array.from(field.options).find((candidate) => !candidate.disabled && candidate.value);
          if (option) field.value = option.value;
        } else if (
          field instanceof HTMLInputElement
          || field instanceof HTMLTextAreaElement
        ) {
          if (type === 'email') field.value = 'preview-check@example.invalid';
          else if (type === 'url') field.value = 'https://example.invalid/';
          else if (type === 'number') field.value = field.min || '1';
          else if (!['button', 'submit', 'reset', 'file', 'hidden'].includes(type)) {
            field.value = 'Preview interaction check';
          }
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      if (!form.checkValidity()) {
        failures.push('form remained invalid after safe sample fill: ' + label(form));
        continue;
      }
      form.requestSubmit();
      formsSubmitted += 1;
      await sleep(160);
    } catch (error) {
      failures.push('form submit failed for ' + label(form) + ': ' + String(error?.message || error));
    }
  }

  return {
    downloadCandidates,
    formsFound: forms.length,
    formsSubmitted,
    hashLinksChecked,
    mailtoLinksChecked,
    failures: failures.slice(0, ${HTML_PREVIEW_MAX_DIAGNOSTICS})
  };
})()`;

const KEYBOARD_RESET_SCRIPT = `(() => {
  const active = document.activeElement;
  if (active && active instanceof HTMLElement) active.blur();
  if (document.body) {
    document.body.setAttribute('tabindex', '-1');
    document.body.focus({ preventScroll: true });
  }
  return true;
})()`;

const KEYBOARD_ACTIVE_SCRIPT = `(() => {
  const element = document.activeElement;
  if (!element || element === document.body || element === document.documentElement) return null;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const label = String(
    element.getAttribute?.('aria-label')
    || element.getAttribute?.('download')
    || element.textContent
    || element.getAttribute?.('name')
    || element.id
    || element.tagName
    || 'control'
  ).replace(/\\s+/g, ' ').trim().slice(0, 80);
  const id = String(element.id || '');
  const name = String(element.getAttribute?.('name') || '');
  const href = String(element.getAttribute?.('href') || '');
  const fingerprint = [
    String(element.tagName || 'element').toLowerCase(),
    id,
    name,
    href,
    label
  ].join('|').slice(0, 240);
  const outlineWidth = Number.parseFloat(style.outlineWidth || '0') || 0;
  const visibleFocusIndicator = element.matches(':focus-visible') && (
    (style.outlineStyle !== 'none' && outlineWidth > 0)
    || Boolean(style.boxShadow && style.boxShadow !== 'none')
  );
  return {
    fingerprint,
    label,
    visible: style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) > 0 && rect.width > 0.5 && rect.height > 0.5,
    visibleFocusIndicator
  };
})()`;

async function auditKeyboardTraversal(
  webContents: ElectronBrowserWindow['webContents'],
  focusableFound: number,
): Promise<HtmlPreviewKeyboardEvidence> {
  const failures: string[] = [];
  const sequence: string[] = [];
  const fingerprints = new Set<string>();
  let tabStopsVisited = 0;
  let visibleFocusIndicators = 0;
  await webContents.executeJavaScript(KEYBOARD_RESET_SCRIPT, true);
  webContents.focus();

  const attempts = Math.min(Math.max(focusableFound + 1, 1), 25);
  for (let index = 0; index < attempts; index += 1) {
    webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const active = await webContents.executeJavaScript(
      KEYBOARD_ACTIVE_SCRIPT,
      true,
    ) as null | {
      fingerprint: string;
      label: string;
      visible: boolean;
      visibleFocusIndicator: boolean;
    };
    if (!active) continue;
    if (!active.visible) {
      failures.push(`Tab reached a non-visible control: ${boundedDiagnostic(active.label)}`);
      continue;
    }
    tabStopsVisited += 1;
    if (!fingerprints.has(active.fingerprint)) {
      fingerprints.add(active.fingerprint);
      if (sequence.length < HTML_PREVIEW_MAX_DIAGNOSTICS) {
        sequence.push(boundedDiagnostic(active.label));
      }
      if (active.visibleFocusIndicator) visibleFocusIndicators += 1;
    }
    if (focusableFound > 0 && fingerprints.size >= focusableFound) break;
  }

  if (focusableFound > 0 && fingerprints.size === 0) {
    failures.push('Tab key did not reach any visible focusable control');
  }
  if (fingerprints.size > 0 && visibleFocusIndicators === 0) {
    failures.push('Tab traversal found no visible focus indicator');
  }

  return {
    method: 'tab-key',
    focusableFound,
    tabStopsVisited,
    uniqueTabStopsVisited: fingerprints.size,
    visibleFocusIndicators,
    sequence,
    failures: failures.slice(0, HTML_PREVIEW_MAX_DIAGNOSTICS),
  };
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), HTML_PREVIEW_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function boundedDiagnostic(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 400);
}

function blockedResourceLabel(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === 'file:') return 'file:outside-entry-directory';
    if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.protocol}//${url.host}`;
    return url.protocol || 'unknown:';
  } catch {
    return 'invalid-url';
  }
}

function allowedPreviewRequest(raw: string, entryRootReal: string): boolean {
  if (/^(?:data|blob|about):/i.test(raw)) return true;
  if (!raw.startsWith('file:')) return false;
  try {
    const requested = fs.realpathSync(fileURLToPath(raw));
    return isPathAllowed(requested, [entryRootReal]);
  } catch {
    return false;
  }
}

function registerNetworkIsolation(
  ses: Session,
  entryRootReal: string,
  blocked: { count: number; samples: string[] },
): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    const raw = String(details.url || '');
    const allowed = allowedPreviewRequest(raw, entryRootReal);
    if (!allowed) {
      blocked.count += 1;
      const label = blockedResourceLabel(raw);
      if (
        blocked.samples.length < HTML_PREVIEW_MAX_BLOCKED_RESOURCE_SAMPLES
        && !blocked.samples.includes(label)
      ) {
        blocked.samples.push(label);
      }
    }
    callback({ cancel: !allowed });
  });
}

function registerPermissionIsolation(ses: Session): void {
  // Electron grants permission requests by default unless the application
  // installs handlers. Previewed HTML is untrusted local content, so it must
  // never reach clipboard, media, display-capture, filesystem, HID, serial,
  // USB, geolocation, notification, or other host permission surfaces.
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    callback({});
  });
}

async function clearPreviewSession(ses: Session): Promise<void> {
  try { ses.webRequest.onBeforeRequest(null); } catch { /* best effort */ }
  try { ses.removeAllListeners('will-download'); } catch { /* best effort */ }
  try { ses.setPermissionCheckHandler(null); } catch { /* best effort */ }
  try { ses.setPermissionRequestHandler(null); } catch { /* best effort */ }
  try { ses.setDevicePermissionHandler(null); } catch { /* best effort */ }
  try { ses.setDisplayMediaRequestHandler(null); } catch { /* best effort */ }
  await Promise.allSettled([
    ses.clearCache(),
    ses.clearStorageData(),
  ]);
}

function consoleErrorListener(target: string[]) {
  return (_event: unknown, levelOrDetails: unknown, message?: unknown) => {
    const details = levelOrDetails && typeof levelOrDetails === 'object'
      ? levelOrDetails as { level?: unknown; message?: unknown }
      : null;
    const level = details?.level ?? levelOrDetails;
    const value = details?.message ?? message;
    const isError = level === 'error' || (typeof level === 'number' && level >= 2);
    if (!isError || target.length >= HTML_PREVIEW_MAX_DIAGNOSTICS) return;
    const text = boundedDiagnostic(value);
    if (text && !target.includes(text)) target.push(text);
  };
}

async function renderViewport(
  BrowserWindow: NonNullable<ElectronRuntime['BrowserWindow']>,
  ses: Session,
  entryUrl: string,
  viewport: HtmlPreviewViewport,
  exerciseInteractions: boolean,
): Promise<{
  evidence: HtmlPreviewViewportEvidence;
  screenshot: Buffer;
  interactions?: RenderInteractionEvidence;
}> {
  const consoleErrors: string[] = [];
  const win = new BrowserWindow({
    show: false,
    width: viewport.width,
    height: viewport.height,
    useContentSize: true,
    backgroundColor: '#ffffff',
    webPreferences: hardenedWebPreferences({
      session: ses,
      backgroundThrottling: false,
    }),
  });
  const webContents = win.webContents;
  webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event: { preventDefault(): void }, targetUrl: string) => {
    if (targetUrl !== entryUrl) event.preventDefault();
  });
  webContents.on('console-message', consoleErrorListener(consoleErrors));

  try {
    await withTimeout(
      win.loadURL(entryUrl),
      `E_HTML_PREVIEW_LOAD_TIMEOUT: ${viewport.name} HTML did not finish loading`,
    );
    await withTimeout(
      webContents.executeJavaScript(READY_SCRIPT, true),
      `E_HTML_PREVIEW_READY_TIMEOUT: ${viewport.name} fonts or images did not settle`,
    );
    const page = await withTimeout(
      webContents.executeJavaScript(EVIDENCE_SCRIPT, true) as Promise<PageEvidence>,
      `E_HTML_PREVIEW_INSPECT_TIMEOUT: ${viewport.name} layout inspection timed out`,
    );
    const image = await withTimeout(
      webContents.capturePage(),
      `E_HTML_PREVIEW_CAPTURE_TIMEOUT: ${viewport.name} screenshot timed out`,
    );
    const interactions = exerciseInteractions
      ? await withTimeout(
        (async () => {
          const keyboard = await auditKeyboardTraversal(webContents, page.focusableCount);
          const safeInteractions = await webContents.executeJavaScript(
            INTERACTION_SCRIPT,
            true,
          ) as PageInteractionEvidence;
          return { ...safeInteractions, keyboard };
        })(),
        `E_HTML_PREVIEW_INTERACTION_TIMEOUT: ${viewport.name} safe interaction audit timed out`,
      )
      : undefined;
    const size = image.getSize();
    return {
      evidence: {
        name: viewport.name,
        width: viewport.width,
        height: viewport.height,
        screenshotWidth: size.width,
        screenshotHeight: size.height,
        ...page,
        consoleErrors,
      },
      screenshot: image.toPNG(),
      ...(interactions ? { interactions } : {}),
    };
  } finally {
    try { win.destroy(); } catch { /* best effort */ }
  }
}

/**
 * Render one local HTML entry at a desktop and mobile viewport using the
 * packaged Electron runtime. Network access is denied; only data/blob/about
 * URLs and real files below the entry directory are allowed.
 */
export async function renderResponsiveHtmlPreview(
  entryPath: string,
  viewports: readonly [HtmlPreviewViewport, HtmlPreviewViewport],
  deps: HtmlPreviewRuntimeDeps = {},
): Promise<HtmlPreviewRenderResult> {
  const entryAbs = path.resolve(entryPath);
  const entryReal = fs.realpathSync(entryAbs);
  const entryRootReal = fs.realpathSync(path.dirname(entryReal));
  const electron = await (deps.loadElectron?.() ?? import('electron') as Promise<ElectronRuntime>);
  const BrowserWindow = electron.BrowserWindow;
  const electronSession = electron.session;
  if (!BrowserWindow || !electronSession) {
    throw new Error('E_HTML_PREVIEW_BROWSER_UNAVAILABLE: Electron BrowserWindow is unavailable');
  }

  const blocked = { count: 0, samples: [] as string[] };
  const partition = `html-preview-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const ses = electronSession.fromPartition(partition);
  registerPermissionIsolation(ses);
  try {
    registerNetworkIsolation(ses, entryRootReal, blocked);
    const downloads: HtmlPreviewDownloadEvidence[] = [];
    ses.on('will-download', (event, item) => {
      const rawUrl = String(item.getURL?.() || '');
      const urlKind = rawUrl.startsWith('data:')
        ? 'data'
        : rawUrl.startsWith('blob:')
          ? 'blob'
          : rawUrl.startsWith('file:')
            ? 'file'
            : 'other';
      if (downloads.length < HTML_PREVIEW_MAX_DIAGNOSTICS) {
        downloads.push({
          filename: boundedDiagnostic(item.getFilename?.()),
          mimeType: boundedDiagnostic(item.getMimeType?.()),
          totalBytes: Math.max(0, Number(item.getTotalBytes?.()) || 0),
          urlKind,
        });
      }
      event.preventDefault();
    });
    const entryUrl = pathToFileURL(entryReal).toString();
    const rendered: Array<{
      evidence: HtmlPreviewViewportEvidence;
      screenshot: Buffer;
      interactions?: RenderInteractionEvidence;
    }> = [];
    for (const [index, viewport] of viewports.entries()) {
      rendered.push(await renderViewport(BrowserWindow, ses, entryUrl, viewport, index === 0));
    }

    const blockers: string[] = [];
    const warnings: string[] = [];
    for (const item of rendered) {
      const view = item.evidence;
      if (view.horizontalOverflowPx > 1) {
        blockers.push(
          `${view.name}: horizontal overflow is ${view.horizontalOverflowPx}px `
          + `(scrollWidth ${view.scrollWidth}px > viewport ${view.width}px)`,
        );
      }
      if (view.consoleErrors.length) {
        blockers.push(`${view.name}: ${view.consoleErrors.length} console/runtime error(s)`);
      }
      if (view.failedImageCount) {
        blockers.push(`${view.name}: ${view.failedImageCount} image(s) failed to load`);
      }
      if (view.missingAltCount) {
        warnings.push(`${view.name}: ${view.missingAltCount} image(s) are missing alt attributes`);
      }
      if (!view.focusableCount) {
        warnings.push(`${view.name}: no keyboard-focusable control was detected`);
      }
    }
    if (blocked.count) {
      blockers.push(`${blocked.count} external or out-of-directory resource request(s) were blocked`);
    }
    const pageInteractions = rendered[0]?.interactions ?? {
      downloadCandidates: [],
      formsFound: 0,
      formsSubmitted: 0,
      hashLinksChecked: 0,
      mailtoLinksChecked: 0,
      keyboard: {
        method: 'tab-key' as const,
        focusableFound: rendered[0]?.evidence.focusableCount ?? 0,
        tabStopsVisited: 0,
        uniqueTabStopsVisited: 0,
        visibleFocusIndicators: 0,
        sequence: [],
        failures: ['desktop keyboard audit did not return evidence'],
      },
      failures: ['desktop interaction audit did not return evidence'],
    };
    if (pageInteractions.keyboard.failures.length) {
      blockers.push(`${pageInteractions.keyboard.failures.length} keyboard traversal check(s) failed`);
    }
    if (pageInteractions.failures.length) {
      blockers.push(`${pageInteractions.failures.length} safe interaction check(s) failed`);
    }
    if (
      pageInteractions.downloadCandidates.length
      && downloads.length < pageInteractions.downloadCandidates.length
    ) {
      blockers.push(
        `${pageInteractions.downloadCandidates.length} download action(s) were exercised `
        + `but only ${downloads.length} download(s) were observed`,
      );
    }
    const incompleteDownloads = downloads.filter((download) => (
      !download.filename
      || !download.mimeType
      || download.totalBytes <= 0
    ));
    if (incompleteDownloads.length) {
      blockers.push(
        `${incompleteDownloads.length} observed download(s) lacked a filename, MIME type, or non-empty payload`,
      );
    }

    return {
      evidence: {
        ok: blockers.length === 0,
        entryPath: entryAbs,
        blockedResourceCount: blocked.count,
        blockedResourceSamples: blocked.samples,
        blockers,
        warnings,
        viewports: rendered.map((item) => item.evidence),
        screenshotCaptures: rendered.map((item) => ({
          viewport: item.evidence.name,
          width: item.evidence.screenshotWidth,
          height: item.evidence.screenshotHeight,
          captured: true as const,
        })),
        interactions: {
          viewport: rendered[0]?.evidence.name ?? 'desktop',
          ...pageInteractions,
          downloads,
        },
      },
      screenshots: rendered.map((item) => item.screenshot),
    };
  } finally {
    await clearPreviewSession(ses);
  }
}
