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
  const re = /<[^:>]*:?t\b[^>]*>([\s\S]*?)<\/[^:>]*:?t>/g;
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

function columnIndex(cellRef: string): number {
  const letters = (cellRef.match(/^[A-Z]+/i)?.[0] || '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n || 9999;
}

function parseSharedStrings(zip: AdmZip): string[] {
  const xml = readZipText(zip, 'xl/sharedStrings.xml');
  if (!xml) return [];
  const items = xml.match(/<si\b[\s\S]*?<\/si>/g) || [];
  if (!items.length) return textNodes(xml);
  return items.map((item) => {
    const parts = textNodes(item);
    return parts.length ? parts.join('') : stripTags(item);
  });
}

function parseSheetNames(zip: AdmZip): string[] {
  const workbook = readZipText(zip, 'xl/workbook.xml');
  const rels = readZipText(zip, 'xl/_rels/workbook.xml.rels');
  if (!workbook) return [];

  const relNames = new Map<string, string>();
  if (rels) {
    const relRe = /<Relationship\b([^>]*)\/?>/g;
    let relMatch: RegExpExecArray | null;
    while ((relMatch = relRe.exec(rels))) {
      const attrs = relMatch[1] || '';
      const id = attrs.match(/\bId="([^"]+)"/)?.[1];
      const target = attrs.match(/\bTarget="([^"]+)"/)?.[1];
      if (id && target) relNames.set(id, target.replace(/^\/?xl\//, ''));
    }
  }

  const names: string[] = [];
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let sheetMatch: RegExpExecArray | null;
  while ((sheetMatch = sheetRe.exec(workbook))) {
    const attrs = sheetMatch[1] || '';
    const displayName = decodeXmlText(attrs.match(/\bname="([^"]*)"/)?.[1] || '');
    const rid = attrs.match(/\br:id="([^"]*)"/)?.[1];
    if (rid) {
      const target = relNames.get(rid);
      const idx = target?.match(/worksheets\/sheet(\d+)\.xml$/)?.[1];
      if (idx) names[Number(idx) - 1] = displayName || `Sheet ${idx}`;
    } else {
      names.push(displayName || `Sheet ${names.length + 1}`);
    }
  }
  return names;
}

function cellValue(cellXml: string, sharedStrings: string[]): string {
  const type = cellXml.match(/\bt="([^"]+)"/)?.[1] || '';
  const inline = cellXml.match(/<is\b[\s\S]*?<\/is>/)?.[0];
  if (inline) return textNodes(inline).join('');
  const value = decodeXmlText(cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1] || '').trim();
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
  const sheetNames = parseSheetNames(zip);
  const sheetEntries = zip.getEntries()
    .map((entry) => entry.entryName)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/sheet(\d+)\.xml/i)?.[1] || 0) - Number(b.match(/sheet(\d+)\.xml/i)?.[1] || 0));

  if (!sheetEntries.length) throw new Error('spreadsheet contains no worksheets');

  return sheetEntries.map((sheetPath, index) => {
    const sheetNumber = Number(sheetPath.match(/sheet(\d+)\.xml/i)?.[1] || index + 1);
    const sheetName = sheetNames[sheetNumber - 1] || `Sheet ${sheetNumber}`;
    const xml = readZipText(zip, sheetPath);
    const rowXmls = xml.match(/<row\b[\s\S]*?<\/row>/g) || [];
    const rows = rowXmls.map((rowXml) => (rowXml.match(/<c\b[\s\S]*?<\/c>/g) || [])
        .map((cellXml) => ({
          ref: cellXml.match(/\br="([^"]+)"/)?.[1] || '',
          value: cellValue(cellXml, sharedStrings),
        }))
        .filter((cell) => cell.value.trim())
        .sort((a, b) => columnIndex(a.ref) - columnIndex(b.ref))
        .map((cell) => cell.value));
    return { name: sheetName, rows: rows.filter((row) => row.some((cell) => cell.trim())) };
  });
}

interface PresentationSlide {
  number: number;
  texts: string[];
}

function parsePresentationSlides(buf: Buffer): PresentationSlide[] {
  if (!buf?.length) throw new Error('empty or invalid presentation');
  const zip = new AdmZip(buf);
  const slideEntries = zip.getEntries()
    .map((entry) => entry.entryName)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml/i)?.[1] || 0) - Number(b.match(/slide(\d+)\.xml/i)?.[1] || 0));

  if (!slideEntries.length) throw new Error('presentation contains no slides');

  return slideEntries.map((slidePath) => ({
    number: Number(slidePath.match(/slide(\d+)\.xml/i)?.[1] || 0),
    texts: textNodes(readZipText(zip, slidePath)),
  }));
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
    const rows = sheet.rows.length
      ? sheet.rows.map((row) => (
        `<tr>${Array.from({ length: maxCols }, (_unused, i) => `<td>${escapeHtml(row[i] || '')}</td>`).join('')}</tr>`
      )).join('')
      : '<tr><td class="office-empty-cell">(empty sheet)</td></tr>';
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
    const lines = slide.texts.length
      ? slide.texts.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
      : '<p class="office-muted">(no text)</p>';
    return [
      `<section class="office-slide" aria-label="Slide ${slide.number}">`,
      '<div class="office-slide-body">',
      lines,
      '</div>',
      '</section>',
    ].join('');
  }).join('');
}
