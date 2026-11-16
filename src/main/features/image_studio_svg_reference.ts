import { XMLValidator } from 'fast-xml-parser';
import { encodeImage } from '../util/sharp-runtime';
import { extractCssImports, extractCssUrls, parseHtmlStructure } from './video_studio_html_check';

/** A bounded visual reference copy; the editable SVG file is never rewritten.
 * Standalone external resources are not loaded by this model-image conversion. */
export async function svgReferencePng(source: Buffer): Promise<Buffer> {
  const fail = () => { throw new Error('E_IMAGE_SVG_REFERENCE: use a static SVG of at most 1 MiB with embedded raster assets or fragment references; retain the original and repair external resources.'); };
  if (source.length > 1_048_576) fail();
  const text = source.toString('utf8');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text) || XMLValidator.validate(text) !== true) fail();
  const structure = parseHtmlStructure(text);
  if (structure.diagnostics.length || structure.tags[0]?.tagName !== 'svg') fail();
  const local = (ref: string) => ref.startsWith('#') || /^data:image\/(?:png|jpeg|webp);base64,[\da-z+/=\s]+$/i.test(ref);
  for (const tag of structure.tags) {
    if (['script', 'foreignobject', 'iframe', 'object', 'embed'].includes(tag.tagName)) fail();
    for (const [key, value] of Object.entries(tag.attrs)) {
      if (key.startsWith('on') || (['href', 'xlink:href', 'src'].includes(key) && !local(value.trim()))) fail();
    }
    const css = `${tag.attrs.style || ''}\n${tag.tagName === 'style' ? tag.rawText || '' : ''}`;
    if (extractCssImports(css).length || extractCssUrls(css).some(ref => !local(ref))) fail();
  }
  const result = await encodeImage(source, { format: 'png', failOn: 'error', limitInputPixels: 100_000_000,
    resize: { width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true } });
  return result.data;
}
