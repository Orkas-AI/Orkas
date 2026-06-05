import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

class FakeClassList {
  private readonly items = new Set<string>();

  add(...names: string[]) {
    for (const name of names) this.items.add(name);
  }

  remove(...names: string[]) {
    for (const name of names) this.items.delete(name);
  }

  contains(name: string) {
    return this.items.has(name);
  }
}

class FakeElement {
  readonly tagName: string;
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  className = '';
  classList = new FakeClassList();
  textContent = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  type = '';
  value = '';
  placeholder = '';
  disabled = false;
  rows = 0;
  min = '';
  max = '';
  checked = false;
  multiple = false;
  accept = '';

  private listeners = new Map<string, Array<(ev?: any) => void>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  set innerHTML(value: string) {
    if (value === '') this.children = [];
  }

  get innerHTML() {
    return this.children.map((c) => c.textContent).join('');
  }

  setAttribute(name: string, value: string) {
    (this as any)[name] = value;
  }

  removeAttribute(name: string) {
    delete (this as any)[name];
  }

  addEventListener(type: string, fn: (ev?: any) => void) {
    const arr = this.listeners.get(type) || [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  dispatch(type: string, ev: any = {}) {
    if (this.disabled && type === 'click') return;
    for (const fn of this.listeners.get(type) || []) fn(ev);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const tags = new Set(selector.split(',').map((s) => s.trim().toUpperCase()));
    const out: FakeElement[] = [];
    const visit = (el: FakeElement) => {
      for (const child of el.children) {
        if (tags.has(child.tagName)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
}

function loadFormModule() {
  const context: any = {
    console,
    Date,
    JSON,
    Array,
    String,
    Number,
    Object,
    Map,
    Set,
    Math,
    t: (key: string, vars?: Record<string, unknown>) => ({
      'chat.form.title': 'Form',
      'chat.form.readonly_title': 'Submitted form',
      'chat.form.submit': 'Submit',
      'chat.form.reset': 'Reset',
      'chat.form.required_text': 'Required',
      'chat.form.errors_prefix': `${vars?.label}: ${vars?.msg}`,
      'chat.form.file_uploading_wait': 'Uploading',
      'chat.form.empty_value': '(empty)',
      'chat.form.boolean_on': 'Yes',
      'chat.form.submitted_no_time': 'Submitted',
    }[key] || key),
    document: {
      createElement: (tag: string) => new FakeElement(tag),
      createElementNS: (_ns: string, tag: string) => new FakeElement(tag),
    },
    window: {},
  };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/chat-input-form.js'), 'utf8');
  vm.runInContext(source, context);
  return context;
}

const baseMessage = {
  form: {
    form_id: 'abc12345',
    agent_id: 'agent-a',
    fields: [
      { id: 'topic', label: 'Topic', type: 'text', required: true },
    ],
  },
};

describe('chat input form widget', () => {
  it('blocks required empty text fields before submit', () => {
    const context = loadFormModule();
    const container = new FakeElement('div');
    const submissions: any[] = [];

    context.window.renderChatInputForm(container, baseMessage, {
      cid: 'c1',
      onSubmit: (encoded: string, values: Record<string, unknown>) => submissions.push({ encoded, values }),
    });

    const submit = container.querySelectorAll('button').find((btn) => btn.textContent === 'Submit');
    submit?.dispatch('click');

    expect(submissions).toEqual([]);
    expect(container.innerHTML).toContain('Topic: Required');
  });

  it('locks the form immediately so double-click submit sends once', () => {
    const context = loadFormModule();
    const container = new FakeElement('div');
    const submissions: any[] = [];

    context.window.renderChatInputForm(container, baseMessage, {
      cid: 'c1',
      onSubmit: (encoded: string, values: Record<string, unknown>) => submissions.push({ encoded, values }),
    });

    const input = container.querySelectorAll('input')[0];
    const submit = container.querySelectorAll('button').find((btn) => btn.textContent === 'Submit');
    input.value = 'growth review';
    input.dispatch('input');
    submit?.dispatch('click');
    submit?.dispatch('click');

    expect(submissions).toHaveLength(1);
    expect(submissions[0].values).toEqual({ topic: 'growth review' });
    expect(submissions[0].encoded).toContain('<agent-input-submission form_id="abc12345" agent_id="agent-a">');
  });

  it('leaves optional blank fields empty in the visible submission summary', () => {
    const context = loadFormModule();
    const encoded = context.window.encodeChatFormSubmission({
      form_id: 'abc12345',
      agent_id: 'agent-a',
      fields: [
        { id: 'answer', label: 'Answer', type: 'textarea', required: true },
        { id: 'note', label: 'Note', type: 'textarea', required: false, default: '' },
        { id: 'tags', label: 'Tags', type: 'multiselect', required: false, default: [], options: [{ value: 'x', label: 'X' }] },
      ],
    }, { answer: '42', note: '', tags: [] });

    expect(encoded).toContain('- Answer：42');
    expect(encoded).toContain('- Note：\n');
    expect(encoded).toContain('- Tags：\n');
    expect(encoded).not.toContain('unfilled');
    expect(encoded).not.toContain('undefined');
  });
});
