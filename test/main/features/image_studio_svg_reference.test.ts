import { expect, it } from 'vitest';
import sharp from 'sharp';
import { svgReferencePng } from '../../../src/main/features/image_studio_svg_reference';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#123456"/><text x="20" y="60">Source</text></svg>';
it('renders a lossless model reference while preserving the original editable SVG', async () => {
  const source = Buffer.from(svg), original = Buffer.from(source), preview = await svgReferencePng(source);
  expect(source).toEqual(original);
  expect(await sharp(preview).metadata()).toMatchObject({ format: 'png', width: 320, height: 240 });
  expect(await sharp(preview).raw().toBuffer()).toEqual(await sharp(original).raw().toBuffer());
});
it('bounds a large reference preview without rewriting its source', async () => {
  const source = Buffer.from(svg.replaceAll('320', '4096').replaceAll('240', '2048'));
  expect(await sharp(await svgReferencePng(source)).metadata()).toMatchObject({ width: 2048, height: 1024 });
  expect(source.toString()).toContain('4096');
});
it.each(['<image href="file:///outside.png"/>', '<image href="https://example.com/a.png"/>',
  '<style>@import "outside.css";</style>', '<rect style="fill:url(outside.svg#color)"/>',
  '<script>alert(1)</script>', '<foreignObject/>', '<rect onclick="alert(1)"/>'])('rejects external or active SVG reference content: %s', async extra => {
  await expect(svgReferencePng(Buffer.from(svg.replace('</svg>', `${extra}</svg>`)))).rejects.toThrow('E_IMAGE_SVG_REFERENCE');
});
it('rejects malformed, entity-bearing and oversized SVG without a preview', async () => {
  for (const text of ['<svg>', '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///outside">]>'+svg, svg + ' '.repeat(1_048_576)]) {
    await expect(svgReferencePng(Buffer.from(text))).rejects.toThrow('E_IMAGE_SVG_REFERENCE');
  }
});
