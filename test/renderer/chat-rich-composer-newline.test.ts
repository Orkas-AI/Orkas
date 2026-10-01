import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function model(tokens: Array<{ raw: string; selection: object }> = []) {
  const context = vm.createContext({
    _findChatComposerTokens: (text: string) => tokens.flatMap(token => {
      const matches = [];
      let pos = 0;
      while ((pos = text.indexOf(token.raw, pos)) >= 0) {
        matches.push({ ...token, start: pos, end: pos + token.raw.length });
        pos += token.raw.length;
      }
      return matches;
    }).sort((a, b) => a.start - b.start),
  });
  vm.runInContext(readFileSync(path.join(__dirname, '../../src/renderer/vendor/prosemirror/prosemirror.min.js'), 'utf8'), context);
  vm.runInContext(readFileSync(path.join(__dirname, '../../src/renderer/modules/composer-input.js'), 'utf8'), context);
  return vm.runInContext(`({
    parse: text => _composerDocument(text, 'new-chat-input'),
    text: _composerDocumentText, position: _composerPosition, offset: _composerRawOffset,
    state: doc => OrkasEditor.EditorState.create({doc, plugins: [OrkasEditor.history()]}),
    undo: OrkasEditor.undo, redo: OrkasEditor.redo,
  })`, context);
}

describe('composer document preserves the authored text', () => {
  it.each(['', 'abc', '\n', '\n\n', 'abc\n', 'a\nb\n', 'a\n\nb', ' 中文\t😀 café é ',
    '\\(x^2+y^2=z^2\\)\n$$\\frac{1}{2}$$\n', '```js\nconst x = "@literal"\n```\n',
    '<img src=x onerror=alert(1)>\n<script>literal</script>', 'a\u2063broken\u2062token'])
  ('round-trips %j without phantom newlines or whitespace normalization', text => {
    const m = model();
    const doc = m.parse(text);
    expect(m.text(doc)).toBe(text);
    expect(doc.childCount).toBe(text.split('\n').length);
    for (let offset = 0; offset <= text.length; offset++) {
      expect(m.offset(doc, m.position(doc, offset))).toBe(offset);
    }
  });

  it('preserves consecutive atomic tokens, their exact wire payload and a selected edge', () => {
    const a = { raw: '@Commander', selection: { kind: 'commander', id: '' } };
    const b = { raw: '\u2063Skill: 中文 \u2062\u200b\u200c\u2064', selection: { kind: 'skill', id: 'fixture' } };
    const m = model([a, b]);
    const text = `before ${a.raw}${b.raw} after\n`;
    const doc = m.parse(text);
    expect(m.text(doc)).toBe(text);
    const start = 'before '.length;
    const at = m.position(doc, start);
    expect(m.position(doc, start + a.raw.length)).toBe(at + 1);
    expect(m.position(doc, start + 2, -1)).toBe(at);
    expect(m.position(doc, start + 2, 1)).toBe(at + 1);
    expect(m.offset(doc, at + 1)).toBe(start + a.raw.length);
    let state = m.state(doc);
    state = state.apply(state.tr.delete(at, at + 2));
    expect(m.text(state.doc)).toBe('before  after\n');
    expect(m.undo(state, (tr: any) => { state = state.apply(tr); })).toBe(true);
    expect(m.text(state.doc)).toBe(text);
    expect(m.redo(state, (tr: any) => { state = state.apply(tr); })).toBe(true);
    expect(m.text(state.doc)).toBe('before  after\n');
  });

  it('keeps a resource name containing newlines inside one indivisible token', () => {
    const raw = '@{skill:line one\nline two}';
    const m = model([{ raw, selection: { kind: 'skill', id: 'multiline' } }]);
    const text = `${raw}\ntail\n`;
    const doc = m.parse(text);
    expect(m.text(doc)).toBe(text);
    expect(doc.childCount).toBe(3);
    expect(doc.firstChild.childCount).toBe(1);
    expect(m.offset(doc, m.position(doc, raw.length))).toBe(raw.length);
  });

  it('retains a snapshot across edits to a 5000-line draft and clamps stale selections', () => {
    const m = model();
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i}: 中文😀`).join('\n');
    const doc = m.parse(text);
    let state = m.state(doc);
    state = state.apply(state.tr.insertText('X', 1));
    expect(m.text(doc)).toBe(text);
    expect(m.text(state.doc)).toBe(`X${text}`);
    expect(state.doc.child(4000)).toBe(doc.child(4000));
    expect(m.position(doc, -50)).toBe(1);
    expect(m.offset(doc, m.position(doc, Number.MAX_SAFE_INTEGER))).toBe(text.length);
  });
});
