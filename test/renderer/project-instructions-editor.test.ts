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
  const listeners: Stub = {};
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
    listeners,
    addEventListener(name: string, handler: (...args: any[]) => any) { listeners[name] = handler; },
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
    performance,
    currentUserId: 'account_a',
    currentView: 'project',
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
  vm.runInContext('_projectDetailPid = "project_a"', context);
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

  it('preserves an open draft when background refresh updates the saved rules', async () => {
    const { context, elements } = mount('Original rules.');
    context._openProjectInstructionsEditor();
    elements['project-instructions-input'].value = 'My unsaved draft';
    vm.runInContext('_projectDetailMeta.instructions.content = "Updated shared rules"', context);
    context._renderProjectInstructions();
    expect(elements['project-instructions-input'].value).toBe('My unsaved draft');
    expect(elements['project-instructions-read'].textContent).toBe('Updated shared rules');
    await context._closeProjectInstructionsEditor({ force: true });
    expect(elements['project-instructions-input'].value).toBe('Updated shared rules');
  });

  it('refuses to open the editor for instructions it could not load', () => {
    const { context, elements } = mount(null);
    context._openProjectInstructionsEditor();
    expect(elements['project-instructions-modal'].classList.contains('open')).toBe(false);
  });

  it.each(['success', 'failure', 'exception'])('isolates a late save %s from another project draft', async outcome => {
    const { context, elements } = mount('A saved');
    const input = elements['project-instructions-input'];
    let finish!: (result: unknown) => void;
    let fail!: (error: Error) => void;
    const writes: unknown[] = [];
    const alerts: string[] = [];
    context.uiAlert = (text: string) => alerts.push(text);
    context.window.orkas.invoke = (channel: string, args: unknown) => {
      writes.push([channel, args]);
      return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    };
    context._bindProjectInstructions();
    context._openProjectInstructionsEditor();
    input.value = 'A submitted';
    const saving = elements['project-instructions-save-btn'].listeners.click();
    vm.runInContext('_projectDetailPid = "project_b"; _projectDetailMeta = { instructions: { content: "B saved" } }', context);
    context._renderProjectInstructions();
    context._openProjectInstructionsEditor();
    input.value = 'B unsaved';
    if (outcome === 'exception') fail(new Error('controlled save failure'));
    else finish({ ok: outcome === 'success' });
    await saving;
    expect(writes).toEqual([['projects.instructions.set', { projectId: 'project_a', content: 'A submitted' }]]);
    expect(input.value).toBe('B unsaved');
    expect(input.dataset.savedValue).toBe('B saved');
    expect(elements['project-instructions-read'].textContent).toBe('B saved');
    expect(elements['project-instructions-modal'].classList.contains('open')).toBe(true);
    expect(elements['project-instructions-status'].textContent).toBe('');
    expect(alerts).toEqual([]);
  });

  it.each(['new draft', 'reopened editor', 'account change'])('preserves a %s while a save completes', async transition => {
    const { context, elements } = mount('A saved');
    const input = elements['project-instructions-input'];
    let finish!: (result: unknown) => void;
    context.window.orkas.invoke = () => new Promise(resolve => { finish = resolve; });
    context._bindProjectInstructions();
    context._openProjectInstructionsEditor();
    input.value = 'A submitted';
    const saving = elements['project-instructions-save-btn'].listeners.click();
    if (transition === 'reopened editor') {
      await context._closeProjectInstructionsEditor({ force: true });
      context._openProjectInstructionsEditor();
    }
    if (transition === 'account change') context.currentUserId = 'account_b';
    input.value = transition === 'reopened editor' ? 'A submitted' : 'New unsaved';
    finish({ ok: true });
    await saving;
    expect(input.value).toBe(transition === 'reopened editor' ? 'A submitted' : 'New unsaved');
    expect(elements['project-instructions-modal'].classList.contains('open')).toBe(true);
    expect(elements['project-instructions-status'].textContent).toBe('');
    expect(input.dataset.savedValue).toBe(transition === 'account change' ? 'A saved' : 'A submitted');
  });

  it.each(['save', 'account'])('ignores an old instructions-change read after a newer %s', async transition => {
    const { context, elements } = mount('Original rules');
    let finish!: (result: unknown) => void;
    context.window.orkas.invoke = (channel: string) => channel === 'projects.instructions.get'
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true });
    context._onProjectInstructionsChanged({ projectId: 'project_a' });
    if (transition === 'save') {
      context._bindProjectInstructions();
      context._openProjectInstructionsEditor();
      elements['project-instructions-input'].value = 'New acknowledged rules';
      await elements['project-instructions-save-btn'].listeners.click();
    } else context.currentUserId = 'account_b';
    finish({ ok: true, content: 'Old read', limit: 4000 });
    await new Promise(resolve => setImmediate(resolve));
    expect(elements['project-instructions-read'].textContent).toBe(transition === 'save' ? 'New acknowledged rules' : 'Original rules');
  });

  it('keeps the newest successful save when an older acknowledgement arrives last', async () => {
    const { context, elements } = mount('Original rules');
    const pending: Array<(result: unknown) => void> = [];
    context.window.orkas.invoke = () => new Promise(resolve => pending.push(resolve));
    context._bindProjectInstructions();
    context._openProjectInstructionsEditor();
    elements['project-instructions-input'].value = 'First submitted rules';
    const first = elements['project-instructions-save-btn'].listeners.click();
    elements['project-instructions-input'].value = 'Latest submitted rules';
    const latest = elements['project-instructions-save-btn'].listeners.click();
    pending[1]({ ok: true });
    await latest;
    pending[0]({ ok: true });
    await first;
    expect(elements['project-instructions-read'].textContent).toBe('Latest submitted rules');
    context._openProjectInstructionsEditor();
    expect(elements['project-instructions-input'].value).toBe('Latest submitted rules');
  });

  it('does not apply an old save to a project reopened with newer persisted rules', async () => {
    const { context, elements } = mount('Original rules');
    let finish!: (result: unknown) => void;
    context.window.orkas.invoke = () => new Promise(resolve => { finish = resolve; });
    context._bindProjectInstructions();
    context._openProjectInstructionsEditor();
    elements['project-instructions-input'].value = 'Old submitted rules';
    const saving = elements['project-instructions-save-btn'].listeners.click();
    for (const [pid, content] of [['project_b', 'B rules'], ['project_a', 'New persisted A rules']]) {
      vm.runInContext(`_projectDetailPid = ${JSON.stringify(pid)}; _projectDetailMeta = { instructions: { content: ${JSON.stringify(content)} } }`, context);
      context._renderProjectInstructions();
    }
    finish({ ok: true });
    await saving;
    expect(elements['project-instructions-read'].textContent).toBe('New persisted A rules');
  });
});
