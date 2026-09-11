import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');

function pickerHarness(anchorId: string, atKey: boolean) {
  class Element {
    dataset: Record<string, string> = {};
    style = { display: 'none' };
    attributes: Record<string, string> = {};
    children: Element[] = [];
    className = '';
    innerHTML = '';
    hidden = true;
    parent: Element | null = null;
    handlers: Record<string, Function> = {};
    classList = { add: (name: string) => { this.className += ` ${name}`; } };
    setAttribute(name: string, value: string) { this.attributes[name] = value; }
    addEventListener(name: string, fn: Function) { this.handlers[name] = fn; }
    appendChild(child: Element) { child.parent = this; this.children.push(child); }
    replaceChildren() { this.children = []; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
    querySelector(selector: string) { return this.children.find((c) => c.className.split(' ').includes(selector.slice(1))) || null; }
    querySelectorAll() { return this.children; }
    focus() {}
    click() { return this.handlers.click?.({ stopPropagation() {}, detail: 1 }); }
  }
  const picker = new Element();
  picker.dataset.anchorId = anchorId;
  const list = new Element();
  for (const id of ['__commander__', 'codex', 'writer']) {
    const row = new Element();
    row.dataset.id = id;
    row.dataset.kind = 'agent';
    list.appendChild(row);
  }
  const header = new Element();
  const input = {
    value: '@Codex work @',
    setSelectionRange() {},
    dispatchEvent() {},
  };
  const inputId = anchorId === 'new-chat-recipient-chip' ? 'new-chat-input'
    : anchorId === 'project-chat-recipient-chip' ? 'project-chat-input' : 'chat-input';
  const elements: Record<string, any> = {
    'agent-picker': picker, 'agent-picker-list': list, 'agent-picker-selected': header,
    [inputId]: input,
  };
  const selected = [
    { kind: 'commander', id: '', name: '' },
    { kind: 'agent', id: 'codex', name: 'Codex' },
  ];
  const context: any = {
    createLogger: () => ({}),
    document: { getElementById: (id: string) => elements[id] || null, createElement: () => new Element() },
    t: (key: string) => key === 'chat.recipient_commander' ? 'Commander' : 'Remove',
    escapeHtml: (s: string) => s,
    _composerSelectedRecipients: vi.fn(() => selected),
    _toggleComposerRecipient: vi.fn(),
    setTimeout: (fn: Function) => fn(),
    Event: class {},
    addEventListener() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  if (atKey) vm.runInContext(`_atKeyMark = { inputId: ${JSON.stringify(inputId)}, posAfter: ${input.value.length} };`, context);
  context._refreshAgentPickerSelection();
  return { context, list, header, input, picker };
}

describe('agent picker selection display', () => {
  it.each([
    ['chat-recipient-chip', 'conversation'],
    ['new-chat-recipient-chip', 'new-chat'],
    ['project-chat-recipient-chip', 'project'],
  ])('shows existing recipients through both entry points for %s', (anchor, target) => {
    for (const atKey of [false, true]) {
      const { context, list, header } = pickerHarness(anchor, atKey);
      expect(context._composerSelectedRecipients).toHaveBeenCalledWith(target);
      expect(header.hidden).toBe(false);
      expect(header.children.map((el) => el.dataset.recipientId)).toEqual(['__commander__', 'codex']);
      expect(list.children.map((el) => el.attributes['aria-checked'])).toEqual(['true', 'true', 'false']);
      expect(list.children.map((el) => !!el.querySelector('.recipient-picker-check'))).toEqual([true, true, false]);
    }
  });

  it('removes a header recipient instead of completing the pending @ with it', async () => {
    const { context, header, input } = pickerHarness('new-chat-recipient-chip', true);
    await header.children[1].click();
    expect(context._toggleComposerRecipient).toHaveBeenCalledWith('new-chat', {
      kind: 'agent', id: 'codex', name: 'Codex',
    });
    expect(input.value).toBe('@Codex work ');
    expect(vm.runInContext('_atKeyMark', context)).toBeNull();
  });

  it('keeps Enter on a focused autocomplete result as selection', () => {
    const { list } = pickerHarness('new-chat-recipient-chip', true);
    const select = vi.fn();
    list.children[2].handlers.click = select;
    list.children[2].handlers.keydown({ key: 'Enter', preventDefault() {} });
    expect(select).toHaveBeenCalledOnce();
  });

  it('keeps automation outside the multi-recipient display', () => {
    const { context, header, list } = pickerHarness('auto-recipient-chip', false);
    expect(context._composerSelectedRecipients).not.toHaveBeenCalled();
    expect(header.hidden).toBe(true);
    expect(list.children.every((el) => !el.attributes['aria-checked'])).toBe(true);
  });
});
