import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const skillsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/chat-use.js'), 'utf8');
const conversationSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const composerHelpers = [
  ['const _MENTION_FALLBACK_CLASS', 'function _highlightMentionsIn'],
  ['function _quotedLineRanges', 'function _composerDispatchShape'],
  ['function _resolvedMentionSpans', 'function _explicitMentionRecipients'],
  ['function _findChatComposerTokens', 'function _chatRichChipsMatchValue'],
].map(([start, end]) => {
  const from = conversationSource.indexOf(start);
  const to = conversationSource.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error('missing composer helper block');
  return conversationSource.slice(from, to);
}).join('\n');

function loadChatUseHelpers() {
  const start = skillsSource.indexOf('// ─── Chat-input inline use chips');
  const end = skillsSource.indexOf('// Chat composers are part of the startup shell', start);
  if (start < 0 || end < 0) throw new Error('missing chat use helper block');
  const block = skillsSource.slice(start, end);
  return vm.runInNewContext(`
    const currentCid = '';
    const _COMMANDER = { kind: 'commander', id: '', name: '' };
    const _agentsCache = [
      { agent_id: 'cli', name: 'Orkas Codex' },
      { agent_id: 'writer', name: '写作助手' },
      { agent_id: 'disabled', name: 'Disabled', enabled: false },
    ];
    function _saveDraft() {}
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[ch]);
    }
    function t(key, vars = {}) {
      const table = {
        'connectors.use_label': 'Connector: {connector}',
        'connectors.use_prefix': 'Use {connector} connector: {content}',
        'connectors.inline_text': '{connector} connector',
        'skills.use_label': 'Skill: {skill}',
        'skills.use_prefix': 'Use {skill} skill: {content}',
        'skills.inline_text': '{skill} skill',
        'chat.recipient_commander': 'Commander',
      };
      let text = table[key] || key;
      for (const [k, v] of Object.entries(vars)) text = text.replaceAll('{' + k + '}', String(v));
      return text;
    }
    const document = { getElementById: () => null, querySelectorAll: () => [] };
    ${fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/strip-structural-blocks.js'), 'utf8')}
    ${block}
    ${composerHelpers}
    ({
      normalize: _normalizeChatUseSelection,
      normalizeMany: _normalizeChatUseSelections,
      tokenFor: _chatUseTokenFor,
      tokens: _findChatUseTokens,
      composerTokens: _findChatComposerTokens,
      partsFromText: chatUseMessagePartsFromText,
      textFromParts: chatUseTextFromMessageParts,
      transform: transformWithChatUse,
      display: formatChatUseTextForDisplay,
      mirror: _renderChatUseMirrorHtml,
      deleteRange: _chatUseTokenDeleteRange,
      moveTarget: _chatUseTokenMoveTarget,
      titleSeed: _titleSeedWithoutRoutingMentions,
    });
  `, {});
}

describe('chat use inline chips', () => {
  it('serializes multiple skill and connector tokens into localized plain text', () => {
    const h = loadChatUseHelpers();
    const text = [
      'Compare with',
      h.tokenFor({ kind: 'skill', id: 'research', name: 'Research' }),
      'and',
      h.tokenFor({ kind: 'connector', id: 'drive', name: 'Google Drive' }),
    ].join(' ');

    expect(h.transform(text)).toBe('Compare with Research skill and Google Drive connector');
  });

  it('keeps token visible text close to the rendered chip label for caret alignment', () => {
    const h = loadChatUseHelpers();
    const token = h.tokenFor({ kind: 'connector', name: 'Bing Webmaster Tools' });

    expect(token).toContain('Connector: Bing Webmaster Tools');
    expect(token).not.toContain('@{connector:');
    expect(h.transform(token)).toBe('Bing Webmaster Tools connector');
  });

  it('renders tokens as inline chips in the textarea mirror', () => {
    const h = loadChatUseHelpers();
    const text = `Use ${h.tokenFor({ kind: 'skill', name: 'Docs' })} now`;

    expect(h.mirror(text, (s: string) => s)).toContain('chat-use-inline-chip is-skill');
    expect(h.mirror(text, (s: string) => s)).toContain('Skill: ');
    expect(h.mirror(text, (s: string) => s)).toContain('Docs');
  });

  it('round-trips interleaved text and multiple resources through JSON message parts', () => {
    const h = loadChatUseHelpers();
    const text = [
      h.tokenFor({ kind: 'skill', id: 'brand-research', name: 'Brand Research' }),
      ' bird ',
      h.tokenFor({ kind: 'skill', id: 'content-writer', name: 'Content Writer' }),
      ' utility bill ',
      h.tokenFor({ kind: 'connector', id: 'github', name: 'GitHub' }),
    ].join('');

    const parts = h.partsFromText(text);
    expect(parts).toEqual([
      { type: 'use', kind: 'skill', id: 'brand-research', name: 'Brand Research' },
      { type: 'text', text: ' bird ' },
      { type: 'use', kind: 'skill', id: 'content-writer', name: 'Content Writer' },
      { type: 'text', text: ' utility bill ' },
      { type: 'use', kind: 'connector', id: 'github', name: 'GitHub' },
    ]);
    expect(h.textFromParts(parts)).toBe(text);
  });

  it('preserves Skill source through token and message-part round trips', () => {
    const h = loadChatUseHelpers();
    const external = { kind: 'skill', id: 'same-id', name: 'Shared Skill', source: 'external' };
    const global = { kind: 'skill', id: 'same-id', name: 'Shared Skill', source: 'global' };
    const text = `${h.tokenFor(external)} + ${h.tokenFor(global)}`;

    expect(h.normalizeMany([external, global, { ...global }])).toEqual([external, global]);
    expect(h.partsFromText(text)).toEqual([
      { type: 'use', ...external },
      { type: 'text', text: ' + ' },
      { type: 'use', ...global },
    ]);
    expect(h.textFromParts(h.partsFromText(text))).toBe(text);
    expect(h.normalize({ kind: 'connector', id: 'drive', source: 'global' }))
      .toEqual({ kind: 'connector', id: 'drive', name: 'drive' });
  });

  it('rejects malformed persisted message parts', () => {
    const h = loadChatUseHelpers();
    expect(h.textFromParts([{ type: 'use', kind: 'tool', id: 'bad', name: 'Bad' }])).toBe('');
    expect(h.textFromParts([{ type: 'text', text: 'plain text without a use part' }])).toBe('');
  });

  it('escapes token delimiters in names', () => {
    const h = loadChatUseHelpers();
    const token = h.tokenFor({ kind: 'skill', name: 'Review } Draft' });
    const parsed = h.tokens(token);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].selection).toEqual({ kind: 'skill', id: 'Review } Draft', name: 'Review } Draft' });
    expect(parsed[0].start).toBe(0);
    expect(parsed[0].end).toBe(token.length);
    expect(h.transform(token)).toBe('Review } Draft skill');
  });

  it('keeps legacy single use selection as a prefix wrapper', () => {
    const h = loadChatUseHelpers();

    expect(h.transform('Summarize this', { kind: 'skill', name: 'Reader' }))
      .toBe('Use Reader skill: Summarize this');
  });

  it('treats a token as one delete block from either side or inside it', () => {
    const h = loadChatUseHelpers();
    const token = h.tokenFor({ kind: 'connector', name: 'GitHub' });
    const text = `Ask ${token} now`;
    const start = text.indexOf(token);
    const end = start + token.length;

    expect(h.deleteRange({ value: text, selectionStart: end, selectionEnd: end }, 'backward'))
      .toEqual({ start, end });
    expect(h.deleteRange({ value: text, selectionStart: start, selectionEnd: start }, 'forward'))
      .toEqual({ start, end });
    expect(h.deleteRange({ value: text, selectionStart: start + 4, selectionEnd: start + 4 }, 'backward'))
      .toEqual({ start, end });
    expect(h.deleteRange({ value: text, selectionStart: start + 2, selectionEnd: start + 6 }, 'forward'))
      .toEqual({ start, end });
  });

  it('moves the caret across a token as one chip block', () => {
    const h = loadChatUseHelpers();
    const token = h.tokenFor({ kind: 'skill', name: 'Docs' });
    const text = `Ask ${token} now`;
    const start = text.indexOf(token);
    const end = start + token.length;

    expect(h.moveTarget(text, start, 'forward')).toBe(end);
    expect(h.moveTarget(text, start + 5, 'forward')).toBe(end);
    expect(h.moveTarget(text, end, 'backward')).toBe(start);
    expect(h.moveTarget(text, end + 1, 'backward')).toBe(start);
    expect(h.moveTarget(text, 1, 'forward')).toBeNull();
  });

  it('shares chip boundaries for full Agent names and resources without changing sent text', () => {
    const h = loadChatUseHelpers();
    const skill = h.tokenFor({ kind: 'skill', name: 'Docs @Orkas Codex' });
    const text = `@Orkas Codex ${skill} 然后@写作助手 审核 @commander`;
    const tokens = h.composerTokens(text);
    expect(tokens.map((token: any) => token.selection.kind)).toEqual(['agent', 'skill', 'agent', 'commander']);
    expect(tokens.map((token: any) => text.slice(token.start, token.end)))
      .toEqual(['@Orkas Codex', skill, '@写作助手', '@commander']);
    expect(h.transform(text)).toBe('@Orkas Codex Docs @Orkas Codex skill 然后@写作助手 审核 @commander');
    expect(h.partsFromText(text).filter((part: any) => part.type === 'use')).toHaveLength(1);
  });

  it('moves and deletes Agent chips atomically, including a selection crossing a resource chip', () => {
    const h = loadChatUseHelpers();
    const skill = h.tokenFor({ kind: 'skill', name: 'Docs' });
    const text = `@Orkas Codex ${skill} @写作助手 审核`;
    const [agent, resource, writer] = h.composerTokens(text);
    expect(h.moveTarget(text, agent.start, 'forward')).toBe(agent.end);
    expect(h.moveTarget(text, agent.end + 1, 'backward')).toBe(agent.start);
    for (const [position, direction] of [[agent.end, 'backward'], [agent.start, 'forward'], [agent.start + 4, 'backward']] as const) {
      expect(h.deleteRange({ value: text, selectionStart: position, selectionEnd: position }, direction))
        .toEqual({ start: agent.start, end: agent.end });
    }
    expect(h.deleteRange({ value: text, selectionStart: resource.start + 2, selectionEnd: writer.start + 2 }, 'forward'))
      .toEqual({ start: resource.start, end: writer.end });
  });

  it('leaves unknown, disabled, email and quoted lookalikes as ordinary editable text', () => {
    const h = loadChatUseHelpers();
    for (const text of ['@Unknown', '@Disabled', 'mail@Orkas Codex', '> @Orkas Codex', '  > @写作助手']) {
      expect(h.composerTokens(text)).toEqual([]);
      expect(h.moveTarget(text, text.length, 'backward')).toBeNull();
      expect(h.deleteRange({ value: text, selectionStart: text.length, selectionEnd: text.length }, 'backward')).toBeFalsy();
    }
    expect(h.composerTokens('@Orkas Codex', 'auto-task-input')).toEqual([]);
  });

  it('keeps routing mentions out of the task title seed but leaves lookalikes alone', () => {
    const h = loadChatUseHelpers();
    expect(h.titleSeed('@Orkas Codex Draft the launch summary')).toBe('Draft the launch summary');
    expect(h.titleSeed('@写作助手 @Orkas Codex 写一份周报')).toBe('写一份周报');
    expect(h.titleSeed('Summarize this @Orkas Codex by noon')).toBe('Summarize this by noon');
    expect(h.titleSeed('@commander plan the sprint')).toBe('plan the sprint');
    for (const text of ['@Unknown fix it', '@Disabled fix it', 'mail@Orkas Codex bounced', '> @Orkas Codex quoted\nreply']) {
      expect(h.titleSeed(text)).toBe(text);
    }
    expect(h.titleSeed('@Orkas Codex')).toBe('@Orkas Codex');
  });
});
