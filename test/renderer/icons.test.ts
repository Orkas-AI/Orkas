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
});
