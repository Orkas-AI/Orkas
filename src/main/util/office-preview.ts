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

function wrapOfficePreviewHtml(kind: OfficePreviewKind, title: string, body: string): string {
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

function estimateOfficePreviewHeight(kind: OfficePreviewKind, fragment: string): number | undefined {
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
