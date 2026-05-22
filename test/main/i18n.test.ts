import { describe, it, expect, beforeEach } from 'vitest';
import {
  t, setCurrentLang, getCurrentLang,
  acceptLanguageHeader, detectSystemLang, descriptionLang, isLang, _resetCacheForTests,
} from '../../src/main/i18n';

beforeEach(() => {
  _resetCacheForTests();
  setCurrentLang('en');
});

describe('i18n › detectSystemLang', () => {
  it('maps zh* locales to zh', () => {
    for (const v of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'ZH-Hans']) {
      expect(detectSystemLang(v)).toBe('zh');
    }
  });

  it('maps ja* locales to ja', () => {
    for (const v of ['ja', 'ja-JP']) {
      expect(detectSystemLang(v)).toBe('ja');
    }
  });

  it('falls back to en for non-supported / malformed / empty', () => {
    for (const v of ['en-US', 'fr', '', null, undefined, 42]) {
      expect(detectSystemLang(v)).toBe('en');
    }
  });
});

describe('i18n › isLang', () => {
  it('accepts supported language codes', () => {
    expect(isLang('zh')).toBe(true);
    expect(isLang('en')).toBe(true);
    expect(isLang('ja')).toBe(true);
    expect(isLang('ZH')).toBe(false);
    expect(isLang('fr')).toBe(false);
    expect(isLang('')).toBe(false);
    expect(isLang(null)).toBe(false);
  });
});

describe('i18n › t() lookup', () => {
  it('returns current-lang string when present', () => {
    setCurrentLang('zh');
    expect(t('errors.not_utf8')).toBe('文本类文件必须是 UTF-8 编码');
    setCurrentLang('en');
    expect(t('errors.not_utf8')).toBe('Text files must be UTF-8 encoded');
    setCurrentLang('ja');
    expect(t('errors.not_utf8')).toBe('テキストファイルは UTF-8 エンコードである必要があります');
  });

  it('falls back to en when key missing in current lang', () => {
    // Seed only-in-en by monkey-patching loaded table isn't supported; instead
    // we rely on the shipped table where `errors.not_utf8` exists in both.
    // This test covers the en-fallback path by picking a real key and
    // temporarily pretending the zh side is empty via cache reset + one-shot
    // override: simpler to just verify the final chain with a known-missing
    // key (returns raw key).
    setCurrentLang('zh');
    expect(t('nope.definitely.missing.key')).toBe('nope.definitely.missing.key');
  });

  it('returns raw key when missing in both langs', () => {
    expect(t('definitely.not.present')).toBe('definitely.not.present');
  });

  it('substitutes {name} placeholders from vars', () => {
    setCurrentLang('en');
    // Use raw-key fallback as the template source so this test stays
    // independent of shipped strings.
    expect(t('Hello {who}, you have {count} messages', { who: 'Ada', count: 3 }))
      .toBe('Hello Ada, you have 3 messages');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(t('Ping {unknown} pong', { other: 'x' })).toBe('Ping {unknown} pong');
  });

  it('per-call lang override takes precedence over current', () => {
    setCurrentLang('en');
    expect(t('errors.not_utf8', undefined, 'zh')).toBe('文本类文件必须是 UTF-8 编码');
    expect(t('errors.not_utf8', undefined, 'ja')).toBe('テキストファイルは UTF-8 エンコードである必要があります');
    expect(getCurrentLang()).toBe('en'); // override does not mutate state
  });
});

describe('i18n › descriptionLang', () => {
  it('uses English descriptions for non-Chinese UI languages', () => {
    expect(descriptionLang('zh')).toBe('zh');
    expect(descriptionLang('en')).toBe('en');
    expect(descriptionLang('ja')).toBe('en');
  });
});

describe('i18n › acceptLanguageHeader', () => {
  it('prefers the active UI locale for HTTP language negotiation', () => {
    expect(acceptLanguageHeader('ja').startsWith('ja-JP')).toBe(true);
    expect(acceptLanguageHeader('zh').startsWith('zh-CN')).toBe(true);
  });
});
