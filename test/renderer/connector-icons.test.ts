import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONNECTOR_CATALOG } from '../../src/main/features/connectors/catalog';

const root = path.join(__dirname, '../..');

describe('connector brand icons', () => {
  it('loads the vendored SVG sanitizer before renderer utilities', () => {
    const indexHtml = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    const purifier = '<script src="./vendor/dompurify/purify.min.js"></script>';
    const utilities = '<script src="./modules/utils.js"></script>';

    expect(fs.existsSync(path.join(root, 'src/renderer/vendor/dompurify/purify.min.js'))).toBe(true);
    expect(indexHtml.indexOf(purifier)).toBeGreaterThanOrEqual(0);
    expect(indexHtml.indexOf(purifier)).toBeLessThan(indexHtml.indexOf(utilities));
  });

  it('loads shared public renderer dependencies that survived hosted-module stripping', () => {
    const indexHtml = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    for (const script of [
      './modules/user-error.js',
      './modules/interactive-cli.js',
    ]) {
      expect(fs.existsSync(path.join(root, 'src/renderer', script))).toBe(true);
      expect(indexHtml).toContain(`<script src="${script}"></script>`);
    }
  });

  it('renders exactly one connecting spinner', () => {
    const renderer = fs.readFileSync(path.join(root, 'src/renderer/modules/connectors.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

    expect(renderer).toContain('btn btn-sm btn-primary is-loading');
    expect(renderer).not.toContain('class="btn-spinner"');
    expect(css).toContain('.btn.is-loading::before');
    expect(css).not.toMatch(/(^|\n)\.btn-spinner\s*\{/);
  });

  it('ships an inline SVG for every public connector card', () => {
    const missing = CONNECTOR_CATALOG
      .filter((entry) => !String(entry.icon_svg || '').trim().startsWith('<svg'))
      .map((entry) => entry.id);

    expect(missing).toEqual([]);
  });
});
