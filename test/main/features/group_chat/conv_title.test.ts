/**
 * conv_title.ts — fixture-lock the placeholder-title detection set so that
 * adding a new UI language without updating `chat.default_title` in its
 * locale file (or, worse, forgetting that the placeholder-set even exists)
 * regresses noisily instead of silently. The bug this guards against
 * shipped once in 2026-05 when Japanese landed `chat.default_title="新しい会話"`
 * but the placeholder set was hardcoded to zh+en only — every new Japanese
 * UI conversation lost its auto-title trigger.
 *
 * Set A: every supported language's `chat.default_title` MUST be detected,
 *        plus the historical capitalization aliases.
 * Set B: a non-placeholder user-named title MUST NOT be detected.
 */

import { describe, it, expect } from 'vitest';

import { SUPPORTED_LANGS, t } from '../../../../src/main/i18n';
import { isPlaceholderTitle, PLACEHOLDER_TITLES } from '../../../../src/main/features/group_chat/conv_title';

describe('conv_title › PLACEHOLDER_TITLES set membership', () => {
  it('contains every supported language\'s chat.default_title (set A: locale-driven)', () => {
    // Locked: zh / en / ja each have their default title pinned. If a new
    // language is added but its locale file is missing this key, this test
    // fails loudly instead of silently degrading auto-title for that UI.
    for (const lang of SUPPORTED_LANGS) {
      const value = t('chat.default_title', undefined, lang);
      expect(value, `chat.default_title missing in ${lang}.json`).not.toBe('chat.default_title');
      expect(
        PLACEHOLDER_TITLES.has(value),
        `${lang} default title "${value}" not recognised as placeholder`,
      ).toBe(true);
      expect(isPlaceholderTitle(value)).toBe(true);
    }
  });

  it('contains the legacy capitalization aliases "New Conversation" / "New Chat"', () => {
    expect(PLACEHOLDER_TITLES.has('New Conversation')).toBe(true);
    expect(PLACEHOLDER_TITLES.has('New Chat')).toBe(true);
    expect(isPlaceholderTitle('New Conversation')).toBe(true);
    expect(isPlaceholderTitle('New Chat')).toBe(true);
  });
});

describe('conv_title › isPlaceholderTitle (set B: real user-named titles must pass through)', () => {
  it('returns false for an English user-named title', () => {
    expect(isPlaceholderTitle('Quarterly review notes')).toBe(false);
  });

  it('returns false for a Chinese user-named title that is not the default', () => {
    expect(isPlaceholderTitle('季度复盘')).toBe(false);
  });

  it('returns false for a Japanese user-named title that is not the default', () => {
    expect(isPlaceholderTitle('週次レビューのメモ')).toBe(false);
  });

  it('returns false for a title that contains but does not equal the default ("新对话补充")', () => {
    expect(isPlaceholderTitle('新对话补充')).toBe(false);
  });

  it('returns true for empty string / undefined / null (treat as unnamed)', () => {
    expect(isPlaceholderTitle('')).toBe(true);
    expect(isPlaceholderTitle(undefined)).toBe(true);
    expect(isPlaceholderTitle(null)).toBe(true);
  });
});
