import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadIcons() {
  const context: any = {
    window: {},
    document: undefined,
  };
  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/icons.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'icons.js' });
  return context.window;
}

describe('icons.js', () => {
  it('renders a real presentation icon instead of the info fallback', () => {
    const { uiIconHtml } = loadIcons();
    const html = uiIconHtml('presentation', 'oss-card-icon');
    expect(html).toContain('is-presentation');
    expect(html).toContain('M12 15v5');
    expect(html).not.toContain('M12 11v5');
  });

  it('renders the purchase source as a recognizable shopping cart', () => {
    const { uiIconHtml } = loadIcons();
    const html = uiIconHtml('shopping-cart');

    expect(html).toContain('is-shopping-cart');
    expect(html).toContain('M3 4h2l2.4 11.2');
    expect(html).not.toContain('is-info');
  });

  it('routes Library file extensions to distinct SVG icon families', () => {
    const { fileKindForName, fileKindIconHtml } = loadIcons();

    expect(fileKindForName('report.pdf')).toBe('pdf');
    expect(fileKindForName('brief.docx')).toBe('doc');
    expect(fileKindForName('metrics.xlsx')).toBe('spreadsheet');
    expect(fileKindForName('launch.pptx')).toBe('presentation');
    expect(fileKindForName('photo.png')).toBe('image');
    expect(fileKindForName('demo.mp4')).toBe('video');
    expect(fileKindForName('worker.ts')).toBe('code');

    expect(fileKindIconHtml('metrics.xlsx')).toContain('is-spreadsheet');
    expect(fileKindIconHtml('launch.pptx')).toContain('is-presentation');
  });

  it('falls back to a safe info icon without reflecting untrusted names or classes', () => {
    const { uiIconHtml } = loadIcons();
    const html = uiIconHtml('"><script>alert(1)</script>', 'safe" onload="alert(1) ui-icon');

    expect(html).toContain('class="ui-icon is-info"');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('onload=');
  });

  it('defines every literal icon referenced by Renderer HTML and JavaScript', () => {
    const { uiIconHtml } = loadIcons();
    const rendererRoot = path.join(__dirname, '../../src/renderer');
    const sources = [
      fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8'),
      ...fs.readdirSync(path.join(rendererRoot, 'modules'))
        .filter((name) => name.endsWith('.js'))
        .map((name) => fs.readFileSync(path.join(rendererRoot, 'modules', name), 'utf8')),
    ];
    const names = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/data-ui-icon=["']([^"']+)["']/g)) names.add(match[1]);
      for (const match of source.matchAll(/\b(?:window\.)?_?uiIconHtml\(\s*["']([^"']+)["']/g)) names.add(match[1]);
    }

    expect(names.size).toBeGreaterThan(30);
    for (const name of names) {
      const html = uiIconHtml(name);
      expect(html, `missing icon: ${name}`).toContain(`is-${name}`);
    }
  });
});
