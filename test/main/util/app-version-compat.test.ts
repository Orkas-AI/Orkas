import { describe, expect, it } from 'vitest';

import {
  minAppVersionFrom,
  satisfiesMinAppVersion,
} from '../../../src/main/util/app-version-compat';

describe('app version compatibility', () => {
  it('treats missing minimum app version as unrestricted', () => {
    expect(satisfiesMinAppVersion('1.0.0', '')).toBe(true);
    expect(satisfiesMinAppVersion('', '')).toBe(true);
  });

  it('normalizes canonical, simple, and legacy minimum-version fields', () => {
    expect(minAppVersionFrom({ min_app_version: ' 1.5.0 ' })).toBe('1.5.0');
    expect(minAppVersionFrom({ min_version: '1.4.0' })).toBe('1.4.0');
    expect(minAppVersionFrom({ min_pc_version: '1.3.0' })).toBe('1.3.0');
    expect(minAppVersionFrom({ min_version: '1.4.0' }, { min_app_version: '1.5.0' })).toBe('1.4.0');
  });

  it('compares current app version with the required minimum', () => {
    expect(satisfiesMinAppVersion('1.5.0', '1.5.0')).toBe(true);
    expect(satisfiesMinAppVersion('1.5.1', '1.5.0')).toBe(true);
    expect(satisfiesMinAppVersion('1.4.9', '1.5.0')).toBe(false);
  });
});
