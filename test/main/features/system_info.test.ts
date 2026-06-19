import { describe, expect, it } from 'vitest';

import { desktopPlatform } from '../../../src/main/system_info';

describe('main/system_info > desktopPlatform', () => {
  it('normalizes desktop platform keys', () => {
    expect(desktopPlatform('darwin')).toBe('mac');
    expect(desktopPlatform('MacOS')).toBe('mac');
    expect(desktopPlatform('win32')).toBe('windows');
    expect(desktopPlatform('WIN')).toBe('windows');
    expect(desktopPlatform('linux')).toBe('pc');
  });
});
