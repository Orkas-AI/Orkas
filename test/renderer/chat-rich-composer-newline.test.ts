import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// The chat composer is a contenteditable rich editor mirrored into a hidden
// textarea (conversation.js `_initMentionMirror`). These tests pin the
// value-round-trip invariants of its newline handling, which layout-free unit
// tests CAN check: that a trailing newline is preserved and rendered with a
// display-only "bogus" <br> filler, that the filler never leaks back into the
// serialized value, and that plain text gains no phantom trailing newline. The
// layout behaviors (the filler actually renders an empty line, the caret
// scrolls into view) are covered by the Electron reproduction, not here —
// jsdom/happy-dom aren't installed and do no layout anyway.
const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
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

function loadComposer() {
  const fns = [
    '_chatRichSerializeNode',
    '_chatRichTextLength',
    '_chatRichEnsureTrailingBreak',
    '_chatRichHandleEditorInput',
    '_chatRichRenderValue',
  ]
    .map(extractFunction)
    .join('\n\n');

  // A minimal fake DOM: just enough tree API for the extracted functions. No
  // layout — these assertions are all about the serialized character stream.
  const bootstrap = `
    const Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11 };
    class FakeNode {
      constructor(t) { this.nodeType = t; this.childNodes = []; this.parentNode = null; }
      appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; }
      removeChild(c) {
        const i = this.childNodes.indexOf(c);
        if (i >= 0) { this.childNodes.splice(i, 1); c.parentNode = null; }
        return c;
      }
    }
    class FakeText extends FakeNode { constructor(v) { super(3); this.nodeValue = String(v); } }
    class FakeEl extends FakeNode {
      constructor(tag) { super(1); this.tagName = String(tag).toUpperCase(); this.dataset = {}; }
      set textContent(v) {
        this.childNodes.forEach((c) => { c.parentNode = null; });
        this.childNodes = [];
        if (v) this.appendChild(new FakeText(v));
      }
      querySelector(sel) {
        if (sel !== 'br[data-chat-bogus="1"]') return null;
        const walk = (node) => {
          for (const c of node.childNodes) {
            if (c.nodeType === 1 && c.tagName === 'BR' && c.dataset.chatBogus === '1') return c;
            const f = walk(c);
            if (f) return f;
          }
          return null;
        };
        return walk(this);
      }
      countBogus() {
        let n = 0;
        const walk = (node) => {
          for (const c of node.childNodes) {
            if (c.nodeType === 1 && c.tagName === 'BR' && c.dataset.chatBogus === '1') n += 1;
            walk(c);
          }
        };
        walk(this);
        return n;
      }
    }
    const document = { createElement: (t) => new FakeEl(t), createTextNode: (v) => new FakeText(v) };
    const _findChatUseTokens = () => [];
    const _chatRichCreateUseChip = () => document.createElement('span');
    function makeEditor() { return new FakeEl('div'); }
  `;

  return vm.runInNewContext(`
    ${bootstrap}
    ${fns}
    ({
      serialize: (n) => _chatRichSerializeNode(n),
      textLength: (n) => _chatRichTextLength(n),
      render: (value) => { const e = makeEditor(); _chatRichRenderValue(e, value); return e; },
      ensure: (e) => _chatRichEnsureTrailingBreak(e),
      reconcileInput: (api) => _chatRichHandleEditorInput(api),
      makeEditor,
      makeText: (value) => document.createTextNode(value),
      makeBr: (bogus) => { const b = document.createElement('br'); if (bogus) b.dataset.chatBogus = '1'; return b; },
    });
  `, {});
}

describe('chat rich composer newline handling', () => {
  it('serializes a normal <br> as newline and a bogus filler <br> as nothing', () => {
    const c = loadComposer();
    expect(c.serialize(c.makeBr(false))).toBe('\n');
    expect(c.serialize(c.makeBr(true))).toBe('');
    expect(c.textLength(c.makeBr(true))).toBe(0);
    expect(c.textLength(c.makeBr(false))).toBe(1);
  });

  it('round-trips plain text with no phantom trailing newline and no filler', () => {
    const c = loadComposer();
    for (const value of ['', 'abc', 'a\nb', 'line one\nline two']) {
      const editor = c.render(value);
      expect(c.serialize(editor)).toBe(value);
      expect(editor.countBogus()).toBe(0);
    }
  });

  it('preserves a trailing newline and renders it with exactly one filler <br>', () => {
    const c = loadComposer();
    for (const value of ['abc\n', '\n', 'x\n\n', 'a\nb\n']) {
      const editor = c.render(value);
      // The filler makes the empty last line visible without altering the value.
      expect(c.serialize(editor)).toBe(value);
      expect(editor.countBogus()).toBe(1);
    }
  });

  it('keeps a single filler across repeated reconciles (idempotent, no drift)', () => {
    const c = loadComposer();
    const editor = c.render('abc\n');
    c.ensure(editor);
    c.ensure(editor);
    expect(editor.countBogus()).toBe(1);
    expect(c.serialize(editor)).toBe('abc\n');
  });

  it('drops the filler on the same editor when native input removes the trailing newline', () => {
    const c = loadComposer();
    const editor = c.render('abc\n');
    expect(editor.countBogus()).toBe(1);
    const text = editor.childNodes.find((node: any) => node.nodeType === 3);
    text.nodeValue = 'abc';
    let synced = '';

    c.reconcileInput({
      composing: false,
      ensureTrailingBreak: () => c.ensure(editor),
      syncFromEditor: () => { synced = c.serialize(editor); },
    });

    expect(synced).toBe('abc');
    expect(editor.countBogus()).toBe(0);
  });

  it('removes a stale filler when text is typed after a trailing newline', () => {
    const c = loadComposer();
    const editor = c.render('abc\n');
    editor.appendChild(c.makeText('x'));

    c.reconcileInput({
      composing: false,
      ensureTrailingBreak: () => c.ensure(editor),
      syncFromEditor: () => {},
    });

    expect(c.serialize(editor)).toBe('abc\nx');
    expect(editor.countBogus()).toBe(0);
  });
});
