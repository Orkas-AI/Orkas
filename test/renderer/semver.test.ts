import { describe, expect, it } from 'vitest';

const semver = require('../../src/renderer/modules/semver.js') as {
  parseSemver: (value: unknown) => unknown;
  compareVersions: (left: unknown, right: unknown) => number | null;
};

describe('renderer semantic version contract', () => {
  it('matches semantic prerelease and build precedence', () => {
    expect(semver.compareVersions('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1);
    expect(semver.compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(semver.compareVersions('1.0.0+build.2', '1.0.0+build.1')).toBe(0);
  });

  it('matches the full SemVer prerelease precedence example', () => {
    const ordered = [
      '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
      '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0',
    ];
    for (let i = 1; i < ordered.length; i += 1) {
      expect(semver.compareVersions(ordered[i - 1], ordered[i])).toBe(-1);
      expect(semver.compareVersions(ordered[i], ordered[i - 1])).toBe(1);
    }
  });

  it('compares large numeric identifiers without JavaScript number rounding', () => {
    expect(semver.compareVersions(
      '999999999999999999999999.0.0',
      '999999999999999999999998.999999999999999999999999.0',
    )).toBe(1);
    expect(semver.compareVersions(
      '1.0.0-999999999999999999999999',
      '1.0.0-999999999999999999999998',
    )).toBe(1);
  });

  it('fails closed for invalid versions', () => {
    for (const value of [
      '', '1', '1.0', '01.0.0', '1.01.0', '1.0.01',
      '1.0.0-', '1.0.0-alpha..1', '1.0.0-beta.01', '1.0.0+bad_value',
    ]) {
      expect(semver.parseSemver(value), value).toBeNull();
    }
    expect(semver.compareVersions('latest', '999.0.0')).toBeNull();
  });
});
