/**
 * Browser-rendered retry for `web_fetch`.
 *
 * Why this exists:
 *   - `web_fetch` is a plain HTTP GET with a regex text extractor. Two common
 *     shapes defeat it: pages that ship their body inside `<script>` payloads
 *     (YouTube's `ytInitialData`, Next.js `__NEXT_DATA__`), which the extractor
 *     strips before reading, and pages that answer with a JavaScript
 *     proof-of-work or anti-bot interstitial instead of content. Both return
 *     markup with effectively no readable text.
 *   - Orkas already ships Chromium. Rendering such a page in an offscreen
 *     window runs those scripts and keeps the user's own network path, which a
 *     datacenter extraction service cannot reproduce.
 *
 * Scope:
 *   - core-agent owns the policy: it decides *when* to retry (only for a bot
 *     check or a shell) and judges whether the rendered document is usable.
 *     This module only produces a rendered document, or null.
 *   - One render at a time behind a bounded queue, a hard per-render deadline,
 *     and an isolated non-persistent session.
 *   - Destroying a render window emits `window-all-closed`. Today that is
 *     harmless: index.ts only quits off darwin, and off darwin the app has no
 *     windowless state, so the main window is always still open. A future tray
 *     or background mode that outlives the main window would have to keep this
 *     window out of that quit path.
 */
import { app, BrowserWindow, session, type Session } from 'electron';
import type { WebFetchRenderedPage } from '#core-agent';
import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import { hardenedWebPreferences } from '../../util/window-security';

const log = createLogger('web-fetch-render');

/** Not `persist:` — the partition lives in memory and never touches the app
 * session, so a rendered page cannot read Orkas cookies or storage. Reusing one
 * partition still lets a solved challenge cookie serve later renders. */
const RENDER_PARTITION = 'web-fetch-render';

const RENDER_TIMEOUT_MS = 25_000;
const FIRST_SAMPLE_DELAY_MS = 1_200;
const SAMPLE_INTERVAL_MS = 800;
/** Stop sampling once the document carries this much non-whitespace text; it
 * mirrors core-agent's shell threshold so a challenge that resolves into a real
 * page is detected as soon as the body lands. */
const READY_TEXT_CHARS = 600;
const MAX_RENDERED_HTML_CHARS = 8 * 1024 * 1024;
/** A burst of failed fetches must not serialize into minutes of rendering. */
const MAX_QUEUED_RENDERS = 3;

let renderQueue: Promise<unknown> = Promise.resolve();
let queuedRenders = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Electron's default user agent advertises `Electron/<ver>` and the app name
 * beside the real Chromium version. Drop only those two tokens so the claimed
 * engine still matches what actually renders — hardcoding a Chrome version
 * would drift away from the shipped Chromium at the next upgrade.
 */
function chromeLikeUserAgent(): string {
  const base = String(app.userAgentFallback || '');
  if (!base) return '';
  const appName = String(app.getName() || '');
  let ua = base.replace(/\sElectron\/\S+/i, '');
  if (appName) ua = ua.replace(new RegExp(`\\s${escapeRegExp(appName)}\\/\\S+`, 'i'), '');
  return ua.replace(/\s{2,}/g, ' ').trim();
}

function prepareSession(ses: Session): void {
  // Electron grants permission requests by default. A rendered third-party page
  // is untrusted and needs no host capability at all.
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  ses.removeAllListeners('will-download');
  ses.on('will-download', (event) => event.preventDefault());
}

type DocumentSample = { href: string; textChars: number };

const SAMPLE_SCRIPT = `(() => {
  const body = document.body;
  const text = body && body.innerText ? body.innerText : '';
  return { href: location.href, textChars: text.replace(/\\s+/g, '').length };
})()`;

const HTML_SCRIPT = '(() => document.documentElement ? document.documentElement.outerHTML : "")()';

async function renderOnce(url: string, signal?: AbortSignal): Promise<WebFetchRenderedPage | null> {
  const ses = session.fromPartition(RENDER_PARTITION);
  prepareSession(ses);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    useContentSize: true,
    webPreferences: hardenedWebPreferences({
      session: ses,
      backgroundThrottling: false,
    }),
  });
  const webContents = win.webContents;
  const destroy = (): void => { try { win.destroy(); } catch { /* best effort */ } };
  const STOPPED = Symbol('web-fetch-render-stopped');
  let stopped = false;
  let resolveStopped!: (value: typeof STOPPED) => void;
  const stoppedPromise = new Promise<typeof STOPPED>((resolve) => { resolveStopped = resolve; });
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    destroy();
    resolveStopped(STOPPED);
  };
  // The deadline owns the whole browser attempt, including loadURL. Starting
  // it after navigation completed left a page whose load event never fired at
  // the head of the serial queue forever (2026-08-31 review CR-016).
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  const deadlineTimer = setTimeout(stop, RENDER_TIMEOUT_MS);
  signal?.addEventListener('abort', stop, { once: true });

  try {
    const userAgent = chromeLikeUserAgent();
    if (userAgent) webContents.setUserAgent(userAgent);
    webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    // Challenge pages resolve by navigating (redirect or an auto-submitted
    // form), so navigation must stay allowed — but only to web origins.
    webContents.on('will-navigate', (event: { preventDefault(): void }, targetUrl: string) => {
      if (!/^https?:\/\//i.test(targetUrl)) event.preventDefault();
    });

    // A challenge page still "loads" successfully, and an interstitial that
    // navigates away aborts the first load. Neither is fatal: keep sampling
    // until the document carries real text or the deadline passes.
    await Promise.race([
      win.loadURL(url).catch(() => undefined),
      stoppedPromise,
    ]);
    if (stopped) return null;

    let lastSample: DocumentSample | null = null;
    await Promise.race([delay(FIRST_SAMPLE_DELAY_MS), stoppedPromise]);
    while (!stopped && !win.isDestroyed()) {
      try {
        const sample = await Promise.race([
          webContents.executeJavaScript(SAMPLE_SCRIPT, true) as Promise<DocumentSample>,
          stoppedPromise,
        ]);
        if (sample === STOPPED) return null;
        lastSample = sample;
        if (sample.textChars >= READY_TEXT_CHARS) break;
      } catch {
        // Sampling races page navigation; retry on the next tick.
      }
      if (Date.now() >= deadline) break;
      await Promise.race([delay(SAMPLE_INTERVAL_MS), stoppedPromise]);
    }
    if (stopped || win.isDestroyed()) return null;

    const html = await Promise.race([
      webContents.executeJavaScript(HTML_SCRIPT, true) as Promise<string>,
      stoppedPromise,
    ]);
    if (html === STOPPED) return null;
    if (!html) return null;
    log.info('rendered page', {
      text_chars: lastSample?.textChars ?? 0,
      html_chars: html.length,
    });
    return {
      html: html.length > MAX_RENDERED_HTML_CHARS ? html.slice(0, MAX_RENDERED_HTML_CHARS) : html,
      ...(lastSample?.href ? { url: lastSample.href } : {}),
    };
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', stop);
    destroy();
  }
}

/**
 * Render `url` in an offscreen window. Returns null whenever rendering is
 * unavailable, queued too deep, cancelled, or failed — the caller then keeps
 * its direct HTTP failure.
 */
export async function renderWebFetchPage(
  url: string,
  signal?: AbortSignal,
): Promise<WebFetchRenderedPage | null> {
  if (!app.isReady() || signal?.aborted) return null;
  if (queuedRenders >= MAX_QUEUED_RENDERS) {
    log.info('render skipped; queue is full', { queued: queuedRenders });
    return null;
  }

  queuedRenders += 1;
  const task = async (): Promise<WebFetchRenderedPage | null> => {
    try {
      if (signal?.aborted) return null;
      return await renderOnce(url, signal);
    } catch (err) {
      log.warn('render failed', { error: logErrorSummary(err) });
      return null;
    } finally {
      queuedRenders -= 1;
    }
  };
  const run = renderQueue.then(task, task);
  renderQueue = run.then(() => undefined, () => undefined);
  return run;
}
