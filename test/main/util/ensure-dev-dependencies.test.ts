import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

const { shouldProvisionWhisper } = require(
  path.join(process.cwd(), 'scripts', 'ensure-dev-dependencies.cjs'),
) as {
  shouldProvisionWhisper: (platform: string, arch: string) => boolean;
};

describe('ensure-dev-dependencies.cjs', () => {
  it.each([
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'x64'],
  ])('keeps Whisper required for supported target %s-%s', (platform, arch) => {
    expect(shouldProvisionWhisper(platform, arch)).toBe(true);
  });

  it.each([
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'arm64'],
  ])('does not provision Whisper for unsupported target %s-%s', (platform, arch) => {
    expect(shouldProvisionWhisper(platform, arch)).toBe(false);
  });
});
