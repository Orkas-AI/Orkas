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

  async dispatch(type: string, ev: any = {}) {
    if (this.disabled && type === 'click') return;
    await Promise.all((this.listeners.get(type) || []).map((fn) => fn(ev)));
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
    selects: [],
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
    _aiSelectMount: (host: FakeElement) => {
      let value = '';
      const trigger = new FakeElement('button');
      trigger.className = 'ai-select-trigger';
      host.appendChild(trigger);
      const api = {
        options: [] as Array<{ value: string; label?: string }>,
        setOptions: (options: Array<{ value: string; label?: string }>, state: { value?: string } = {}) => {
          api.options = options;
          value = typeof state.value === 'string' ? state.value : '';
        },
        setValue: (next: string) => { value = next; },
        getValue: () => value,
        onChange: () => {},
      };
      context.selects.push(api);
      return api;
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
  it('preserves selection order across file fields, upload completion and draft rerender', async () => {
    const context = loadFormModule();
    const releases = new Map<string, () => void>();
    let picked = ['z-first.png', 'm-second.png'];
    context.window.orkas = { invoke: async () => ({ files: picked.map((name) => ({ name,
      arrayBuffer: async () => new Uint8Array([1]).buffer })) }) };
    context.apiFetch = async (_url: string, opts: any) => {
      const name = decodeURIComponent(opts.headers['X-Filename']);
      await new Promise<void>((resolve) => releases.set(name, resolve));
      return { json: async () => ({ ok: true, info: { name } }) };
    };
    const form = { form_id: 'order1234', fields: [
      { id: 'a', type: 'file', multiple: true }, { id: 'b', type: 'file', multiple: true },
    ] };
    const submissions: any[] = [];
    const opts = { cid: 'order', onSubmit: (_text: string, values: any, attachments: string[]) => submissions.push({ values, attachments }) };
    const container = new FakeElement('div');
    context.window.renderChatInputForm(container, { form }, opts);
    const pickers = container.querySelectorAll('button').filter((button) => button.className.includes('file-picker'));
    const pick = async (index: number) => {
      await pickers[index].dispatch('click');
    };
    await pick(1);
    picked = ['a-third.png'];
    await pick(0);
    for (const name of ['a-third.png', 'm-second.png', 'z-first.png']) releases.get(name)!();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const restored = new FakeElement('div');
    context.window.renderChatInputForm(restored, { form }, opts);
    await restored.querySelectorAll('button').find((button) => button.textContent === 'Submit')!.dispatch('click');
    expect(submissions).toEqual([{ values: { a: ['a-third.png'], b: ['z-first.png', 'm-second.png'] },
      attachments: ['z-first.png', 'm-second.png', 'a-third.png'] }]);
  });

  describe('PC unanswered values', () => {
    it('requires actual answers for missing typed values and preserves zero and false', async () => {
      const context = loadFormModule();
      const container = new FakeElement('div');
      const submissions: any[] = [];
      const form = { form_id: 'typed1234', agent_id: 'writer', fields: [
        { id: 'count', label: 'Count', type: 'number', required: true, min: 0 },
        { id: 'confirmed', label: 'Confirmed', type: 'boolean', required: true },
        { id: 'choice', label: 'Choice', type: 'select', required: true, options: [{ value: 'a', label: 'A' }] },
      ] };
      context.window.renderChatInputForm(container, { form }, {
        cid: 'typed', onSubmit: (_text: string, values: unknown) => submissions.push(values),
      });
      const submit = container.querySelectorAll('button').find(b => b.textContent === 'Submit')!;
      await submit.dispatch('click');
      expect(submissions).toEqual([]);
      expect(container.querySelectorAll('input')[0].value).toBe('');
      expect(context.selects).toHaveLength(2);
      container.querySelectorAll('input')[0].value = '0';
      context.selects[1].setValue('a');
      await submit.dispatch('click');
      expect(submissions).toEqual([]);
      context.selects[0].setValue('false');
      // A normal edit saves all current answers. Rerendering must retain an
      // explicit false, rather than treating it as an unanswered question.
      await container.querySelectorAll('input')[0].dispatch('input');
      const rerendered = new FakeElement('div');
      context.window.renderChatInputForm(rerendered, { form }, {
        cid: 'typed', onSubmit: (_text: string, values: unknown) => submissions.push(values),
      });
      expect(rerendered.querySelectorAll('input')[0].value).toBe('0');
      expect(context.selects[2].getValue()).toBe('false');
      await rerendered.querySelectorAll('button').find(b => b.textContent === 'Submit')!.dispatch('click');
      expect(submissions).toEqual([{ count: 0, confirmed: false, choice: 'a' }]);
    });

    it('does not restore a cleared numeric default or convert an optional blank to zero', async () => {
      const context = loadFormModule();
      const container = new FakeElement('div');
      const submissions: any[] = [];
      const form = { form_id: 'number1234', agent_id: 'writer', fields: [
        { id: 'count', label: 'Count', type: 'number', required: true, default: 4, min: 0 },
        { id: 'optional', label: 'Optional', type: 'number' },
      ] };
      context.window.renderChatInputForm(container, { form }, {
        cid: 'numbers', onSubmit: (_text: string, values: unknown) => submissions.push(values),
      });
      const number = container.querySelectorAll('input')[0];
      const submit = container.querySelectorAll('button').find(b => b.textContent === 'Submit')!;
      for (const value of ['', 'Infinity', '-1']) {
        number.value = value;
        await submit.dispatch('click');
        expect(submissions).toEqual([]);
      }
      number.value = '0';
      await submit.dispatch('click');
      expect(submissions).toEqual([{ count: 0, optional: null }]);
    });

    it('preserves declared defaults while leaving an optional boolean unanswered', async () => {
      const context = loadFormModule();
      const container = new FakeElement('div');
      const submissions: any[] = [];
      context.window.renderChatInputForm(container, { form: {
        form_id: 'defaults1234', agent_id: 'writer', fields: [
          { id: 'count', label: 'Count', type: 'number', required: true, default: 0 },
          { id: 'confirmed', label: 'Confirmed', type: 'boolean', required: true, default: false },
          { id: 'choice', label: 'Choice', type: 'select', default: 'b', options: [{ value: 'a' }, { value: 'b' }] },
          { id: 'unknown', label: 'Unknown', type: 'boolean' },
        ],
      } }, { cid: 'defaults', onSubmit: (_text: string, values: unknown) => submissions.push(values) });
      await container.querySelectorAll('button').find(b => b.textContent === 'Submit')!.dispatch('click');
      expect(submissions).toEqual([{ count: 0, confirmed: false, choice: 'b', unknown: null }]);
    });

  });

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

  it('unlocks after an async rejection and allows the corrected form to be retried', async () => {
    const context = loadFormModule();
    const container = new FakeElement('div');
    let attempts = 0;

    context.window.renderChatInputForm(container, baseMessage, {
      cid: 'c1',
      onSubmit: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Directory does not exist');
      },
    });

    const input = container.querySelectorAll('input')[0];
    const buttons = container.querySelectorAll('button');
    const submit = buttons.find((btn) => btn.textContent === 'Submit')!;
    const reset = buttons.find((btn) => btn.textContent === 'Reset')!;
    input.value = 'relative/project';

    await submit.dispatch('click');

    expect(attempts).toBe(1);
    expect(submit.disabled).toBe(false);
    expect(reset.disabled).toBe(false);
    expect(input.disabled).toBe(false);
    expect(container.innerHTML).toContain('Directory does not exist');

    input.value = '/tmp/existing-project';
    await submit.dispatch('click');

    expect(attempts).toBe(2);
    expect(submit.disabled).toBe(true);
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

  it('renders and submits revision feedback beside a VideoStudio draft decision', () => {
    const context = loadFormModule();
    const container = new FakeElement('div');
    const submissions: any[] = [];
    const message = {
      form: {
        form_id: 'draft1234',
        agent_id: '79df9cc89f5f',
        fields: [
          {
            id: 'gate_d_decision',
            label: '是否批准当前草稿，并导出最终版视频？',
            type: 'select',
            required: true,
            default: 'revise',
            options: [
              { value: 'approve', label: '批准并导出' },
              { value: 'revise', label: '先修改草稿' },
            ],
          },
          {
            id: 'adjustments',
            label: '修改意见（选择修改时填写）',
            type: 'textarea',
            required: false,
            default: '',
          },
        ],
      },
    };

    context.window.renderChatInputForm(container, message, {
      cid: 'c1',
      onSubmit: (encoded: string, values: Record<string, unknown>) => submissions.push({ encoded, values }),
    });

    const feedback = container.querySelectorAll('textarea')[0];
    expect(feedback).toBeDefined();
    feedback.value = '把结尾字幕停留时间延长两秒';
    feedback.dispatch('input');
    container.querySelectorAll('button').find((btn) => btn.textContent === 'Submit')?.dispatch('click');

    expect(submissions).toHaveLength(1);
    expect(submissions[0].values).toEqual({
      gate_d_decision: 'revise',
      adjustments: '把结尾字幕停留时间延长两秒',
    });
    expect(submissions[0].encoded).toContain('- 修改意见（选择修改时填写）：把结尾字幕停留时间延长两秒');
  });
});
