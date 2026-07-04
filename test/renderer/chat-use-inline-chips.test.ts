import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const skillsSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf8');

function loadChatUseHelpers() {
  const start = skillsSource.indexOf('// ─── Chat-input inline use chips');
  const end = skillsSource.indexOf('function renderSkillsList', start);
  if (start < 0 || end < 0) throw new Error('missing chat use helper block');
  const block = skillsSource.slice(start, end);
  return vm.runInNewContext(`
    const currentCid = '';
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
      };
      let text = table[key] || key;
      for (const [k, v] of Object.entries(vars)) text = text.replaceAll('{' + k + '}', String(v));
      return text;
    }
    const document = { getElementById: () => null, querySelectorAll: () => [] };
    ${block}
    ({
      normalize: _normalizeChatUseSelection,
      tokenFor: _chatUseTokenFor,
      tokens: _findChatUseTokens,
      transform: transformWithChatUse,
      display: formatChatUseTextForDisplay,
      mirror: _renderChatUseMirrorHtml,
      deleteRange: _chatUseTokenDeleteRange,
      moveTarget: _chatUseTokenMoveTarget,
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
});
