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
});
