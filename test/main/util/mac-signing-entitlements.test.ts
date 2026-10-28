import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';

type PlistEntry = { key?: { '#text': string }[]; true?: unknown[] };
type OrderedPlist = { plist: { dict: PlistEntry[] }[] }[];

function configuredPolicy(field: 'entitlements' | 'entitlementsInherit'): Record<string, boolean> {
  const root = process.cwd();
  const { build } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  // Follow the builder configuration so a dangling path fails this contract.
  const xml = readFileSync(join(root, build.mac[field]), 'utf8');
  expect(XMLValidator.validate(xml)).toBe(true);
  const document = new XMLParser({
    preserveOrder: true,
    ignoreDeclaration: true,
    processEntities: false,
  }).parse(xml) as OrderedPlist;
  const entries = document[0].plist[0].dict;
  expect(entries.length % 2).toBe(0);
  const policy: Record<string, boolean> = {};
  for (let index = 0; index < entries.length; index += 2) {
    const key = entries[index].key?.[0]['#text'];
    expect(key).toBeTypeOf('string');
    expect(entries[index + 1]).toEqual({ true: [] });
    expect(Object.hasOwn(policy, key!)).toBe(false);
    policy[key!] = true;
  }
  return policy;
}

describe('macOS signing entitlements', () => {
  it('allows microphone recording and main-process JIT without child-only runtime exceptions', () => {
    expect(configuredPolicy('entitlements')).toEqual({
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.device.audio-input': true,
    });
  });

  it('preserves inherited Intel Node executable memory without disabling library validation', () => {
    expect(configuredPolicy('entitlementsInherit')).toEqual({
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.device.audio-input': true,
      'com.apple.security.cs.allow-unsigned-executable-memory': true,
    });
  });
});
