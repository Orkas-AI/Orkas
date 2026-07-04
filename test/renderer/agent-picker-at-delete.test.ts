import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function simulatePickerSearchDelete(searchValue: string, key: string) {
  const consumeAt = extractFunction('_consumeAtKeyChar');
  const bindPickers = extractFunction('bindAgentPickers');
  return vm.runInNewContext(`
    let closed = 0;
    let prevented = false;
    let focused = false;
    const events = [];
    let _atKeyMark = { inputId: 'chat-input', posAfter: 1 };
    const searchInput = {
      value: ${JSON.stringify(searchValue)},
      handlers: {},
      addEventListener(type, fn) { this.handlers[type] = fn; },
    };
    const chatInput = {
      id: 'chat-input',
      value: '@',
      selectionStart: 1,
      selectionEnd: 1,
      setSelectionRange(start, end) {
        this.selectionStart = start;
        this.selectionEnd = end;
      },
      dispatchEvent(ev) { events.push(ev.type); },
      focus() { focused = true; },
    };
    class Event {
      constructor(type) { this.type = type; }
    }
    const document = {
      getElementById(id) {
        if (id === 'agent-picker-search') return searchInput;
        if (id === 'chat-input') return chatInput;
        return null;
      },
      querySelectorAll() { return []; },
      addEventListener() {},
    };
    const window = { addEventListener() {} };
    const _RECIPIENT_ANCHOR_PAIRS = [];
    function _closeAgentPicker() { closed += 1; }
    function _focusInput(input) { if (input) input.focus(); }
    function _renderAgentPickerList() {}
    function _moveAgentPickerTab() {}
    function _moveAgentPickerActive() {}
    function bindRecipientAnchor() {}
    function autoGrow() {}
    ${consumeAt}
    ${bindPickers}
    bindAgentPickers();
    searchInput.handlers.keydown({
      key: ${JSON.stringify(key)},
      isComposing: false,
      keyCode: 0,
      preventDefault() { prevented = true; },
    });
    ({ value: chatInput.value, closed, prevented, focused, events, mark: _atKeyMark });
  `, {});
}

describe('agent picker @ delete handling', () => {
  it('removes the typed @ and closes the picker when empty search handles Backspace', () => {
    expect(simulatePickerSearchDelete('', 'Backspace')).toEqual({
      value: '',
      closed: 1,
      prevented: true,
      focused: true,
      events: ['input'],
      mark: null,
    });
  });

  it('removes the typed @ and closes the picker when empty search handles Delete', () => {
    expect(simulatePickerSearchDelete('', 'Delete')).toMatchObject({
      value: '',
      closed: 1,
      prevented: true,
      focused: true,
      mark: null,
    });
  });

  it('does not consume @ while the picker search has text', () => {
    expect(simulatePickerSearchDelete('git', 'Backspace')).toMatchObject({
      value: '@',
      closed: 0,
      prevented: false,
      focused: false,
    });
  });
});
