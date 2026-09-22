import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererRoot = path.join(__dirname, '../../src/renderer');
const source = fs.readFileSync(path.join(rendererRoot, 'modules/project-detail.js'), 'utf8');
const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');

type Stub = Record<string, any>;

function element(extra: Stub = {}): Stub {
  const classes = new Set<string>();
  return {
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    dataset: {},
    style: {},
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
      toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
    },
    focused: false,
    focus() { this.focused = true; },
    setAttribute(name: string, value: string) { this[`attr:${name}`] = value; },
    setSelectionRange() {},
    addEventListener() {},
    ...extra,
  };
}

/** Load the module with just the nodes the instructions panel touches. */
function mount(content: string | null) {
  const elements: Record<string, Stub> = {
    'project-instructions-input': element(),
    'project-instructions-read': element(),
    'project-instructions-empty': element(),
    'project-instructions-edit-btn': element(),
    'project-instructions-setup-btn': element(),
    'project-instructions-counter': element(),
    'project-instructions-save-btn': element(),
    'project-instructions-status': element(),
    'project-instructions-modal': element(),
  };
  const sectionHead = element();
  const context = vm.createContext({
    console,
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById: (id: string) => elements[id] || null,
      querySelector: (selector: string) => (
        selector === '.project-side-instructions-panel .project-context-section-head' ? sectionHead : null
      ),
      createElement: () => element(),
    },
    window: { addEventListener() {}, orkas: { invoke: async () => ({ ok: true }) } },
    escapeHtml: (value: string) => value,
    t: (key: string) => key,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'project-detail.js' });
  vm.runInContext(
    content === null
      ? '_projectDetailMeta = {}'
      : `_projectDetailMeta = { instructions: { content: ${JSON.stringify(content)}, limit: 4000 } }`,
    context,
  );
  context._renderProjectInstructions();
  return { context, elements, sectionHead };
}

describe('project instructions editor', () => {
  it('keeps the textarea in a dialog and the saved rules in the rail', () => {
    expect(html).toContain('id="project-instructions-modal"');
    expect(html).toMatch(/project-instructions-modal[\s\S]*?id="project-instructions-input"/);
    expect(html).toContain('id="project-instructions-read"');
    expect(html).toContain('id="project-instructions-edit-btn"');
  });

  it('renders saved rules as read-only copy', () => {
    const { elements, sectionHead } = mount('Verify sources before reporting.');
    expect(elements['project-instructions-read'].textContent).toBe('Verify sources before reporting.');
    expect(elements['project-instructions-read'].hidden).toBe(false);
    expect(elements['project-instructions-empty'].hidden).toBe(true);
    expect(sectionHead.hidden).toBe(false);
    expect(elements['project-instructions-edit-btn'].disabled).toBe(false);
  });

  it('offers the empty state instead of a blank editor when there are no rules', () => {
    const { elements, sectionHead } = mount('');
    expect(elements['project-instructions-read'].hidden).toBe(true);
    expect(elements['project-instructions-empty'].hidden).toBe(false);
    expect(sectionHead.hidden).toBe(true);
  });

  it('locks both entry points when instructions never loaded', () => {
    const { elements } = mount(null);
    expect(elements['project-instructions-edit-btn'].disabled).toBe(true);
    expect(elements['project-instructions-setup-btn'].disabled).toBe(true);
  });

  it('opens on the saved value and drops an abandoned draft on close', async () => {
    const { context, elements } = mount('Original rules.');
    const input = elements['project-instructions-input'];
    const modal = elements['project-instructions-modal'];

    context._openProjectInstructionsEditor();
    expect(modal.classList.contains('open')).toBe(true);
    expect(input.value).toBe('Original rules.');

    input.value = 'A draft nobody saved.';
    await context._closeProjectInstructionsEditor({ force: true });
    expect(modal.classList.contains('open')).toBe(false);
    expect(input.value).toBe('Original rules.');
    // The rail keeps showing what conversations actually get.
    expect(elements['project-instructions-read'].textContent).toBe('Original rules.');

    context._openProjectInstructionsEditor();
    expect(input.value).toBe('Original rules.');
  });

  it('refuses to open the editor for instructions it could not load', () => {
    const { context, elements } = mount(null);
    context._openProjectInstructionsEditor();
    expect(elements['project-instructions-modal'].classList.contains('open')).toBe(false);
  });
});
