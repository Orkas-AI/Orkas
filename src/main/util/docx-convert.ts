/** Worker-only DOCX conversion. Preserve the existing Mammoth formatting path. */
import { preserveDocxNumbering } from './docx-numbering';
let mammothPromise: Promise<any> | undefined;
export async function convertDocx(buf: Buffer, html: boolean): Promise<string> {
  const mammoth: any = await (mammothPromise ||= import('mammoth' as any));
  const name = html ? 'convertToHtml' : 'convertToMarkdown';
  const fn = mammoth[name] ?? mammoth.default?.[name];
  if (typeof fn !== 'function') throw new Error('DOCX converter unavailable');
  const result = await fn({ buffer: preserveDocxNumbering(buf) });
  return String(result?.value ?? '').trim();
}
