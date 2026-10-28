import { afterEach, expect, it } from 'vitest';
import { extractOffice, closeOfficeExtraction } from '../../../src/main/util/office-extract';
import { xlsxBufferToMarkdown, xlsxBufferToHtml, pptxBufferToMarkdown, pptxBufferToHtml } from '../../../src/main/util/extract-office';
import { makeSparseXlsx, makeReorderedPptx, makeMinimalXlsx } from '../../fixtures/make-minimal-office';

afterEach(closeOfficeExtraction);

it('keeps exact extracted content, escaping and caller-owned source bytes', async () => {
  const xlsx = makeSparseXlsx(), pptx = makeReorderedPptx();
  const original = [Buffer.from(xlsx), Buffer.from(pptx)];
  expect(await Promise.all([
    extractOffice('xlsx-markdown', xlsx), extractOffice('xlsx-html', xlsx),
    extractOffice('pptx-markdown', pptx), extractOffice('pptx-html', pptx),
  ])).toEqual([xlsxBufferToMarkdown(xlsx), xlsxBufferToHtml(xlsx), pptxBufferToMarkdown(pptx), pptxBufferToHtml(pptx)]);
  expect([xlsx, pptx]).toEqual(original);
});

it('contains malformed input and lets the next valid document complete', async () => {
  await expect(extractOffice('xlsx-markdown', Buffer.from('not a ZIP'))).rejects.toBeInstanceOf(Error);
  expect(await extractOffice('xlsx-markdown', makeSparseXlsx())).toBe(xlsxBufferToMarkdown(makeSparseXlsx()));
});

it('queues a burst beyond 64 jobs without rejecting it and admits only two input loads', async () => {
  let loads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let failures = 0;
  const work = Array.from({ length: 70 }, () => extractOffice('xlsx-markdown', async () => {
    loads++; await gate; return makeSparseXlsx();
  }).catch(error => { failures++; throw error; }));
  const settled = Promise.allSettled(work);
  await new Promise(resolve => setImmediate(resolve));
  expect(loads).toBe(2);
  expect(failures).toBe(0);
  await closeOfficeExtraction();
  release();
  expect((await settled).every(result => result.status === 'rejected')).toBe(true);
  expect(await extractOffice('xlsx-markdown', makeSparseXlsx())).toContain('Left\t\tRight');
  const completed = await Promise.all(Array.from({ length: 70 }, () => extractOffice('xlsx-markdown', makeSparseXlsx())));
  expect(completed).toEqual(Array(70).fill(xlsxBufferToMarkdown(makeSparseXlsx())));
});

it('keeps the main event loop responsive while preserving a complete large spreadsheet', async () => {
  const rows = Array.from({ length: 40000 }, (_, n) => [`row-${n}`, `Full value ${n} <&>`]);
  const source = makeMinimalXlsx({ rows });
  const measure = async (work: () => string | Promise<string>) => {
    let last = performance.now(), maxGapMs = 0, ticks = 0, rss = process.memoryUsage().rss;
    const rssBefore = rss;
    const timer = setInterval(() => {
      const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now;
      rss = Math.max(rss, process.memoryUsage().rss); ticks++;
    }, 2);
    try {
      await new Promise(resolve => setTimeout(resolve, 5));
      ticks = 0;
      const start = performance.now();
      const text = await work();
      const elapsedMs = performance.now() - start;
      const workTicks = ticks;
      await new Promise(resolve => setTimeout(resolve, 5));
      return { text, elapsedMs, maxGapMs, workTicks, rssBefore, sampledRss: rss };
    } finally { clearInterval(timer); }
  };
  const baseline = await measure(() => xlsxBufferToMarkdown(source));
  const candidate = await measure(() => extractOffice('xlsx-markdown', source));
  expect(candidate.text).toBe(baseline.text);
  expect(candidate.text).toContain('row-39999\tFull value 39999 <&>');
  expect(candidate.workTicks).toBeGreaterThan(0);
  console.log('Office responsiveness measurement', JSON.stringify({ rows: rows.length, inputBytes: source.length,
    outputBytes: Buffer.byteLength(candidate.text), baseline: { ...baseline, text: undefined },
    candidate: { ...candidate, text: undefined } }));
}, 15000);
