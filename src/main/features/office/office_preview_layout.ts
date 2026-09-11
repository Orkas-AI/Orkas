/**
 * Office layout preview — OfficeCLI-rendered HTML for a document on disk.
 *
 * Owns the engine round trip (temp file, `runOfficeCli view`, hardened HTML,
 * navigation stabilisation), and the
 * small per-file render cache. The pure HTML helpers, kind detection and the
 * content-only fallback stay in `util/office-preview` so `util/` never
 * depends on this feature module.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createLogger } from '../../logger';
import { logErrorSummary } from '../../util/log-redact';
import {
  activePresentationSlideIndex,
  officeBufferToPreviewHtml,
  type OfficePreviewKind,
  type OfficePreviewResult,
} from '../../util/office-preview';
import { closeOfficeFile, officeCliAvailable, runOfficeCli } from './office_engine';

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
