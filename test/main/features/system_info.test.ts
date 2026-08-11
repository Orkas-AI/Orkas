import { describe, expect, it } from 'vitest';

import { desktopPlatform, preferredSystemLanguage } from '../../../src/main/system_info';

describe('main/system_info › desktopPlatform', () => {
  it('normalizes desktop platform keys', () => {
    expect(desktopPlatform('darwin')).toBe('mac');
    expect(desktopPlatform('MacOS')).toBe('mac');
    expect(desktopPlatform('win32')).toBe('windows');
    expect(desktopPlatform('WIN')).toBe('windows');
    expect(desktopPlatform('linux')).toBe('pc');
  });

  it('keeps the first preferred OS UI language as a canonical BCP 47 tag', () => {
    expect(preferredSystemLanguage(['fr-ca', 'en-US'])).toBe('fr-CA');
    expect(preferredSystemLanguage(['zh_Hans_CN'])).toBe('zh-Hans-CN');
  });

  it('uses und when the OS language is unavailable or invalid', () => {
    expect(preferredSystemLanguage([])).toBe('und');
    expect(preferredSystemLanguage(undefined)).toBe('und');
    expect(preferredSystemLanguage(['en--US'])).toBe('und');
  });
});
