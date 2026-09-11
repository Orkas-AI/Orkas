import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const pcRoot = path.resolve(__dirname, '../..');
const viewerSource = fs.readFileSync(
  path.resolve(pcRoot, 'src/renderer/modules/chat-file-viewer.js'),
  'utf8',
);
const lightboxSource = fs.readFileSync(
  path.resolve(pcRoot, 'src/renderer/modules/chat-lightbox.js'),
  'utf8',
);
const styleSource = fs.readFileSync(path.resolve(pcRoot, 'src/renderer/style.css'), 'utf8');

function extractFunction(source: string, name: string): string {
  const marker = source.includes(`async function ${name}`)
    ? `async function ${name}`
    : `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

describe('file preview loading states', () => {
  it('uses the same accessible loading view for every asynchronous file-viewer kind', () => {
    const helper = extractFunction(viewerSource, '_viewerShowLoading');
    expect(helper).toContain("setAttribute('aria-busy', 'true')");
    expect(helper).toContain('_viewerLoadingHtml()');
    expect(viewerSource).toContain('role="status" aria-live="polite"');

    for (const name of [
      '_renderPdfBody',
      '_renderHtmlBody',
      '_renderOfficeBody',
      '_renderVideoBody',
      'openChatVideoUrlViewer',
      '_renderAudioBody',
      '_renderMarkdownBody',
      '_renderTextBody',
    ]) {
      expect(extractFunction(viewerSource, name), `${name} loading state`).toContain('_viewerShowLoading()');
    }

    expect(styleSource).toMatch(/\.chat-file-viewer-loading-resource\s*\{[\s\S]*?visibility:\s*hidden;/);
  });

  it('keeps the image lightbox busy until the image load or error event settles', () => {
    const open = extractFunction(lightboxSource, 'openChatImageLightbox');
    expect(lightboxSource).toContain('class="chat-lightbox-loading"');
    expect(open).toContain('_setLightboxLoading(true)');
    expect(open).toContain("addEventListener('load'");
    expect(open).toContain("addEventListener('error'");
    expect(open).toContain('_setLightboxLoading(false)');
    expect(styleSource).toMatch(/\.chat-lightbox\.is-loading \.chat-lightbox-img\s*\{[\s\S]*?visibility:\s*hidden;/);
  });
});
