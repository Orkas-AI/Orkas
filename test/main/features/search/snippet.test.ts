import { describe, expect, it } from 'vitest';
import { makeSnippet, projectChatSnippet } from '../../../../src/main/features/search/snippet';
import { tokenize } from '../../../../src/main/features/search/tokenize';

// Frozen pre-optimization display contract, independent of the lazy reader.
function formerSnippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, ' '), lower = flat.toLowerCase();
  let at = -1, width = 0;
  for (const token of tokenize(query)) {
    const candidate = lower.indexOf(token);
    if (candidate >= 0 && (at < 0 || candidate < at)) { at = candidate; width = token.length; }
  }
  if (at < 0) return flat.slice(0, 120);
  const start = Math.max(0, at - 60), end = Math.min(flat.length, at + width + 60);
  return (start ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

describe('search snippet compatibility', () => {
  it('preserves first-token windows, whitespace, Unicode and unmatched prefixes across lazy parts', () => {
    const atoms = ['', ' \t\n', '搜索资料', 'Orkas', 'İstanbul', '🧾', 'prefix '.repeat(25), 'tail '.repeat(25)];
    for (const a of atoms) for (const b of atoms) for (const c of ['', ' 搜索 Orkas ', '   tail']) {
      const parts = [a, b, c];
      const complete = parts.filter(Boolean).join('\n');
      for (const query of ['搜索', 'Orkas', 'tail', 'missing', '搜索 Orkas', 'the']) {
        expect(makeSnippet(parts, tokenize(query))).toBe(formerSnippet(complete, query));
      }
    }
  });

  it('stops projecting an execution trail once both display windows are determined', () => {
    const event = (output: string) => ({ type: 'event', event: { stream: 'tool', data: { output } } });
    const text = 'needle ' + 'visible '.repeat(30);
    const first = event('needle ' + 'evidence '.repeat(30));
    const unused = { type: 'event', get event(): never { throw new Error('Unneeded large execution payload was expanded'); } };
    expect(projectChatSnippet({ id: 'm1', text, process: [first, unused] }, ['needle'])).toEqual({
      visible: true, msg_id: 'm1', has_process: true,
      snippet: formerSnippet(text, 'needle'),
      process_snippet: formerSnippet('[process 0] ' + first.event.data.output, 'needle'),
    });
  });

  it('keeps the earliest best public process hit and omits private reasoning and inline media', () => {
    const process = [
      { type: 'event', event: { stream: 'thinking', data: { output: 'alpha beta private' } } },
      { type: 'progress', text: 'alpha only' },
      { type: 'event', event: { stream: 'tool', data: { output: 'alpha beta evidence' } } },
      { type: 'progress', text: 'alpha beta later tie' },
    ];
    const result = projectChatSnippet({ text: 'Done', process }, ['alpha', 'beta']);
    expect(result?.process_snippet).toBe('[process 2] alpha beta evidence');
    expect(result?.snippet).not.toContain('private');
    expect(projectChatSnippet({ content: 'photo data:image/png;base64,c2VjcmV0' }, ['photo'])?.snippet)
      .toBe('photo [inline image/png data omitted from history]');
    expect(projectChatSnippet({ text: 'hidden', dispatch: true }, ['hidden'])?.visible).toBe(false);
    expect(projectChatSnippet({ text: 'deleted', deleted_at: 't' }, ['deleted'])?.visible).toBe(false);
    expect(projectChatSnippet({ text: ' \n\t ' }, [])?.visible).toBe(false);
  });
});
