import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/main/features/permissions', () => ({
  getLocalExecGranted: () => true,
}));

import { createPdfTools } from '../../../../src/main/model/core-agent/pdf-tools';

let root = '';
let written: string[] = [];

function context() {
  return { workingDir: root } as any;
}

function tool(name: string) {
  const found = createPdfTools({
    extraRoots: [root],
    onFileWritten: (abs) => { written.push(abs); },
  }).find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

async function makePdf(file: string, widths: number[] = [300]): Promise<void> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  widths.forEach((width, index) => {
    const page = document.addPage([width, 200 + index]);
    page.drawText(`page-${index + 1}`, { x: 20, y: 100, size: 18, font });
  });
  fs.writeFileSync(file, await document.save());
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-pdf-tools-'));
  written = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('PDF built-in tools', () => {
  it('exposes edit_pdf and pdf_render', () => {
    expect(createPdfTools({}).map((entry) => entry.name)).toEqual(['edit_pdf', 'pdf_render']);
  });

  it('merges PDFs in the requested order and reports the produced file', async () => {
    await makePdf(path.join(root, 'one.pdf'), [301]);
    await makePdf(path.join(root, 'two.pdf'), [401, 402]);

    const result = await tool('edit_pdf').execute({
      action: 'merge',
      input_paths: ['one.pdf', 'two.pdf'],
      output_path: 'merged.pdf',
    }, context());

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content);
    expect(payload).toMatchObject({ action: 'merge', page_count: 3, changed_pages: [1, 2, 3] });
    expect(written).toEqual([path.join(root, 'merged.pdf')]);
    const merged = await PDFDocument.load(fs.readFileSync(path.join(root, 'merged.pdf')));
    expect(merged.getPages().map((page) => page.getWidth())).toEqual([301, 401, 402]);
  });

  it('extracts, deletes, reorders, and rotates with 1-based page numbers', async () => {
    const source = path.join(root, 'source.pdf');
    await makePdf(source, [301, 302, 303]);

    const extractedResult = await tool('edit_pdf').execute({
      action: 'extract_pages', input_path: source, output_path: 'extract.pdf', pages: [3, 1],
    }, context());
    expect(extractedResult.isError).toBeUndefined();
    const extracted = await PDFDocument.load(fs.readFileSync(path.join(root, 'extract.pdf')));
    expect(extracted.getPages().map((page) => page.getWidth())).toEqual([303, 301]);

    const deletedResult = await tool('edit_pdf').execute({
      action: 'delete_pages', input_path: source, output_path: 'delete.pdf', pages: [2],
    }, context());
    expect(deletedResult.isError).toBeUndefined();
    const deleted = await PDFDocument.load(fs.readFileSync(path.join(root, 'delete.pdf')));
    expect(deleted.getPages().map((page) => page.getWidth())).toEqual([301, 303]);

    const reorderedResult = await tool('edit_pdf').execute({
      action: 'reorder_pages', input_path: source, output_path: 'reorder.pdf', page_order: [2, 3, 1],
    }, context());
    expect(reorderedResult.isError).toBeUndefined();
    const reordered = await PDFDocument.load(fs.readFileSync(path.join(root, 'reorder.pdf')));
    expect(reordered.getPages().map((page) => page.getWidth())).toEqual([302, 303, 301]);

    const rotatedResult = await tool('edit_pdf').execute({
      action: 'rotate_pages', input_path: source, output_path: 'rotate.pdf', pages: [2], degrees: 90,
    }, context());
    expect(rotatedResult.isError).toBeUndefined();
    const rotated = await PDFDocument.load(fs.readFileSync(path.join(root, 'rotate.pdf')));
    expect(rotated.getPage(0).getRotation().angle).toBe(0);
    expect(rotated.getPage(1).getRotation().angle).toBe(90);
  });

  it('adds a CJK watermark and renders the changed page to an inline PNG', async () => {
    const source = path.join(root, 'source.pdf');
    await makePdf(source);

    const edited = await tool('edit_pdf').execute({
      action: 'watermark',
      input_path: source,
      output_path: 'watermarked.pdf',
      text: '内部机密',
      pages: [1],
    }, context());
    expect(edited.isError).toBeUndefined();
    expect(fs.statSync(path.join(root, 'watermarked.pdf')).size).toBeGreaterThan(fs.statSync(source).size);

    const rendered = await tool('pdf_render').execute({ path: 'watermarked.pdf', page: 1, scale: 1 }, context());
    expect(rendered.isError).toBeUndefined();
    expect(JSON.parse(rendered.content)).toMatchObject({ page: 1, page_count: 1 });
    expect(rendered.images).toHaveLength(1);
    expect(Buffer.from(rendered.images![0].data, 'base64').subarray(0, 8))
      .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('fills text and checkbox form fields', async () => {
    const source = path.join(root, 'form.pdf');
    const document = await PDFDocument.create();
    const page = document.addPage([400, 300]);
    const form = document.getForm();
    form.createTextField('customer_name').addToPage(page, { x: 40, y: 200, width: 180, height: 24 });
    form.createCheckBox('approved').addToPage(page, { x: 40, y: 150, width: 18, height: 18 });
    fs.writeFileSync(source, await document.save());

    const result = await tool('edit_pdf').execute({
      action: 'fill_form',
      input_path: source,
      output_path: 'filled.pdf',
      fields: { customer_name: 'Acme', approved: true },
    }, context());
    expect(result.isError).toBeUndefined();

    const filled = await PDFDocument.load(fs.readFileSync(path.join(root, 'filled.pdf')));
    expect(filled.getForm().getTextField('customer_name').getText()).toBe('Acme');
    expect(filled.getForm().getCheckBox('approved').isChecked()).toBe(true);
  });

  it('rejects source overwrite and invalid page operations', async () => {
    const source = path.join(root, 'source.pdf');
    await makePdf(source, [301, 302]);

    const overwrite = await tool('edit_pdf').execute({
      action: 'rotate_pages', input_path: source, output_path: source, pages: [1], degrees: 90,
    }, context());
    expect(overwrite.isError).toBe(true);
    expect(overwrite.content).toContain('E_SOURCE_OVERWRITE');

    const invalid = await tool('edit_pdf').execute({
      action: 'delete_pages', input_path: source, output_path: 'invalid.pdf', pages: [1, 2],
    }, context());
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain('must leave at least one page');

    const original = await PDFDocument.load(fs.readFileSync(source));
    original.getPage(0).setRotation(degrees(0));
    expect(original.getPageCount()).toBe(2);
  });

  it('rejects oversized and excessive-page PDFs before producing an output', async () => {
    const oversized = path.join(root, 'oversized.pdf');
    fs.writeFileSync(oversized, '%PDF-1.7\n');
    fs.truncateSync(oversized, 128 * 1024 * 1024 + 1);

    const oversizedResult = await tool('edit_pdf').execute({
      action: 'rotate_pages',
      input_path: oversized,
      output_path: 'oversized-output.pdf',
      pages: [1],
      degrees: 90,
    }, context());

    expect(oversizedResult).toMatchObject({ isError: true });
    expect(oversizedResult.content).toContain('E_PDF_LIMIT');
    expect(fs.existsSync(path.join(root, 'oversized-output.pdf'))).toBe(false);

    const manyPages = path.join(root, 'many-pages.pdf');
    const document = await PDFDocument.create();
    for (let index = 0; index < 2_001; index += 1) document.addPage([10, 10]);
    fs.writeFileSync(manyPages, await document.save());

    const manyPagesResult = await tool('edit_pdf').execute({
      action: 'rotate_pages',
      input_path: manyPages,
      output_path: 'many-pages-output.pdf',
      pages: [1],
      degrees: 90,
    }, context());

    expect(manyPagesResult).toMatchObject({ isError: true });
    expect(manyPagesResult.content).toContain('2000-page processing limit');
    expect(fs.existsSync(path.join(root, 'many-pages-output.pdf'))).toBe(false);
  });

  it('caps rendered PDF pages by both dimension and total pixel budget', async () => {
    const source = path.join(root, 'large-page.pdf');
    const document = await PDFDocument.create();
    document.addPage([10_000, 10_000]);
    fs.writeFileSync(source, await document.save());

    const rendered = await tool('pdf_render').execute({
      path: source,
      page: 1,
      scale: 3,
    }, context());

    expect(rendered.isError).toBeUndefined();
    const payload = JSON.parse(rendered.content);
    expect(payload.width).toBeLessThanOrEqual(4096);
    expect(payload.height).toBeLessThanOrEqual(4096);
    expect(payload.width * payload.height).toBeLessThanOrEqual(8 * 1024 * 1024 + 4096);
  });
});
