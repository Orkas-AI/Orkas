import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
const { parse } = createRequire(import.meta.url)('../../src/renderer/modules/delimited-preview.js');

describe('CSV and TSV data preview', () => {
  it('preserves quoted delimiters, escaped quotes, multiline cells, Unicode and leading zeroes', () => {
    const result = parse('\uFEFFid,name,note\r\n001,"中文,名称","first\nsecond ""quote"""\r\n002,,=1+1\r\n', ',');
    expect(result).toEqual({ rows: [
      ['id', 'name', 'note'], ['001', '中文,名称', 'first\nsecond "quote"'], ['002', '', '=1+1'],
    ], limited: false, malformed: false });
  });
  it('retains TSV tabs inside quoted fields and trailing empty fields', () => {
    expect(parse('a\tb\rc\t"d\te"\rf\t', '\t').rows).toEqual([['a', 'b'], ['c', 'd\te'], ['f', '']]);
  });
  it.each(['a,"unfinished', 'a,"closed"extra', 'a,b"c'])('falls back to source for malformed records: %s', text => {
    expect(parse(text, ',').malformed).toBe(true);
  });
  it('keeps empty files empty and preserves blank records', () => {
    expect(parse('', ',').rows).toEqual([]);
    expect(parse('a\n\nb\n', ',').rows).toEqual([['a'], [''], ['b']]);
  });
  it('bounds rows, columns and cell content with an explicit incomplete result', () => {
    const start = performance.now();
    const rows = parse('a,b\n'.repeat(500_000), ',');
    expect(rows.rows).toHaveLength(200);
    expect(rows.limited).toBe(true);
    const columns = parse('x,'.repeat(200), ',');
    expect(columns.rows[0]).toHaveLength(100);
    expect(columns.limited).toBe(true);
    const cell = parse('x'.repeat(100_000), ',');
    expect(cell.rows[0][0]).toHaveLength(4000);
    expect(cell.limited).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });
  it('does not invent the rest of a record cut by the preview byte limit', () => {
    expect(parse('a,b\n1,"partial', ',', true)).toEqual({ rows: [['a', 'b']], limited: true, malformed: false });
  });
});
