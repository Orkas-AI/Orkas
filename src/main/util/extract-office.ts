import AdmZip from 'adm-zip';

function readZipText(zip: AdmZip, name: string): string {
  const entry = zip.getEntry(name);
  if (!entry) return '';
  return entry.getData().toString('utf8');
}

function decodeXmlText(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function textNodes(xml: string): string[] {
  const out: string[] = [];
  const re = tagBlockRe('t');
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    const text = decodeXmlText(match[1] || '').replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
  }
  return out;
}

function stripTags(xml: string): string {
  return decodeXmlText(xml.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tagBlockRe(localName: string): RegExp {
  return new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}>`, 'g');
}

function tagOpenRe(localName: string): RegExp {
  return new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b([^>]*)\\/?>`, 'g');
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function attrValue(attrs: string, name: string): string {
  const re = new RegExp(`(?:^|\\s)${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const match = re.exec(attrs);
  return decodeXmlText(match?.[1] ?? match?.[2] ?? '');
}

function tagBlocks(xml: string, localName: string): string[] {
  const out: string[] = [];
  const re = tagBlockRe(localName);
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) out.push(match[0]);
  return out;
}

function firstTagBlock(xml: string, localName: string): string {
  const match = tagBlockRe(localName).exec(xml);
  return match?.[0] || '';
}

function firstTagText(xml: string, localName: string): string {
  const match = tagBlockRe(localName).exec(xml);
  return decodeXmlText(match?.[1] || '').trim();
}

function columnIndex(cellRef: string): number {
  const letters = (cellRef.match(/^[A-Z]+/i)?.[0] || '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n || 9999;
}

function normalizeZipTarget(baseDir: string, target: string): string {
  const raw = decodeXmlText(target || '').replace(/\\/g, '/').trim();
  if (!raw) return '';
  const joined = raw.startsWith('/') ? raw.slice(1) : `${baseDir.replace(/\/+$/g, '')}/${raw}`;
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function sortOfficePaths(a: string, b: string, token: string): number {
  const ai = Number(a.match(new RegExp(`${token}(\\d+)\\.xml$`, 'i'))?.[1] || 0);
  const bi = Number(b.match(new RegExp(`${token}(\\d+)\\.xml$`, 'i'))?.[1] || 0);
  return (ai || Number.MAX_SAFE_INTEGER) - (bi || Number.MAX_SAFE_INTEGER) || a.localeCompare(b);
}

function parseSharedStrings(zip: AdmZip): string[] {
  const xml = readZipText(zip, 'xl/sharedStrings.xml');
  if (!xml) return [];
  const items = tagBlocks(xml, 'si');
  if (!items.length) return textNodes(xml);
  return items.map((item) => {
    const parts = textNodes(item);
    return parts.length ? parts.join('') : stripTags(item);
  });
}

interface SpreadsheetSheetRef {
  name: string;
  path: string;
  number: number;
}

function parseSpreadsheetSheetRefs(zip: AdmZip): SpreadsheetSheetRef[] {
  const workbook = readZipText(zip, 'xl/workbook.xml');
  const rels = readZipText(zip, 'xl/_rels/workbook.xml.rels');
  if (!workbook) return [];

  const relTargets = new Map<string, string>();
  if (rels) {
    const relRe = tagOpenRe('Relationship');
    let relMatch: RegExpExecArray | null;
    while ((relMatch = relRe.exec(rels))) {
      const attrs = relMatch[1] || '';
      const id = attrValue(attrs, 'Id');
      const target = attrValue(attrs, 'Target');
      if (id && target) relTargets.set(id, normalizeZipTarget('xl', target));
    }
  }

  const refs: SpreadsheetSheetRef[] = [];
  const sheetRe = tagOpenRe('sheet');
  let sheetMatch: RegExpExecArray | null;
  let seq = 1;
  while ((sheetMatch = sheetRe.exec(workbook))) {
    const attrs = sheetMatch[1] || '';
    const rid = attrValue(attrs, 'r:id') || attrValue(attrs, 'id');
    const sheetId = Number(attrValue(attrs, 'sheetId') || seq);
    const target = rid ? relTargets.get(rid) : '';
    const fallbackPath = sheetId ? `xl/worksheets/sheet${sheetId}.xml` : '';
    const sheetPath = target || fallbackPath;
    if (sheetPath) {
      refs.push({
        name: attrValue(attrs, 'name') || `Sheet ${seq}`,
        path: sheetPath,
        number: sheetId || seq,
      });
    }
    seq++;
  }
  return refs.filter((ref) => !!zip.getEntry(ref.path));
}

function fallbackSpreadsheetSheetRefs(zip: AdmZip): SpreadsheetSheetRef[] {
  return zip.getEntries()
    .map((entry) => entry.entryName)
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name))
    .sort((a, b) => sortOfficePaths(a, b, 'sheet'))
    .map((sheetPath, index) => {
      const sheetNumber = Number(sheetPath.match(/sheet(\d+)\.xml$/i)?.[1] || index + 1);
      return { name: `Sheet ${sheetNumber}`, path: sheetPath, number: sheetNumber };
    });
}

function cellValue(cellXml: string, sharedStrings: string[]): string {
  const type = cellXml.match(/\bt="([^"]+)"/)?.[1] || '';
  const inline = firstTagBlock(cellXml, 'is');
  if (inline) return textNodes(inline).join('');
  const value = firstTagText(cellXml, 'v');
  if (!value) return '';
  if (type === 's') return sharedStrings[Number(value)] || '';
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  return value;
}

function escapeHtml(raw: string): string {
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface SpreadsheetSheet {
  name: string;
  rows: string[][];
}

function parseSpreadsheetSheets(buf: Buffer): SpreadsheetSheet[] {
  if (!buf?.length) throw new Error('empty or invalid spreadsheet');
  const zip = new AdmZip(buf);
  const sharedStrings = parseSharedStrings(zip);
  const sheetRefs = parseSpreadsheetSheetRefs(zip);
  const sheets = sheetRefs.length ? sheetRefs : fallbackSpreadsheetSheetRefs(zip);

  if (!sheets.length) throw new Error('spreadsheet contains no worksheets');

  return sheets.map((sheet) => {
    const xml = readZipText(zip, sheet.path);
    const rowXmls = tagBlocks(xml, 'row');
    const rows = rowXmls.map((rowXml) => {
      const row: string[] = [];
      let nextCol = 1;
      for (const cell of tagBlocks(rowXml, 'c')
        .map((cellXml) => ({
          ref: cellXml.match(/\br="([^"]+)"/)?.[1] || '',
          value: cellValue(cellXml, sharedStrings),
        }))
        .sort((a, b) => columnIndex(a.ref) - columnIndex(b.ref))) {
        const col = cell.ref ? columnIndex(cell.ref) : nextCol;
        nextCol = col + 1;
        if (cell.value.trim()) row[Math.max(0, col - 1)] = cell.value;
      }
      return row;
    });
    return { name: sheet.name, rows: rows.filter((row) => row.some((cell) => String(cell || '').trim())) };
  });
}

interface PresentationSlide {
  number: number;
  texts: string[];
}

function parsePresentationSlides(buf: Buffer): PresentationSlide[] {
  if (!buf?.length) throw new Error('empty or invalid presentation');
  const zip = new AdmZip(buf);
  const slideEntries = parsePresentationSlideRefs(zip);

  if (!slideEntries.length) throw new Error('presentation contains no slides');

  return slideEntries.map((slide) => ({
    number: slide.number,
    texts: textNodes(readZipText(zip, slide.path)),
  }));
}

function parsePresentationSlideRefs(zip: AdmZip): Array<{ path: string; number: number }> {
  const presentation = readZipText(zip, 'ppt/presentation.xml');
  const rels = readZipText(zip, 'ppt/_rels/presentation.xml.rels');
  const relTargets = new Map<string, string>();
  if (rels) {
    const relRe = tagOpenRe('Relationship');
    let relMatch: RegExpExecArray | null;
    while ((relMatch = relRe.exec(rels))) {
      const attrs = relMatch[1] || '';
      const id = attrValue(attrs, 'Id');
      const target = attrValue(attrs, 'Target');
      if (id && target) relTargets.set(id, normalizeZipTarget('ppt', target));
    }
  }

  const ordered: Array<{ path: string; number: number }> = [];
  if (presentation && relTargets.size) {
    const slideRe = tagOpenRe('sldId');
    let slideMatch: RegExpExecArray | null;
    while ((slideMatch = slideRe.exec(presentation))) {
      const attrs = slideMatch[1] || '';
      const rid = attrValue(attrs, 'r:id') || attrValue(attrs, 'id');
      const target = rid ? relTargets.get(rid) : '';
      if (target && /^ppt\/slides\/[^/]+\.xml$/i.test(target) && zip.getEntry(target)) {
        ordered.push({ path: target, number: ordered.length + 1 });
      }
    }
  }
  if (ordered.length) return ordered;

  return zip.getEntries()
    .map((entry) => entry.entryName)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => sortOfficePaths(a, b, 'slide'))
    .map((path, index) => ({ path, number: index + 1 }));
}

export function xlsxBufferToMarkdown(buf: Buffer): string {
  const sheets = parseSpreadsheetSheets(buf);
  const sections: string[] = ['# Spreadsheet'];
  for (const sheet of sheets) {
    sections.push(`\n## ${sheet.name}`);
    for (let i = 0; i < sheet.rows.length; i++) {
      const row = sheet.rows[i];
      if (row.length) {
        sections.push(`Row ${i + 1}: ${row.join('\t')}`);
      }
    }
  }
  return `${sections.join('\n').trim()}\n`;
}

export function xlsxBufferToHtml(buf: Buffer): string {
  const sheets = parseSpreadsheetSheets(buf);
  return sheets.map((sheet) => {
    const maxCols = Math.max(0, ...sheet.rows.map((row) => row.length));
    const rows = sheet.rows.map((row) => (
      `<tr>${Array.from({ length: maxCols }, (_unused, i) => `<td>${escapeHtml(row[i] || '')}</td>`).join('')}</tr>`
    )).join('');
    return [
      '<section class="office-sheet">',
      `<h2>${escapeHtml(sheet.name)}</h2>`,
      '<div class="office-table-wrap">',
      `<table><tbody>${rows}</tbody></table>`,
      '</div>',
      '</section>',
    ].join('');
  }).join('');
}

export function pptxBufferToMarkdown(buf: Buffer): string {
  const slides = parsePresentationSlides(buf);
  const sections: string[] = ['# Presentation'];
  for (const slide of slides) {
    sections.push(`\n## Slide ${slide.number}`);
    sections.push(slide.texts.length ? slide.texts.map((line) => `- ${line}`).join('\n') : '(no text)');
  }
  return `${sections.join('\n').trim()}\n`;
}

export function pptxBufferToHtml(buf: Buffer): string {
  const slides = parsePresentationSlides(buf);
  return slides.map((slide) => {
    const lines = slide.texts.map((line) => `<p>${escapeHtml(line)}</p>`).join('');
    return [
      `<section class="office-slide" aria-label="Slide ${slide.number}">`,
      '<div class="office-slide-body">',
      lines,
      '</div>',
      '</section>',
    ].join('');
  }).join('');
}
