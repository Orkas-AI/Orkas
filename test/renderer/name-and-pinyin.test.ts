import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';


const nameLimitSource = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/modules/name-limit.js'), 'utf8',
);
const pinyinSource = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/modules/pinyin-firstletter.js'), 'utf8',
);

function loadNameLimit() {
  const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
  const range = { selectNodeContents: vi.fn(), collapse: vi.fn() };
  const windowObj = { getSelection: () => selection } as Record<string, unknown>;
  const sandbox = {
    window: windowObj,
    document: { createRange: () => range },
    Intl,
    Array,
    String,
    Number,
  };
  vm.runInNewContext(nameLimitSource, sandbox, { filename: 'name-limit.js' });
  return {
    api: windowObj as {
      NAME_DISPLAY_MAX_UNITS: number;
      nameDisplayWidth: (text: unknown) => number;
      limitNameDisplayText: (text: unknown, max?: number) => string;
      enforceNameLimitOnControl: (el: unknown, max?: number) => string;
      bindNameLimitControl: (el: unknown, max?: number) => void;
    },
    selection,
    range,
  };
}

function fakeControl({ value = '', editable = false } = {}) {
  const listeners = new Map<string, Array<() => void>>();
  const control = {
    dataset: {} as Record<string, string>,
    isContentEditable: editable,
    value,
    innerText: value,
    setSelectionRange: vi.fn(),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      const list = listeners.get(type) || [];
      list.push(listener);
      listeners.set(type, list);
    }),
  };
  return {
    control,
    emit: (type: string) => listeners.get(type)?.forEach((listener) => listener()),
  };
}

describe('renderer name length limit', () => {
  it('counts ASCII as one and wide graphemes as two', () => {
    const { api } = loadNameLimit();
    expect(api.NAME_DISPLAY_MAX_UNITS).toBe(60);
    expect(api.nameDisplayWidth('abc')).toBe(3);
    expect(api.nameDisplayWidth('中文')).toBe(4);
    expect(api.nameDisplayWidth('A中😀')).toBe(5);
  });

  it('keeps combining marks and joined emoji within one grapheme width', () => {
    const { api } = loadNameLimit();
    expect(api.nameDisplayWidth('e\u0301')).toBe(1);
    expect(api.nameDisplayWidth('👨‍👩‍👧‍👦')).toBe(2);
  });

  it('truncates at display width without splitting grapheme clusters', () => {
    const { api } = loadNameLimit();
    expect(api.limitNameDisplayText('ab中文c', 5)).toBe('ab中');
    expect(api.limitNameDisplayText(`a👨‍👩‍👧‍👦b`, 3)).toBe('a👨‍👩‍👧‍👦');
    expect(api.limitNameDisplayText('anything', 0)).toBe('');
  });

  it('enforces input and contenteditable values and restores the caret', () => {
    const { api, selection, range } = loadNameLimit();
    const input = fakeControl({ value: 'abc中文' }).control;
    expect(api.enforceNameLimitOnControl(input, 4)).toBe('abc');
    expect(input.value).toBe('abc');
    expect(input.setSelectionRange).toHaveBeenCalledWith(3, 3);

    const editable = fakeControl({ value: 'a中文', editable: true }).control;
    expect(api.enforceNameLimitOnControl(editable, 3)).toBe('a中');
    expect(editable.innerText).toBe('a中');
    expect(range.selectNodeContents).toHaveBeenCalledWith(editable);
    expect(selection.addRange).toHaveBeenCalledWith(range);
  });

  it('binds once and defers truncation until IME composition ends', () => {
    const { api } = loadNameLimit();
    const { control, emit } = fakeControl({ value: 'ok' });
    api.bindNameLimitControl(control, 2);
    api.bindNameLimitControl(control, 2);
    expect(control.addEventListener).toHaveBeenCalledTimes(3);

    emit('compositionstart');
    control.value = '中文';
    emit('input');
    expect(control.value).toBe('中文');
    emit('compositionend');
    expect(control.value).toBe('中');
  });
});

describe('renderer pinyin first-letter utility', () => {
  function load(dict?: { all: string }) {
    return vm.runInNewContext(
      `${pinyinSource}\n({ pinyinFirstLetter, pinyinSortKey })`,
      dict ? { pinyin_dict_firstletter: dict, String } : { String },
      { filename: 'pinyin-firstletter.js' },
    ) as {
      pinyinFirstLetter: (value: string) => string;
      pinyinSortKey: (value: string) => string;
    };
  }

  it('uses the vendor table for CJK and lowercases ASCII sort keys', () => {
    const api = load({ all: 'YB' });
    expect(api.pinyinFirstLetter('一')).toBe('y');
    expect(api.pinyinFirstLetter('丁')).toBe('b');
    expect(api.pinyinSortKey('A一丁')).toBe('ayb');
  });

  it('passes through out-of-range characters and tolerates a missing table', () => {
    const api = load({ all: 'Y' });
    expect(api.pinyinFirstLetter('A')).toBe('A');
    expect(api.pinyinFirstLetter('')).toBe('');
    expect(api.pinyinSortKey('Agent 2')).toBe('agent 2');

    const fallback = load();
    expect(fallback.pinyinSortKey('一A')).toBe('一a');
  });
});
