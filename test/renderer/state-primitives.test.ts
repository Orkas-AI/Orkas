import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/state.js'), 'utf8');

function extractFunction(name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe('shared Renderer state primitives', () => {
  it('inserts a newline at the current selection for Ctrl/Cmd+Enter', () => {
    const dispatched = vi.fn();
    const sandbox: any = { Event };
    vm.createContext(sandbox);
    vm.runInContext([
      extractFunction('_insertComposerNewline'),
      extractFunction('_handleModifiedComposerEnter'),
    ].join('\n'), sandbox);
    const input = {
      value: 'abc',
      selectionStart: 1,
      selectionEnd: 2,
      dispatchEvent: dispatched,
    };
    const preventDefault = vi.fn();

    expect(sandbox._handleModifiedComposerEnter({
      key: 'Enter',
      ctrlKey: true,
      metaKey: false,
      currentTarget: input,
      preventDefault,
    })).toBe(true);
    expect(input.value).toBe('a\nc');
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(dispatched).toHaveBeenCalledOnce();
    expect(dispatched.mock.calls[0][0]).toMatchObject({ type: 'input', bubbles: true });
  });

  it('recognizes only unmodified Enter as the send gesture', () => {
    const sandbox: any = {};
    vm.createContext(sandbox);
    vm.runInContext(extractFunction('_isPlainComposerEnter'), sandbox);

    expect(sandbox._isPlainComposerEnter({
      key: 'Enter',
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    })).toBe(true);
    for (const modifier of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey']) {
      expect(sandbox._isPlainComposerEnter({
        key: 'Enter',
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        [modifier]: true,
      })).toBe(false);
    }
    expect(sandbox._isPlainComposerEnter({ key: 'a' })).toBe(false);
  });

  it('keeps group activity scoped to a non-empty conversation id', () => {
    const sandbox: any = { groupBusyConvs: new Map() };
    vm.createContext(sandbox);
    vm.runInContext([
      extractFunction('isGroupConversationBusy'),
      extractFunction('setGroupConversationBusy'),
    ].join('\n'), sandbox);

    sandbox.setGroupConversationBusy('', true);
    sandbox.setGroupConversationBusy('conversation-a', true);
    expect(sandbox.groupBusyConvs.size).toBe(1);
    expect(sandbox.isGroupConversationBusy('conversation-a')).toBe(true);
    sandbox.setGroupConversationBusy('conversation-a', false);
    expect(sandbox.isGroupConversationBusy('conversation-a')).toBe(false);
  });
});
