import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CSS_PATH = path.join(__dirname, '../../src/renderer/style.css');

/** Custom properties the stylesheet reads but never declares, because a renderer
 *  module sets them per-element at runtime. Anything else referenced-but-undefined
 *  is a ghost token: with a fallback it silently pins a literal that drifts away
 *  from the palette, without one the whole declaration is invalid at computed-value
 *  time and the style simply does not render. */
const RUNTIME_INJECTED = new Set([
  '--sidebar-width', // modules/sidebar-resize.js
  '--avatar-bg', // modules/avatar.js
  '--avatar-fg', // modules/avatar.js
  '--depth', // modules/conversation-info.js
  '--oss-c', // modules/oss.js, modules/marketplace.js
  '--chat-image-aspect-ratio', // modules/utils.js
  '--chat-image-natural-width', // modules/utils.js
  '--composer-model-marquee-distance', // modules/composer-model-picker.js
  '--composer-model-marquee-duration', // modules/composer-model-picker.js
  '--turn-nav-preview-y', // modules/conversation-turn-nav.js
]);

function readRendererCss() {
  return fs.readFileSync(CSS_PATH, 'utf8');
}

function declaredProperties(css: string) {
  const names = new Set<string>();
  for (const match of css.matchAll(/(?:^|[;{\s])(--[a-zA-Z0-9_-]+)\s*:/g)) names.add(match[1]);
  return names;
}

function referencedProperties(css: string) {
  const names = new Set<string>();
  for (const match of css.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) names.add(match[1]);
  return names;
}

describe('renderer design token integrity', () => {
  it('never references a custom property that nothing defines', () => {
    const css = readRendererCss();
    const declared = declaredProperties(css);
    const undefinedRefs = [...referencedProperties(css)]
      .filter((name) => !declared.has(name) && !RUNTIME_INJECTED.has(name))
      .sort();
    expect(undefinedRefs).toEqual([]);
  });

  it('keeps the palette entries TOKENS.md declares binding', () => {
    const css = readRendererCss();
    const root = css.match(/:root\s*\{[\s\S]*?\}/)?.[0] || '';
    for (const [name, value] of [
      ['--primary', '#5b57d6'],
      ['--primary-soft', '#e8e8fe'],
      ['--primary-text', '#4945c0'],
      ['--muted', '#7e8597'],
      ['--surface-2', '#eef1f8'],
      ['--warn', '#d97706'],
      ['--warn-text', '#b45309'],
    ]) {
      expect(root, name).toContain(`${name}: ${value};`);
    }
  });

  it('does not reintroduce the retired ghost token names', () => {
    const css = readRendererCss();
    for (const ghost of [
      '--accent',
      '--accent-soft',
      '--bg-selected',
      '--bg-subtle',
      '--border-soft',
      '--border-subtle',
      '--hover',
      '--shadow-sm',
      '--text-muted',
      '--warning',
      '--warning-bg',
      '--mono',
    ]) {
      expect(css, ghost).not.toMatch(new RegExp(`var\\(\\s*${ghost}[,)]`));
    }
  });
});
