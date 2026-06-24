import { describe, it, expect } from 'vitest';

import {
  buildDocxBatch, buildXlsxBatch, buildXlsxWorkbookBatch, buildPptxBatch, buildEditBatch, columnLetter,
  type DocxParagraphSpec, type XlsxCell, type EditOp,
} from '../../../../src/main/model/core-agent/office-batch';

describe('buildDocxBatch', () => {
  it('maps text / style / align / list to OfficeCLI props in order', () => {
    const ops = buildDocxBatch([
      { text: '季度报告', style: 'Heading1' },
      { text: '正文段落 繁體 😀', align: 'justify' },
      { text: '第一项', list: 'bullet' },
      { text: '步骤一', list: 'ordered' },
    ]);
    expect(ops).toEqual([
      { command: 'add', parent: '/body', type: 'p', props: { text: '季度报告', style: 'Heading1' } },
      { command: 'add', parent: '/body', type: 'p', props: { text: '正文段落 繁體 😀', align: 'justify' } },
      { command: 'add', parent: '/body', type: 'p', props: { text: '第一项', listStyle: 'bullet' } },
      { command: 'add', parent: '/body', type: 'p', props: { text: '步骤一', listStyle: 'ordered' } },
    ]);
  });

  it('drops null / non-string-text entries the model may emit', () => {
    const bad = [null, { style: 'Heading1' }, { text: 'kept' }] as unknown as DocxParagraphSpec[];
    const ops = buildDocxBatch(bad);
    expect(ops).toEqual([{ command: 'add', parent: '/body', type: 'p', props: { text: 'kept' } }]);
  });

  it('ignores an unknown list value rather than passing it through', () => {
    const bad = [{ text: 'x', list: 'roman' }] as unknown as DocxParagraphSpec[];
    const ops = buildDocxBatch(bad);
    expect(ops[0].props).toEqual({ text: 'x' });
  });

  it('serializes to JSON without manual escaping (stdin payload)', () => {
    const json = JSON.stringify(buildDocxBatch([{ text: 'a"b\n,。' }]));
    expect(JSON.parse(json)[0].props.text).toBe('a"b\n,。');
  });

  it('passes inline run styling through, coercing bool/number to strings', () => {
    const ops = buildDocxBatch([
      { text: '强调', bold: true, italic: false, color: '#1F4E79', size: 14, font: '微软雅黑' },
    ]);
    expect(ops).toEqual([
      {
        command: 'add', parent: '/body', type: 'p',
        props: { text: '强调', bold: 'true', italic: 'false', color: '#1F4E79', size: '14', font: '微软雅黑' },
      },
    ]);
  });

  it('appends tables (add + per-cell set) and images (host p + picture) after paragraphs', () => {
    const ops = buildDocxBatch(
      [{ text: 'Intro' }],
      [{ rows: [['H1', 'H2'], ['v1', '']], colWidths: '2in,3in' }],
      [{ src: '/abs/logo.png', width: '2in', align: 'center' }],
    );
    expect(ops).toEqual([
      { command: 'add', parent: '/body', type: 'p', props: { text: 'Intro' } },
      { command: 'add', parent: '/body', type: 'table', props: { rows: '2', cols: '2', colWidths: '2in,3in' } },
      { command: 'set', path: '/body/table[1]/tr[1]/tc[1]/p[1]', props: { text: 'H1' } },
      { command: 'set', path: '/body/table[1]/tr[1]/tc[2]/p[1]', props: { text: 'H2' } },
      { command: 'set', path: '/body/table[1]/tr[2]/tc[1]/p[1]', props: { text: 'v1' } },
      { command: 'add', parent: '/body', type: 'p', props: { align: 'center' } },
      { command: 'add', parent: '/body/p[2]', type: 'picture', props: { src: '/abs/logo.png', width: '2in' } },
    ]);
  });
});

describe('buildXlsxWorkbookBatch', () => {
  it('reuses the default sheet (rename), adds later sheets, columns then cells', () => {
    const ops = buildXlsxWorkbookBatch([
      { name: 'Data', columns: [{ name: 'A', width: 24 }], rows: [['x']] },
      { name: 'Summary', rows: [[{ value: 'total', bold: true }]] },
    ]);
    expect(ops).toEqual([
      { command: 'set', path: '/Sheet1', props: { name: 'Data' } },
      { command: 'add', parent: '/Data', type: 'column', props: { name: 'A', width: '24' } },
      { command: 'set', path: '/Data/A1', props: { value: 'x' } },
      { command: 'add', parent: '/', type: 'sheet', props: { name: 'Summary' } },
      { command: 'set', path: '/Summary/A1', props: { value: 'total', bold: 'true' } },
    ]);
  });

  it('keeps the default name when the first sheet is unnamed (no rename op)', () => {
    expect(buildXlsxWorkbookBatch([{ rows: [['a']] }])).toEqual([
      { command: 'set', path: '/Sheet1/A1', props: { value: 'a' } },
    ]);
  });
});

describe('columnLetter', () => {
  it('maps 0-based index to Excel column letters', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter))
      .toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

describe('buildXlsxBatch', () => {
  it('places rows as A1/B1… set ops; bare cells and objects, formula strips leading =', () => {
    const ops = buildXlsxBatch('Sheet1', [
      ['月份', '销售额'],
      ['一月', 100],
      [{ value: '合计', bold: true }, { formula: '=SUM(B2:B2)', format: '#,##0' }],
    ] as XlsxCell[][]);
    expect(ops).toEqual([
      { command: 'set', path: '/Sheet1/A1', props: { value: '月份' } },
      { command: 'set', path: '/Sheet1/B1', props: { value: '销售额' } },
      { command: 'set', path: '/Sheet1/A2', props: { value: '一月' } },
      { command: 'set', path: '/Sheet1/B2', props: { value: '100' } },
      { command: 'set', path: '/Sheet1/A3', props: { value: '合计', bold: 'true' } },
      { command: 'set', path: '/Sheet1/B3', props: { formula: 'SUM(B2:B2)', numberformat: '#,##0' } },
    ]);
  });

  it('skips empty cells so a ragged grid leaves gaps', () => {
    const ops = buildXlsxBatch('S', [['a', '', null as unknown as string, 'd']]);
    expect(ops.map((o) => ('path' in o ? o.path : ''))).toEqual(['/S/A1', '/S/D1']);
  });

  it('passes cell styling props through alongside value/format', () => {
    const ops = buildXlsxBatch('Sheet1', [
      [{ value: '标题', bold: true, fill: '#1F4E79', 'font.color': '#FFFFFF', halign: 'center', merge: 'A1:C1' }],
    ] as XlsxCell[][]);
    expect(ops).toEqual([
      {
        command: 'set', path: '/Sheet1/A1',
        props: { value: '标题', bold: 'true', fill: '#1F4E79', 'font.color': '#FFFFFF', halign: 'center', merge: 'A1:C1' },
      },
    ]);
  });
});

describe('buildPptxBatch', () => {
  it('emits add-slide ops with title/body(text)/layout', () => {
    const ops = buildPptxBatch([
      { title: '封面', body: '副标题' },
      { title: '要点', body: '第一行\n第二行', layout: 'Title and Content' },
      {},
    ]);
    expect(ops).toEqual([
      { command: 'add', parent: '/', type: 'slide', props: { title: '封面', text: '副标题' } },
      { command: 'add', parent: '/', type: 'slide', props: { title: '要点', text: '第一行\n第二行', layout: 'Title and Content' } },
      { command: 'add', parent: '/', type: 'slide', props: {} },
    ]);
  });

  it('adds free-positioned shapes under /slide[N] with slide background/transition', () => {
    const ops = buildPptxBatch([
      {
        background: '#06101D', transition: 'fade',
        shapes: [
          { text: 'Hi', x: '0.65in', y: '0.58in', width: '3.2in', height: '0.32in', fill: '#38BDF8', color: '#FFFFFF', bold: true, align: 'center', size: 24 },
        ],
      },
      { title: '要点', shapes: [{ text: 'box2', x: '1in', y: '1in', width: '2in', height: '0.5in' }] },
    ]);
    expect(ops).toEqual([
      { command: 'add', parent: '/', type: 'slide', props: { background: '#06101D', transition: 'fade' } },
      {
        command: 'add', parent: '/slide[1]', type: 'shape',
        props: { text: 'Hi', x: '0.65in', y: '0.58in', width: '3.2in', height: '0.32in', fill: '#38BDF8', color: '#FFFFFF', bold: 'true', align: 'center', size: '24' },
      },
      { command: 'add', parent: '/', type: 'slide', props: { title: '要点' } },
      { command: 'add', parent: '/slide[2]', type: 'shape', props: { text: 'box2', x: '1in', y: '1in', width: '2in', height: '0.5in' } },
    ]);
  });

  it('skips a shape that coerces to no props while keeping the slide index in step', () => {
    const ops = buildPptxBatch([
      {},
      { shapes: [{}, { text: 'x' }] },
    ]);
    expect(ops).toEqual([
      { command: 'add', parent: '/', type: 'slide', props: {} },
      { command: 'add', parent: '/', type: 'slide', props: {} },
      { command: 'add', parent: '/slide[2]', type: 'shape', props: { text: 'x' } },
    ]);
  });

  it('adds pictures and tables (with per-cell text, no /p[1]) under the slide', () => {
    const ops = buildPptxBatch([
      {
        images: [{ src: '/abs/p.png', x: '1in', y: '1in', width: '2in', height: '2in' }],
        tables: [{ rows: [['A', 'B'], ['c', 'd']], x: '1in', y: '4in' }],
      },
    ]);
    expect(ops).toEqual([
      { command: 'add', parent: '/', type: 'slide', props: {} },
      { command: 'add', parent: '/slide[1]', type: 'picture', props: { src: '/abs/p.png', x: '1in', y: '1in', width: '2in', height: '2in' } },
      { command: 'add', parent: '/slide[1]', type: 'table', props: { rows: '2', cols: '2', x: '1in', y: '4in' } },
      { command: 'set', path: '/slide[1]/table[1]/tr[1]/tc[1]', props: { text: 'A' } },
      { command: 'set', path: '/slide[1]/table[1]/tr[1]/tc[2]', props: { text: 'B' } },
      { command: 'set', path: '/slide[1]/table[1]/tr[2]/tc[1]', props: { text: 'c' } },
      { command: 'set', path: '/slide[1]/table[1]/tr[2]/tc[2]', props: { text: 'd' } },
    ]);
  });

  it('skips a picture without a src', () => {
    expect(buildPptxBatch([{ images: [{ x: '1in' }] }])).toEqual([
      { command: 'add', parent: '/', type: 'slide', props: {} },
    ]);
  });
});

describe('buildEditBatch', () => {
  it('maps set/add/remove to batch commands and stringifies props', () => {
    const ops = buildEditBatch([
      { action: 'set', path: '/body/p[2]', props: { text: '改后', align: 'center' } },
      { action: 'set', path: '/Sheet1/B2', props: { value: 42, formula: '=SUM(A1:A2)' } },
      { action: 'add', parent: '/body', type: 'p', props: { text: '新段' } },
      { action: 'remove', path: '/body/p[1]' },
    ]);
    expect(ops).toEqual([
      { command: 'set', path: '/body/p[2]', props: { text: '改后', align: 'center' } },
      { command: 'set', path: '/Sheet1/B2', props: { value: '42', formula: 'SUM(A1:A2)' } },
      { command: 'add', parent: '/body', type: 'p', props: { text: '新段' } },
      { command: 'remove', path: '/body/p[1]' },
    ]);
  });

  it('drops malformed ops (missing path/parent/type, unknown action, null props)', () => {
    const bad = [
      { action: 'set' },
      { action: 'add', parent: '/body' },
      { action: 'frobnicate', path: '/x' },
      null,
      { action: 'remove', path: '/body/p[9]' },
      { action: 'set', path: '/ok', props: { a: null, b: undefined, c: 0 } },
    ] as unknown as EditOp[];
    const ops = buildEditBatch(bad);
    expect(ops).toEqual([
      { command: 'remove', path: '/body/p[9]' },
      { command: 'set', path: '/ok', props: { c: '0' } },
    ]);
  });
});
