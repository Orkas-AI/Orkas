import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

function literalIconNames(html: string, scripts: readonly string[]): Set<string> {
  const names = new Set<string>();
  const attributes = (text: string) => {
    for (const match of text.matchAll(/data-ui-icon=(["'])(.*?)\1/gs)) names.add(match[2]);
  };
  attributes(html);
  for (const source of scripts) {
    const file = ts.createSourceFile('renderer.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node) => {
      // Template-expression fragments cannot contain a complete interpolated
      // attribute; actual static attributes and literal calls remain checked.
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) attributes(node.text);
      if (ts.isCallExpression(node) && /^(?:window\.)?_?uiIconHtml$/.test(node.expression.getText(file))) {
        const name = node.arguments[0];
        if (name && ts.isStringLiteralLike(name)) names.add(name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return names;
}

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
  it('represents media aspect ratios with proportional frames and an unconstrained outline', () => {
    const { uiIconHtml } = loadIcons();
    for (const ratio of ['1:1', '4:5', '9:16', '16:9', '3:2']) {
      const html = uiIconHtml('aspect-' + ratio.replace(':', '-'));
      const frame = /<rect\b[^>]*>/.exec(html)?.[0] || '';
      const width = Number(/\bwidth="([\d.]+)"/.exec(frame)?.[1]);
      const height = Number(/\bheight="([\d.]+)"/.exec(frame)?.[1]);
      const [w, h] = ratio.split(':').map(Number);
      expect(width / height, ratio).toBeCloseTo(w / h, 3);
      expect(html).toContain('aria-hidden="true"');
      expect(html).not.toContain('stroke-dasharray');
    }
    expect(uiIconHtml('aspect-any')).toContain('stroke-dasharray');
  });

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

  it('renders announcement actions as a bell instead of the info fallback', () => {
    const { uiIconHtml } = loadIcons();
    const html = uiIconHtml('bell');

    expect(html).toContain('is-bell');
    expect(html).toContain('M18 8a6 6 0 0 0-12 0');
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

  it('distinguishes static icon references from interpolated attributes and calls', () => {
    const names = literalIconNames('<i data-ui-icon="unknown-static"></i><i data-ui-icon="line\nname"></i>', [
      'const dynamic = `<span data-ui-icon="${icon}"></span><span data-ui-icon="${open ? \'chevron-down\' : \'chevron-right\'}"></span>`;',
      'const fixed = `<span data-ui-icon="folder"></span>`; uiIconHtml("missing-call"); uiIconHtml(icon); uiIconHtml(`arrow-${direction}`);',
      'const literal = \'<span data-ui-icon="${literal-name}"></span>\';',
    ]);
    expect([...names].sort()).toEqual(['${literal-name}', 'folder', 'line\nname', 'missing-call', 'unknown-static']);
  });

  it('defines every literal icon referenced by Renderer HTML and JavaScript', () => {
    const { uiIconHtml } = loadIcons();
    const rendererRoot = path.join(__dirname, '../../src/renderer');
    const scripts = fs.readdirSync(path.join(rendererRoot, 'modules'))
        .filter((name) => name.endsWith('.js'))
        .map((name) => fs.readFileSync(path.join(rendererRoot, 'modules', name), 'utf8'));
    const names = literalIconNames(fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8'), scripts);

    expect(names.size).toBeGreaterThan(30);
    for (const name of names) {
      const html = uiIconHtml(name);
      expect(html, `missing icon: ${name}`).toContain(`is-${name}`);
    }
  });
});
