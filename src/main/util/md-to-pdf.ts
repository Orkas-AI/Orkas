/**
 * Built-in Markdown → PDF channel, zero external dependencies.
 *
 * Two-stage pipeline:
 *   1. `markdownToHtml(md, opts)` — pure string transform. Unit-testable
 *      without Electron / node-canvas / headless browsers. Supports the
 *      common subset: headings h1-h6, paragraphs, bold / italic, inline
 *      code, fenced code blocks, unordered lists (-, *), ordered lists
 *      (1.), horizontal rules, links, hard line breaks. Not supported:
 *      tables, blockquotes, nested lists. If a document needs more, the
 *      agent should call `htmlToPdf` directly with hand-written HTML.
 *   2. `htmlToPdf(html, outputPath, opts)` — loads the HTML into an
 *      offscreen, sandboxed BrowserWindow and calls `webContents.printToPDF`.
 *      Electron is imported dynamically so the module can be loaded in
 *      vitest with `vi.mock('electron', ...)`.
 *
 * Security:
 *   - All user-provided markdown text is HTML-escaped before any inline
 *     transform runs.
 *   - Only http / https / mailto / tel URLs are rendered as `<a>` links.
 *     Anything else (javascript:, data:, file:, etc.) falls back to the
 *     escaped literal — no clickable vector for LLM-injected content.
 *   - The BrowserWindow used for rendering is sandboxed, contextIsolated,
 *     has no preload, and only loads a single `data:` URL before printing.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hardenedWebPreferences } from './window-security';

// ── Markdown → HTML ──────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Allowed URL schemes for link rendering. Anything else => escape as text.
const SAFE_URL = /^(https?:\/\/|mailto:|tel:)[^\s<>"']+$/i;
const RELATIVE_URL = /^[a-zA-Z0-9._/#?=&%-]+$/;

function renderInline(text: string): string {
  // Order matters: links first (so their text isn't touched by bold/italic),
  // then inline code, then bold, then italic.
  let out = escapeHtml(text);

  // Links: [text](url) — text is already HTML-escaped above; url we revalidate.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, rawUrl: string) => {
    const url = rawUrl.trim();
    // The url went through escapeHtml already; restore `&amp;` to `&` for
    // scheme validation, then re-escape as an attribute value.
    const unescaped = url.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    if (SAFE_URL.test(unescaped) || RELATIVE_URL.test(unescaped)) {
      return `<a href="${url}">${label}</a>`;
    }
    return `[${label}](${url})`;
  });

  // Inline code: `code` — no further processing inside.
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<code>${code}</code>`);

  // Bold: **text** — must come before italic so ** doesn't become nested <em>.
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic: *text*
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return out;
}

export interface MarkdownToHtmlOpts {
  title?: string;
}

/**
 * Transform a markdown document into a standalone HTML document ready for
 * `printToPDF`. Includes a built-in print stylesheet.
 */
export function markdownToHtml(md: string, opts: MarkdownToHtmlOpts = {}): string {
  const body = renderBody(md);
  const title = escapeHtml(opts.title ?? 'Document');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    `<style>${PRINT_CSS}</style>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>',
  ].join('\n');
}

function renderBody(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;

  // Active list context — flushed when a non-list line appears.
  let listType: 'ul' | 'ol' | null = null;
  const listItems: string[] = [];
  const flushList = () => {
    if (!listType) return;
    const tag = listType;
    out.push(`<${tag}>`);
    for (const it of listItems) out.push(`<li>${it}</li>`);
    out.push(`</${tag}>`);
    listType = null;
    listItems.length = 0;
  };

  // Paragraph buffer — flushed on blank line or block boundary.
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    out.push(`<p>${para.map(renderInline).join('<br>')}</p>`);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ``` or ```lang
    const fenceMatch = line.match(/^```(\w+)?\s*$/);
    if (fenceMatch) {
      flushPara();
      flushList();
      const lang = fenceMatch[1] || '';
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      // Skip the closing fence if present; if EOF reached, we just emit what we have.
      if (i < lines.length) i += 1;
      const langAttr = lang ? ` class="lang-${escapeHtml(lang)}"` : '';
      out.push(`<pre><code${langAttr}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // Blank line → paragraph/list boundary
    if (/^\s*$/.test(line)) {
      flushPara();
      flushList();
      i += 1;
      continue;
    }

    // Horizontal rule: ---, ***, or ___ on its own line (3+ chars)
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push('<hr>');
      i += 1;
      continue;
    }

    // Heading: # through ######
    const headMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headMatch) {
      flushPara();
      flushList();
      const level = headMatch[1].length;
      out.push(`<h${level}>${renderInline(headMatch[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // Unordered list: - item  or  * item
    const ulMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (ulMatch) {
      flushPara();
      if (listType !== 'ul') { flushList(); listType = 'ul'; }
      listItems.push(renderInline(ulMatch[1]));
      i += 1;
      continue;
    }

    // Ordered list: 1. item
    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (olMatch) {
      flushPara();
      if (listType !== 'ol') { flushList(); listType = 'ol'; }
      listItems.push(renderInline(olMatch[1]));
      i += 1;
      continue;
    }

    // Plain paragraph line — accumulate. Lists break on non-list lines.
    flushList();
    para.push(line);
    i += 1;
  }

  flushPara();
  flushList();
  return out.join('\n');
}

const PRINT_CSS = `
  @page { size: A4; margin: 2cm; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif;
    line-height: 1.55;
    color: #222;
    font-size: 12pt;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 0.5em; page-break-after: avoid; }
  h1 { font-size: 1.9em; border-bottom: 1px solid #ddd; padding-bottom: 0.25em; }
  h2 { font-size: 1.5em; }
  h3 { font-size: 1.25em; }
  p  { margin: 0.6em 0; }
  a  { color: #0366d6; text-decoration: underline; }
  code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 0.92em; background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px; }
  pre { background: #f6f8fa; padding: 0.9em 1em; border-radius: 5px; overflow-x: auto; page-break-inside: avoid; }
  pre code { background: transparent; padding: 0; }
  ul, ol { padding-left: 1.6em; }
  li { margin: 0.15em 0; }
  hr { border: none; border-top: 1px solid #ccc; margin: 1.5em 0; }
  strong { font-weight: 600; }
`;

// Chromium can economize print colors even when backgrounds are enabled.
// Preserve dark code blocks and other authored color pairs in generated PDFs.
const PDF_PRINT_COLOR_CSS = `
  @media print {
    html, body, body * {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color-adjust: exact !important;
    }
  }
`;

// ── HTML → PDF (Electron-backed) ─────────────────────────────────────────

export interface HtmlToPdfOpts {
  pageSize?: 'A4' | 'A3' | 'Letter' | 'Legal' | 'Tabloid';
  landscape?: boolean;
  footerText?: string;
}

/**
 * Render `html` to a PDF file at `outputPath`. Returns the absolute output
 * path on success. Requires Electron's main process — will throw if called
 * from a context without it.
 */
export async function htmlToPdf(
  html: string,
  outputPath: string,
  opts: HtmlToPdfOpts = {},
): Promise<string> {
  const electron = await import('electron');
  const BrowserWindow = (electron as unknown as { BrowserWindow: any }).BrowserWindow;
  if (!BrowserWindow) {
    throw new Error('Electron BrowserWindow unavailable (must run in main process)');
  }

  const win = new BrowserWindow({
    show: false,
    webPreferences: hardenedWebPreferences(),
  });

  try {
    const printableHtml = opts.footerText ? injectPrintFooter(html, opts.footerText) : html;
    const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(printableHtml, 'utf8').toString('base64')}`;
    const loaded = new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve());
      win.webContents.once('did-fail-load', (_e: unknown, _code: number, desc: string) =>
        reject(new Error(`did-fail-load: ${desc}`)),
      );
    });
    await win.loadURL(dataUrl);
    await loaded;
    await win.webContents.insertCSS(PDF_PRINT_COLOR_CSS, { cssOrigin: 'user' });

    const pdfBuffer: Buffer = await win.webContents.printToPDF({
      pageSize: opts.pageSize ?? 'A4',
      landscape: opts.landscape === true,
      printBackground: true,
    });

    const absOut = path.resolve(outputPath);
    await fs.mkdir(path.dirname(absOut), { recursive: true });
    await fs.writeFile(absOut, pdfBuffer);
    return absOut;
  } finally {
    try { win.destroy(); } catch { /* best effort */ }
  }
}

/** Convenience wrapper: markdown → HTML → PDF. */
export async function markdownToPdf(
  md: string,
  outputPath: string,
  opts: HtmlToPdfOpts & MarkdownToHtmlOpts = {},
): Promise<string> {
  const html = markdownToHtml(md, { ...(opts.title ? { title: opts.title } : {}) });
  return htmlToPdf(html, outputPath, opts);
}

function injectPrintFooter(html: string, footerText: string): string {
  const label = escapeHtml(String(footerText || '').trim());
  if (!label) return html;
  const block = [
    '<style data-generated-output-footer="1">',
    '@media print {',
    '  body { padding-bottom: 18mm !important; }',
    '  .generated-output-footer {',
    '    position: fixed;',
    '    left: 0;',
    '    right: 0;',
    '    bottom: 0;',
    '    font-size: 8pt;',
    '    line-height: 1.2;',
    '    color: rgba(0,0,0,0.48);',
    '    text-align: center;',
    '    pointer-events: none;',
    '  }',
    '}',
    '</style>',
    `<div class="generated-output-footer">${label}</div>`,
  ].join('\n');
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${block}\n</body>`);
  }
  return `${html}\n${block}`;
}
