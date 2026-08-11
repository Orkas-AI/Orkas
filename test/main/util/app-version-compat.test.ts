import { describe, expect, it } from 'vitest';

import {
  compareVersions,
  minAppVersionFrom,
  normalizeSemver,
  parseSemver,
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

  it('rejects a declared minimum when the current app version is missing', () => {
    expect(satisfiesMinAppVersion('', '1.5.0')).toBe(false);
    expect(satisfiesMinAppVersion('   ', '1.5.0')).toBe(false);
  });

  it('implements semantic-version prerelease precedence and ignores build metadata', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0+build.2', '1.0.0+build.1')).toBe(0);
  });

  it('matches the full SemVer prerelease precedence example', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(compareVersions(ordered[i - 1], ordered[i]), `${ordered[i - 1]} < ${ordered[i]}`)
        .toBe(-1);
      expect(compareVersions(ordered[i], ordered[i - 1]), `${ordered[i]} > ${ordered[i - 1]}`)
        .toBe(1);
    }
  });

  it('compares arbitrarily large numeric components without precision loss', () => {
    expect(compareVersions(
      '999999999999999999999999.0.0',
      '999999999999999999999998.999999999999999999999999.999999999999999999999999',
    )).toBe(1);
    expect(compareVersions(
      '1.0.0-999999999999999999999999',
      '1.0.0-999999999999999999999998',
    )).toBe(1);
  });

  it('fails closed for invalid or partial versions', () => {
    for (const value of [
      '', '1', '1.0', '01.0.0', '1.01.0', '1.0.01',
      '1.0.0-', '1.0.0-alpha..1', '1.0.0-beta.01', '1.0.0+bad_value',
    ]) {
      expect(parseSemver(value), value).toBeNull();
    }
    expect(compareVersions('latest', '999.0.0')).toBeNull();
    expect(satisfiesMinAppVersion('1.6.5', 'latest')).toBe(false);
  });

  it('normalizes an optional v prefix without changing semantic identity', () => {
    expect(normalizeSemver(' v1.6.5-rc.1+mac ')).toBe('1.6.5-rc.1+mac');
  });
});
