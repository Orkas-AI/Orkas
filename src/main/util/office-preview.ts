import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeOfficeFile, officeCliAvailable, runOfficeCli } from '../features/office/office_engine';
import { createLogger } from '../logger';
import { logErrorSummary } from './log-redact';
import { docxBufferToHtml } from './extract-docx';
import { pptxBufferToHtml, xlsxBufferToHtml } from './extract-office';

export type OfficePreviewKind = 'word' | 'spreadsheet' | 'presentation';

export type OfficePreviewResult = {
  html: string;
  kind: OfficePreviewKind;
  previewHeight?: number;
  /** True only for an OfficeCLI layout render. The renderer may enable the
   *  sandboxed inline navigation/scaling script for this hardened output. */
  allowScripts?: boolean;
  /** Lets callers and tests distinguish a faithful Office layout render from the
   *  lightweight content fallback used when the bundled engine is unavailable. */
  layoutRendered?: boolean;
};

const log = createLogger('office-preview');
const OFFICE_LAYOUT_PREVIEW_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const OFFICE_LAYOUT_PREVIEW_CACHE_MAX_ENTRIES = 4;
const officeLayoutPreviewCache = new Map<string, {
  fingerprint: string;
  result: OfficePreviewResult;
  bytes: number;
}>();
const officeLayoutPreviewInflight = new Map<string, Promise<OfficePreviewResult>>();
let officeLayoutPreviewCacheBytes = 0;

function escapePreviewHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function officePreviewKindForExt(ext: string): OfficePreviewKind | null {
  const e = String(ext || '').toLowerCase();
  if (e === '.docx' || e === '.docm') return 'word';
  if (e === '.xlsx' || e === '.xlsm') return 'spreadsheet';
  if (e === '.pptx' || e === '.pptm') return 'presentation';
  return null;
}

export function wrapOfficePreviewHtml(kind: OfficePreviewKind, title: string, body: string): string {
  const safeTitle = escapePreviewHtml(title || 'Office preview');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #eef2f7;
      color: #0f172a;
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .office-preview {
      width: 100%;
      min-height: 100vh;
      margin: 0 auto;
      padding: 24px;
    }
    .office-word {
      max-width: 820px;
      background: #fff;
      min-height: calc(100vh - 48px);
      margin: 20px auto 32px;
      padding: 56px 64px;
      border: 1px solid #e5e7eb;
      box-shadow: 0 1px 8px rgba(15, 23, 42, 0.06);
    }
    .office-spreadsheet {
      max-width: none;
      padding: 12px;
      min-height: 0;
    }
    .office-word h1, .office-word h2, .office-word h3 {
      line-height: 1.3;
      color: #111827;
    }
    .office-word h1 {
      margin: 0 0 22px;
      font-size: 28px;
      font-weight: 700;
    }
    .office-word h2 {
      margin: 26px 0 12px;
      font-size: 21px;
      font-weight: 650;
    }
    .office-word h3 {
      margin: 22px 0 10px;
      font-size: 17px;
      font-weight: 650;
    }
    .office-word p,
    .office-word li {
      margin: 0 0 13px;
      font-size: 15px;
      line-height: 1.72;
      color: #111827;
    }
    .office-word ul,
    .office-word ol {
      margin: 0 0 16px 24px;
      padding: 0;
    }
    .office-word table {
      border-collapse: collapse;
      width: 100%;
      margin: 16px 0;
    }
    .office-word th, .office-word td,
    .office-table-wrap th, .office-table-wrap td {
      border: 1px solid #cbd5e1;
      padding: 7px 9px;
      vertical-align: top;
    }
    .office-sheet {
      margin: 0 0 12px;
      padding: 16px 16px 10px;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
    }
    .office-sheet:last-child {
      margin-bottom: 0;
    }
    .office-sheet h2 {
      margin: 0 0 12px;
      font-size: 15px;
    }
    .office-table-wrap {
      overflow: auto;
      max-height: 560px;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
    }
    .office-table-wrap table {
      border-collapse: collapse;
      min-width: 100%;
      background: #fff;
      font-size: 13px;
    }
    .office-table-wrap td {
      min-width: 96px;
      white-space: pre-wrap;
    }
    .office-empty-cell, .office-muted { color: #64748b; }
    .office-presentation {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 24px;
      padding: 24px;
    }
    .office-slide {
      width: min(1120px, calc(100vw - 64px));
      aspect-ratio: 16 / 9;
      margin: 0 auto;
      padding: clamp(32px, 5vw, 64px);
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
      display: flex;
      align-items: center;
    }
    .office-slide-body p {
      margin: 0 0 18px;
      font-size: clamp(18px, 2vw, 30px);
      line-height: 1.35;
    }
    .office-slide-body p:first-child {
      font-size: clamp(26px, 3vw, 44px);
      font-weight: 600;
      line-height: 1.2;
    }
    @media (max-width: 720px) {
      .office-preview { padding: 12px; }
      .office-word {
        margin: 0 auto;
        min-height: calc(100vh - 24px);
        padding: 32px 24px;
      }
      .office-word h1 { font-size: 24px; }
      .office-word p,
      .office-word li { font-size: 14px; }
      .office-presentation { padding: 12px; gap: 14px; }
      .office-slide {
        width: calc(100vw - 24px);
        padding: 24px;
      }
      .office-slide-body p { font-size: 16px; }
      .office-slide-body p:first-child { font-size: 22px; }
    }
  </style>
</head>
<body>
  <main class="office-preview office-${kind}">
    ${body}
  </main>
</body>
</html>`;
}

export function estimateOfficePreviewHeight(kind: OfficePreviewKind, fragment: string): number | undefined {
  if (kind !== 'spreadsheet') return undefined;
  const sectionRe = /<section class="office-sheet">[\s\S]*?<\/section>/g;
  const sections = fragment.match(sectionRe) || [];
  const sheetFragments = sections.length ? sections : [fragment];
  const tableMaxHeight = 560;
  const mainPadding = 24;
  const sheetChrome = 66;
  const sheetGap = 12;
  const rowHeight = 35;
  const sheetHeights = sheetFragments.reduce((total, sheet) => {
    const rows = Math.max(1, (sheet.match(/<tr>/g) || []).length);
    return total + sheetChrome + Math.min(tableMaxHeight, rows * rowHeight);
  }, 0);
  return mainPadding + sheetHeights + Math.max(0, sheetFragments.length - 1) * sheetGap;
}

export async function officeBufferToPreviewHtml(
  kind: OfficePreviewKind,
  title: string,
  buf: Buffer,
): Promise<OfficePreviewResult> {
  let fragment = '';
  if (kind === 'word') {
    fragment = await docxBufferToHtml(buf);
  } else if (kind === 'spreadsheet') {
    fragment = xlsxBufferToHtml(buf);
  } else {
    fragment = pptxBufferToHtml(buf);
  }
  const previewHeight = estimateOfficePreviewHeight(kind, fragment);
  return {
    html: wrapOfficePreviewHtml(kind, title, fragment),
    kind,
    ...(previewHeight ? { previewHeight } : {}),
  };
}

function officeLayoutPreviewFingerprint(stat: fs.Stats): string {
  return `${stat.size}:${stat.mtimeMs}`;
}

function cacheOfficeLayoutPreview(
  file: string,
  fingerprint: string,
  result: OfficePreviewResult,
): void {
  const bytes = Buffer.byteLength(result.html, 'utf8');
  if (bytes > OFFICE_LAYOUT_PREVIEW_CACHE_MAX_BYTES) return;
  const prior = officeLayoutPreviewCache.get(file);
  if (prior) officeLayoutPreviewCacheBytes -= prior.bytes;
  officeLayoutPreviewCache.delete(file);
  officeLayoutPreviewCache.set(file, { fingerprint, result, bytes });
  officeLayoutPreviewCacheBytes += bytes;
  while (
    officeLayoutPreviewCache.size > OFFICE_LAYOUT_PREVIEW_CACHE_MAX_ENTRIES
    || officeLayoutPreviewCacheBytes > OFFICE_LAYOUT_PREVIEW_CACHE_MAX_BYTES
  ) {
    const oldestKey = officeLayoutPreviewCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = officeLayoutPreviewCache.get(oldestKey);
    officeLayoutPreviewCache.delete(oldestKey);
    officeLayoutPreviewCacheBytes -= oldest?.bytes || 0;
  }
}

export type PresentationSlideBounds = {
  top: number;
  bottom: number;
};

/** Pick one stable slide for the presentation rail. OfficeCLI's stock preview
 * marks every slide whose intersection ratio exceeds 30%, so the callback's
 * entry order can select slide 2 at scroll position 0 or skip slide 2 while a
 * three-slide deck is moving. The viewport center is deterministic when more
 * than one slide is visible; the explicit start rule preserves slide 1 on open. */
export function activePresentationSlideIndex(
  viewportTop: number,
  viewportBottom: number,
  slideBounds: readonly PresentationSlideBounds[],
  atScrollStart = false,
): number {
  if (!slideBounds.length) return -1;
  if (atScrollStart) return 0;
  if (!Number.isFinite(viewportTop) || !Number.isFinite(viewportBottom) || viewportBottom <= viewportTop) {
    return -1;
  }

  const viewportCenter = (viewportTop + viewportBottom) / 2;
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestVisible = -1;
  for (let index = 0; index < slideBounds.length; index += 1) {
    const top = Number(slideBounds[index]?.top);
    const bottom = Number(slideBounds[index]?.bottom);
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) continue;
    const visible = Math.min(bottom, viewportBottom) - Math.max(top, viewportTop);
    if (visible <= 0) continue;
    const distance = Math.abs(((top + bottom) / 2) - viewportCenter);
    if (distance < bestDistance || (distance === bestDistance && visible > bestVisible)) {
      bestIndex = index;
      bestDistance = distance;
      bestVisible = visible;
    }
  }
  return bestIndex;
}

const PRESENTATION_NAVIGATION_INSERTION_POINT = '    // ===== Fullscreen mode =====';
const PRESENTATION_NAVIGATION_MARKER = 'orkas-presentation-navigation:v1';

function stabilizeRenderedPresentationNavigation(source: string): string {
  if (source.includes(PRESENTATION_NAVIGATION_MARKER)) return source;
  if (!source.includes(PRESENTATION_NAVIGATION_INSERTION_POINT)) return source;
  const chooseSlideSource = activePresentationSlideIndex.toString();
  const patch = `
    // ${PRESENTATION_NAVIGATION_MARKER}
    // Replace OfficeCLI's order-dependent 30% observer with one stable active
    // slide derived from the presentation viewport. This remains inside the
    // renderer's closure so keyboard and fullscreen navigation share the same
    // currentSlide state as the thumbnail rail.
    const orkasActivePresentationSlideIndex = ${chooseSlideSource};
    let orkasPresentationNavigationFrame = 0;
    function syncOrkasPresentationNavigation() {
        orkasPresentationNavigationFrame = 0;
        if (!main || isFullscreen) return;
        const viewport = main.getBoundingClientRect();
        const bounds = getContainers().map(container => container.getBoundingClientRect());
        const idx = orkasActivePresentationSlideIndex(
            viewport.top,
            viewport.bottom,
            bounds,
            main.scrollTop <= 1
        );
        if (idx >= 0) setActiveThumb(idx);
    }
    function scheduleOrkasPresentationNavigation() {
        if (orkasPresentationNavigationFrame) {
            cancelAnimationFrame(orkasPresentationNavigationFrame);
        }
        orkasPresentationNavigationFrame = requestAnimationFrame(syncOrkasPresentationNavigation);
    }
    if (main) {
        if (scrollObserver) scrollObserver.disconnect();
        scrollObserver = new IntersectionObserver(scheduleOrkasPresentationNavigation, {
            root: main,
            threshold: [0, 0.25, 0.5, 0.75, 1]
        });
        getContainers().forEach(container => scrollObserver.observe(container));
        main.addEventListener('scroll', scheduleOrkasPresentationNavigation, { passive: true });
        window.addEventListener('resize', scheduleOrkasPresentationNavigation);
        setActiveThumb(0);
        // Let any already-queued callback from the replaced observer drain,
        // then reassert the deterministic initial state on the next frame.
        requestAnimationFrame(() => {
            setActiveThumb(0);
            requestAnimationFrame(scheduleOrkasPresentationNavigation);
        });
    }

`;
  return source.replace(
    PRESENTATION_NAVIGATION_INSERTION_POINT,
    `${patch}${PRESENTATION_NAVIGATION_INSERTION_POINT}`,
  );
}

function hardenRenderedOfficeHtml(source: string, kind: OfficePreviewKind): string {
  const csp = [
    "default-src 'none'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "style-src 'unsafe-inline' data:",
    "script-src 'unsafe-inline'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const presentationSafeSource = kind === 'presentation'
    ? stabilizeRenderedPresentationNavigation(source)
    : source;
  const withoutBase = presentationSafeSource
    .replace(/<base\b[^>]*>/gi, '')
    .replace(
      /\b(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi,
      (_match, attribute: string, quote: string) => `${attribute}=${quote}#${quote}`,
    );
  if (/<head\b[^>]*>/i.test(withoutBase)) {
    return withoutBase.replace(/<head\b[^>]*>/i, (head) => `${head}\n${meta}`);
  }
  return `<!doctype html><html><head>${meta}</head><body>${withoutBase}</body></html>`;
}

function engineExtensionForKind(kind: OfficePreviewKind): '.docx' | '.xlsx' | '.pptx' {
  if (kind === 'word') return '.docx';
  if (kind === 'spreadsheet') return '.xlsx';
  return '.pptx';
}

function renderedOfficeMarker(kind: OfficePreviewKind): RegExp {
  if (kind === 'word') return /<div\b[^>]*class=["'][^"']*\bpage\b/i;
  if (kind === 'spreadsheet') return /<div\b[^>]*class=["'][^"']*\bsheet-content\b/i;
  return /<div\b[^>]*class=["'][^"']*\bslide\b/i;
}

function safeOfficePreviewSourceName(title: string, kind: OfficePreviewKind): string {
  const rawStem = path.basename(String(title || ''), path.extname(String(title || '')));
  const cleaned = rawStem
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .trim()
    .replace(/[ .]+$/g, '')
    .slice(0, 96);
  const stem = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)
    ? `_${cleaned}`
    : (cleaned || 'preview');
  return `${stem}${engineExtensionForKind(kind)}`;
}

async function renderOfficeFileToHtml(
  kind: OfficePreviewKind,
  title: string,
  sourceFile: string,
  fallbackBuffer: Buffer,
): Promise<OfficePreviewResult> {
  if (!officeCliAvailable()) {
    return officeBufferToPreviewHtml(kind, title, fallbackBuffer);
  }

  let tempDir = '';
  let workFile = '';
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-office-preview-'));
    workFile = path.join(tempDir, safeOfficePreviewSourceName(title, kind));
    const output = path.join(tempDir, 'preview.html');
    fs.writeFileSync(workFile, fallbackBuffer);
    const rendered = await runOfficeCli(['view', workFile, 'html', '-o', output], {
      cwd: tempDir,
      timeoutMs: 60_000,
    });
    if (rendered.code !== 0 || !fs.existsSync(output)) {
      throw new Error(rendered.stderr || rendered.stdout || `OfficeCLI exited ${rendered.code}`);
    }
    const html = fs.readFileSync(output, 'utf8');
    if (!renderedOfficeMarker(kind).test(html)) {
      throw new Error(`OfficeCLI ${kind} preview did not contain rendered layout content`);
    }
    return {
      html: hardenRenderedOfficeHtml(html, kind),
      kind,
      allowScripts: true,
      layoutRendered: true,
    };
  } catch (err) {
    log.warn('Office layout preview failed; using content fallback', {
      kind,
      source_extension: path.extname(sourceFile).toLowerCase(),
      error: logErrorSummary(err),
    });
    return officeBufferToPreviewHtml(kind, title, fallbackBuffer);
  } finally {
    if (workFile && tempDir) await closeOfficeFile(workFile, tempDir);
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

/** Build a preview from a real Office file. Word, spreadsheet and presentation
 * files use OfficeCLI's layout renderer so page geometry, cell styles,
 * backgrounds, pictures, shapes and typography survive. Macro-enabled files
 * are rendered from a temporary standard-extension copy; the source is never
 * modified. The lightweight extractor remains the explicit failure fallback. */
export async function officeFileToPreviewHtml(
  kind: OfficePreviewKind,
  title: string,
  file: string,
  knownBuffer?: Buffer,
): Promise<OfficePreviewResult> {
  const resolved = path.resolve(file);
  const buf = knownBuffer || fs.readFileSync(resolved);

  let stat: fs.Stats;
  try { stat = fs.statSync(resolved); }
  catch { return officeBufferToPreviewHtml(kind, title, buf); }
  const fingerprint = officeLayoutPreviewFingerprint(stat);
  const cached = officeLayoutPreviewCache.get(resolved);
  if (cached?.fingerprint === fingerprint) {
    officeLayoutPreviewCache.delete(resolved);
    officeLayoutPreviewCache.set(resolved, cached);
    return cached.result;
  }
  if (cached) {
    officeLayoutPreviewCache.delete(resolved);
    officeLayoutPreviewCacheBytes -= cached.bytes;
  }

  const inflightKey = `${resolved}\0${fingerprint}`;
  const existing = officeLayoutPreviewInflight.get(inflightKey);
  if (existing) return existing;
  const pending = renderOfficeFileToHtml(kind, title, resolved, buf)
    .then((result) => {
      if (result.layoutRendered) cacheOfficeLayoutPreview(resolved, fingerprint, result);
      return result;
    })
    .finally(() => officeLayoutPreviewInflight.delete(inflightKey));
  officeLayoutPreviewInflight.set(inflightKey, pending);
  return pending;
}
