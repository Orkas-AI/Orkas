import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTextPreview, TEXT_PREVIEW_BYTES } from '../../../src/main/util/text-preview';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function file(content: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-text-preview-'));
  dirs.push(dir);
  const name = path.join(dir, 'data.csv');
  fs.writeFileSync(name, content);
  return name;
}
describe('bounded text preview', () => {
  it('strips only the leading BOM and preserves complete data at the limit', () => {
    expect(readTextPreview(file('\uFEFFid,value\n001,中文'))).toEqual({ text: 'id,value\n001,中文', truncated: false });
    const content = 'a'.repeat(TEXT_PREVIEW_BYTES);
    expect(readTextPreview(file(content))).toEqual({ text: content, truncated: false });
  });
  it('reports truncation without leaking a replacement character at a UTF-8 boundary', () => {
    const prefix = 'a'.repeat(TEXT_PREVIEW_BYTES - 1);
    const name = file(prefix + '中文\n');
    expect(readTextPreview(name)).toEqual({ text: prefix, truncated: true });
    expect(fs.readFileSync(name, 'utf8')).toBe(prefix + '中文\n');
  });
});
