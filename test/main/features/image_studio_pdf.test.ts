import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { inspectImageStudioPdf, normalizeImageStudioPdfCanvas } from '../../../src/main/features/image_studio_pdf';

const canvas = { width: 640, height: 360 };
async function fixture(kind = 'vector') {
  const doc = await PDFDocument.create();
  const page = doc.addPage([480, 270]);
  if (kind === 'image') {
    const image = await doc.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64'));
    page.drawImage(image, { x: 0, y: 0, width: 480, height: 270 });
  } else {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Editable source', { x: 20, y: 200, font });
    page.drawLine({ start: { x: 20, y: 100 }, end: { x: 200, y: 100 } });
  }
  if (kind === 'multipage') doc.addPage([480, 270]);
  return Buffer.from(await doc.save());
}
describe('single-page vector PDF delivery', () => {
  it('normalizes only bounded physical-paper rounding to exact odd canvas dimensions', async () => {
    const canvas = { width: 641, height: 359 };
    const bytes = await normalizeImageStudioPdfCanvas(await fixture(), canvas);
    expect(await inspectImageStudioPdf(bytes, canvas)).toMatchObject({ width_points: 480.75, height_points: 269.25, has_text: true, has_paths: true });
    await expect(normalizeImageStudioPdfCanvas(await fixture(), { width: 800, height: 360 })).rejects.toThrow('E_IMAGE_PDF');
  });
  it('rejects oversized files, expansion bombs and operator names hidden in comments or strings', async () => {
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1); oversized.write('%PDF-');
    await expect(inspectImageStudioPdf(oversized, canvas)).rejects.toThrow('E_IMAGE_PDF');
    for (const content of [Buffer.alloc(4 * 1024 * 1024 + 1, 32), Buffer.from('% Tj f\n BT (Tj f) ET\n')]) {
      const doc = await PDFDocument.create(), page = doc.addPage([480, 270]);
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
      await expect(inspectImageStudioPdf(Buffer.from(await doc.save()), canvas)).rejects.toThrow('E_IMAGE_PDF');
    }
  });
  it('verifies actual text and path painting at the requested nonstandard canvas', async () => {
    expect(await inspectImageStudioPdf(await fixture(), canvas)).toMatchObject({ pages: 1, width_points: 480, height_points: 270, has_text: true, has_paths: true });
  });
  it.each(['image', 'multipage'])('rejects %s as a vector single-page delivery', async kind => {
    await expect(inspectImageStudioPdf(await fixture(kind), canvas)).rejects.toThrow('E_IMAGE_PDF');
  });
  it('allows an explicitly selected document photo page while retaining page-count and canvas gates', async () => {
    expect(await inspectImageStudioPdf(await fixture('image'), canvas, { allowRaster: true })).toMatchObject({ pages: 1, has_text: false, has_paths: false, embedded_images: 1 });
    await expect(inspectImageStudioPdf(await fixture('multipage'), canvas, { allowRaster: true })).rejects.toThrow('E_IMAGE_PDF');
    await expect(inspectImageStudioPdf(await fixture('image'), { width: 800, height: 360 }, { allowRaster: true })).rejects.toThrow('E_IMAGE_PDF');
  });
  it('rejects copied raster bytes and a PDF with the wrong canvas', async () => {
    await expect(inspectImageStudioPdf(Buffer.from('not PDF'), canvas)).rejects.toThrow('E_IMAGE_PDF');
    await expect(inspectImageStudioPdf(await fixture(), { width: 800, height: 360 })).rejects.toThrow('E_IMAGE_PDF');
  });
});
