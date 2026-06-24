import { describe, it, expect } from 'vitest';

import { officeArgError } from '../../../../src/main/model/core-agent/office-tools';

// P1-OFFICE-1: OfficeCLI takes these model-controlled values as argv tokens. Its
// parser treats any leading-`-` token as an OPTION, so an injected `--save=<path>`
// (a real `get` option that writes a binary payload anywhere) escapes the sandbox.
// These fixtures lock the validation that blocks option-like values.
describe('officeArgError — OfficeCLI argument-injection guard', () => {
  it('rejects option-like targets (the --save=<path> sandbox-escape vector)', () => {
    for (const bad of ['--save=/tmp/x', '-o', '--help', '--', '-x', '-/body/p[1]']) {
      expect(officeArgError(bad, 'target')).toMatch(/must not start with/);
    }
  });

  it('accepts legit DOM paths / CSS selectors / keywords (no false positives)', () => {
    for (const ok of ['/body/p[3]', '/', 'selected', 'paragraph[style=Normal] > run[font!=Arial]', 'p.title', '']) {
      expect(officeArgError(ok, 'target')).toBeNull();
    }
  });

  it('page must be a positive integer', () => {
    for (const ok of ['1', '12', '007']) expect(officeArgError(ok, 'page')).toBeNull();
    for (const bad of ['--save=/tmp/x', '-1', '1.5', 'a', '', '1 2']) {
      expect(officeArgError(bad, 'page')).toMatch(/positive integer/);
    }
  });

  it('locale must be a BCP-47-style tag, rejecting option-like values', () => {
    for (const ok of ['zh-CN', 'en-US', 'ja', 'en']) expect(officeArgError(ok, 'locale')).toBeNull();
    for (const bad of ['--save=/tmp/x', '-CN', '', '--locale']) {
      expect(officeArgError(bad, 'locale')).toMatch(/BCP-47/);
    }
  });
});
