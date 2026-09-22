import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { runtimeResourcesDir } from '../paths';
import { bundledRuntimeEnv } from './bundled-runtime';

type XlsSheet = { name: string; rows: Array<{ number: number; values: string[] }> };
const MAX_BYTES = 50 * 1024 * 1024;
let active = 0;
const waiters: Array<() => void> = [];

/** All callers share a bounded process pool, including both Library corpora. */
async function readXls(buf: Buffer): Promise<XlsSheet[]> {
  if (!buf.length || buf.length > MAX_BYTES) throw new Error('XLS input must be non-empty and at most 50 MB.');
  if (active >= 2) {
    if (waiters.length >= 32) throw new Error('XLS reading is busy. Retry after current files finish.');
    await new Promise<void>(resolve => waiters.push(resolve));
  } else active++;
  try {
    const python = bundledRuntimeEnv().ORKAS_PYTHON;
    if (!python) throw new Error('The XLS reader is unavailable. Repair the application installation and retry.');
    const script = path.join(runtimeResourcesDir(), '..', 'xls-reader', '2.0.2', 'read.py');
    const raw = await new Promise<string>((resolve, reject) => {
      const child = execFile(python, ['-I', '-B', script], {
        timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, killSignal: 'SIGKILL',
        encoding: 'utf8',
      }, (error, stdout) => {
        if (error) reject(new Error('XLS reading failed or exceeded its resource limit. Check the file and retry.'));
        else resolve(stdout);
      });
      // Early parser/process failures can close stdin before the write finishes.
      child.stdin?.on('error', () => {});
      child.stdin?.end(buf);
    });
    const result = JSON.parse(raw) as { error?: string; sheets?: XlsSheet[] };
    if (result.error === 'encrypted') throw new Error('This XLS file is password-protected. Attach an unencrypted copy.');
    if (result.error === 'limit') throw new Error('This XLS file exceeds the reading limit. Split it into smaller workbooks.');
    if (result.error || !Array.isArray(result.sheets)) throw new Error('Cannot read this XLS file. It may be damaged or use another format.');
    return result.sheets;
  } finally {
    const next = waiters.shift();
    if (next) next();
    else active--;
  }
}

export async function xlsBufferToMarkdown(buf: Buffer): Promise<string> {
  const sheets = await readXls(buf);
  return ['# Spreadsheet', ...sheets.flatMap(sheet => [
    `\n## ${sheet.name}`,
    ...sheet.rows.map(row => `Row ${row.number}: ${row.values.join('\t')}`),
  ])].join('\n') + '\n';
}

export async function xlsBufferToHtml(buf: Buffer): Promise<string> {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return (await readXls(buf)).map(sheet =>
    `<section class="office-sheet"><h2>${escape(sheet.name)}</h2><div class="office-table-wrap"><table><tbody>`
    + sheet.rows.map(row => `<tr>${row.values.map(value => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')
    + '</tbody></table></div></section>',
  ).join('');
}

/** XLS uses BIFF/CFB; modern workbooks are ZIP containers even if renamed. */
export function isZipSpreadsheet(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
}
