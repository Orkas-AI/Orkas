import { afterEach, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const auto = require('../../src/renderer/modules/auto.js') as {
  _autoTaskMessagePreviewHtml: (task: unknown, maxLength?: number) => string;
  _autoComposerValueForTask: (task: unknown) => string;
};

const injectedGlobals = [
  '_chatUseTokenFor',
  '_renderChatUseMirrorHtml',
  'escapeHtml',
  't',
  'chatUseTextFromMessageParts',
  'formatChatUseTextForDisplay',
] as const;

afterEach(() => {
  for (const key of injectedGlobals) delete (globalThis as Record<string, unknown>)[key];
});

describe('automation task message preview', () => {
  it('renders persisted skill and connector refs inline with task content', () => {
    const globals = globalThis as Record<string, unknown>;
    globals.escapeHtml = (value: unknown) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    globals.t = (key: string, vars: Record<string, string>) => (
      key === 'skills.use_label'
        ? `Skill: ${vars.skill}`
        : `Connector: ${vars.connector}`
    );
    globals._chatUseTokenFor = (selection: { kind: string; name: string }) => (
      `[[${selection.kind}:${selection.name}]]`
    );
    globals._renderChatUseMirrorHtml = (
      text: string,
      renderPlain: (value: string) => string,
    ) => {
      let cursor = 0;
      let html = '';
      const re = /\[\[(skill|connector):([^\]]+)\]\]/g;
      for (const match of text.matchAll(re)) {
        const index = match.index || 0;
        html += renderPlain(text.slice(cursor, index));
        html += `<span class="chat-use-inline-chip is-${match[1]}">${renderPlain(match[2])}</span>`;
        cursor = index + match[0].length;
      }
      return html + renderPlain(text.slice(cursor));
    };

    const html = auto._autoTaskMessagePreviewHtml({
      content: 'Compare the latest campaign',
      skill: { id: 'brand-research', name: 'Brand Research' },
      connector: { id: 'drive', name: 'Google Drive' },
    });

    expect(html).toContain('chat-use-inline-chip is-skill');
    expect(html).toContain('Brand Research');
    expect(html).toContain('chat-use-inline-chip is-connector');
    expect(html).toContain('Google Drive');
    expect(html).toContain('Compare the latest campaign');
    expect(html.indexOf('Brand Research')).toBeLessThan(html.indexOf('Compare the latest campaign'));
    expect(html.indexOf('Google Drive')).toBeLessThan(html.indexOf('Compare the latest campaign'));
  });

  it('truncates only message text without cutting inline resource tokens', () => {
    const globals = globalThis as Record<string, unknown>;
    globals.escapeHtml = (value: unknown) => String(value ?? '');
    globals.t = () => '';
    globals._chatUseTokenFor = (selection: { kind: string; name: string }) => (
      `[[${selection.kind}:${selection.name}]]`
    );
    globals._renderChatUseMirrorHtml = (text: string) => text;

    expect(auto._autoTaskMessagePreviewHtml({
      content: '123456789',
      skill: { id: 'reader', name: 'Reader' },
    }, 5)).toBe('[[skill:Reader]] 12345…');
  });

  it('keeps multiple resources in their original positions for list and edit views', () => {
    const globals = globalThis as Record<string, unknown>;
    globals.escapeHtml = (value: unknown) => String(value ?? '');
    globals.t = () => '';
    globals._chatUseTokenFor = (selection: { kind: string; name: string }) => (
      `[[${selection.kind}:${selection.name}]]`
    );
    globals.chatUseTextFromMessageParts = (parts: Array<Record<string, string>>) => parts.map((part) => (
      part.type === 'text' ? part.text : `[[${part.kind}:${part.name}]]`
    )).join('');
    globals._renderChatUseMirrorHtml = (text: string, renderPlain: (value: string) => string) => (
      renderPlain(text).replace(
        /\[\[(skill|connector):([^\]]+)\]\]/g,
        '<span class="chat-use-inline-chip is-$1">$2</span>',
      )
    );

    const task = {
      content: 'bird utility bill',
      // First refs remain for legacy clients but must not override the ordered parts.
      skill: { id: 'brand-research', name: 'Brand Research' },
      connector: { id: 'github', name: 'GitHub' },
      message_parts: [
        { type: 'use', kind: 'skill', id: 'brand-research', name: 'Brand Research' },
        { type: 'text', text: ' bird ' },
        { type: 'use', kind: 'skill', id: 'content-writer', name: 'Content Writer' },
        { type: 'text', text: ' utility bill ' },
        { type: 'use', kind: 'connector', id: 'github', name: 'GitHub' },
      ],
    };

    const composerValue = auto._autoComposerValueForTask(task);
    expect(composerValue).toBe(
      '[[skill:Brand Research]] bird [[skill:Content Writer]] utility bill [[connector:GitHub]]',
    );

    const html = auto._autoTaskMessagePreviewHtml(task);
    const orderedValues = ['Brand Research', 'bird', 'Content Writer', 'utility bill', 'GitHub'];
    let cursor = -1;
    for (const value of orderedValues) {
      const next = html.indexOf(value);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
  });
});
