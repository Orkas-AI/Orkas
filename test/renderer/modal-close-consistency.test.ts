import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function splitSelectorList(list: string): string[] {
  const selectors: string[] = [];
  let depth = 0, start = 0;
  for (let index = 0; index < list.length; index++) {
    if (list[index] === '(') depth++;
    else if (list[index] === ')') depth--;
    else if (list[index] === ',' && depth === 0) {
      selectors.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(list.slice(start).trim());
  return selectors;
}

function selectorVariants(selector: string): string[] {
  const group = selector.match(/^(.*?):is\((\.[\w-]+(?:\s*,\s*\.[\w-]+)*)\)(.*)$/);
  if (!group) return [selector.trim()];
  // Expand only a selector-level class group, retaining its context. Nested
  // logical pseudo-classes are outside these simple numeric contracts.
  const depth = [...group[1]].reduce((value, char) => value + (char === '(' ? 1 : char === ')' ? -1 : 0), 0);
  if (depth !== 0) return [selector.trim()];
  return group[2].split(',').flatMap(part => selectorVariants(group[1] + part.trim() + group[3]));
}

// These contracts use simple selectors and numeric declarations. Ignore CSS
// literals and keep each value inside the rule that actually owns the selector.
function declarationsFor(css: string, selector: string) {
  const executable = css.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\//g, ' ');
  const declarations: Record<string, string> = {};
  const important = new Set<string>();
  for (const [, selectors, body] of executable.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const matches = splitSelectorList(selectors).flatMap(selectorVariants).includes(selector);
    if (!matches) continue;
    for (const [, property, value] of body.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]*)/g)) {
      const isImportant = /!important\s*$/i.test(value);
      if (important.has(property) && !isImportant) continue;
      if (isImportant) important.add(property);
      declarations[property] = value.trim().replace(/\s*!important\s*$/i, '');
    }
  }
  return declarations;
}

const indexSource = read('src/renderer/index.html');
const styleSource = read('src/renderer/style.css');
const backdropDismissSources = [
  read('src/renderer/modules/library-transfer.js'),
  read('src/renderer/modules/conversation.js'),
  read('src/renderer/modules/search.js'),
];
const dialogSources = [
  read('src/renderer/modules/library-transfer.js'),
  read('src/renderer/modules/memory.js'),
  read('src/renderer/modules/project-detail.js'),
  read('src/renderer/modules/conversation.js'),
  read('src/renderer/modules/chat-file-viewer.js'),
  read('src/renderer/modules/chat-lightbox.js'),
  read('src/renderer/modules/chat-artifact.js'),
  read('src/renderer/modules/saved-apps.js'),
];

describe('modal close control consistency', () => {
  it.each([
    ['adjacent rule', '.modal-title { color: red; } .other { font-size: 16px; }'],
    ['commented declaration', '.modal-title { /* font-size: 16px; */ }'],
    ['commented rule', '/* .modal-title { font-size: 16px; } */'],
    ['quoted rule', '.other { content: ".modal-title { font-size: 16px; }"; }'],
    ['quoted declaration', '.modal-title { content: "font-size: 16px;"; }'],
    ['custom property', '.modal-title { --font-size: 16px; }'],
    ['descendant selector', '.other .modal-title { font-size: 16px; }'],
    ['different class', '.modal-title-other { font-size: 16px; }'],
    ['pseudo-class suffix', ':is(.modal-title, .other):disabled { font-size: 16px; }'],
    ['descendant prefix', '.other :is(.unused, .modal-title) { font-size: 16px; }'],
    ['compound prefix', '.other:is(.unused, .modal-title) { font-size: 16px; }'],
  ])('does not borrow a declaration from %s', (_label, css) => {
    expect(declarationsFor(css, '.modal-title')['font-size']).toBeUndefined();
  });

  it('reads shared selectors and later declarations within the owning rules', () => {
    expect(declarationsFor('.other, .modal-title { font-size: 14px; font-size: 16px !important; }', '.modal-title'))
      .toMatchObject({ 'font-size': '16px' });
    expect(declarationsFor(':is(.save-app, .save-new-app) { border-radius: 8px; }', '.save-new-app'))
      .toMatchObject({ 'border-radius': '8px' });
    expect(declarationsFor('.modal-title { font-size: 14px !important; font-size: 16px; }', '.modal-title'))
      .toMatchObject({ 'font-size': '14px' });
  });

  it('retains selector context around class-list groups', () => {
    expect(declarationsFor(':is(.modal-title, .other):disabled { font-size: 16px; }', '.modal-title:disabled'))
      .toMatchObject({ 'font-size': '16px' });
    expect(declarationsFor('.parent :is(.unused, .modal-title) { font-size: 16px; }', '.parent .modal-title'))
      .toMatchObject({ 'font-size': '16px' });
    expect(declarationsFor('.parent:is(.unused, .modal-title) { font-size: 16px; }', '.parent.modal-title'))
      .toMatchObject({ 'font-size': '16px' });
  });

  it('does not dismiss the audited open-source dialogs from a backdrop click', () => {
    for (const source of backdropDismissSources) {
      expect(source).not.toMatch(/event\.target\s*===\s*overlay|e\.target\s*===\s*overlay/);
    }
  });

  it('defines one shared close-button and icon treatment', () => {
    expect(styleSource).toContain('.modal-close-btn {');
    expect(styleSource).toContain('.modal-close-btn:hover:not(:disabled)');
    expect(styleSource).toContain('.modal-close-btn:focus-visible');
    expect(styleSource).toContain('.modal-close-icon {');
  });

  it('uses the shared control in static and dynamically mounted dialogs', () => {
    expect(indexSource).toContain('class="modal-close-btn project-library-modal-close"');
    expect(indexSource).toContain('class="modal-close-btn oauth-flow-close-btn"');
    for (const source of dialogSources) {
      expect(source).toContain('modal-close-btn');
      expect(source).toContain('modal-close-icon');
    }
  });

  it('keeps viewer function buttons on the same small corner radius', () => {
    for (const selector of [
      '.chat-lightbox-add-library', '.chat-lightbox-reveal',
      '.chat-file-viewer-md-actions .ctx-viewer-action-icon-btn',
      ...['add-library', 'save-app', 'save-new-app', 'reveal'].map(button => `.chat-file-viewer-${button}`),
    ]) {
      expect(declarationsFor(styleSource, selector)['border-radius'], selector).toBe('8px');
    }
  });

  it('uses one title, body, and action-button sizing contract', () => {
    expect(declarationsFor(styleSource, '.modal-title')).toMatchObject({
      'font-size': '16px', 'font-weight': '600', 'line-height': '1.4',
    });
    expect(declarationsFor(styleSource, '.modal-body')).toMatchObject({
      'font-size': '14px', 'line-height': '1.6',
    });
    expect(declarationsFor(styleSource, '.modal-actions .btn')).toMatchObject({
      'min-width': '76px', 'min-height': '36px', padding: '0 16px', 'font-size': '13px',
    });
  });
});
