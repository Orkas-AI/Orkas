import { execFileSync } from 'node:child_process';

import { expect, test } from '@playwright/test';

import { OrkasTestApp } from './fixtures/orkas';

type ProtocolOwnerSnapshot = {
  handler: string;
  applicationPath: string;
};

const MACOS_PROTOCOL_OWNER_PROBE = [
  'import Foundation',
  'import AppKit',
  'import CoreServices',
  'let scheme = "orkas"',
  'let handler = LSCopyDefaultHandlerForURLScheme(scheme as NSString)?.takeRetainedValue() as String? ?? ""',
  'let callback = URL(string: "orkas://connectors/oauth/callback?exchange_code=cancelled")!',
  'let applicationPath = NSWorkspace.shared.urlForApplication(toOpen: callback)?.path ?? ""',
  'let data = try! JSONSerialization.data(withJSONObject: ["handler": handler, "applicationPath": applicationPath], options: [.sortedKeys])',
  'print(String(data: data, encoding: .utf8)!)',
].join('; ');

function macosProtocolOwner(): ProtocolOwnerSnapshot {
  const output = execFileSync('/usr/bin/swift', ['-e', MACOS_PROTOCOL_OWNER_PROBE], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
  });
  return JSON.parse(output.trim()) as ProtocolOwnerSnapshot;
}

test.describe('system protocol registration isolation', () => {
  test.skip(process.platform !== 'darwin', 'LaunchServices ownership is a macOS contract');

  test('source E2E launch and relaunch leave the real connector protocol owner unchanged', async ({}, testInfo) => {
    const before = macosProtocolOwner();
    const app = new OrkasTestApp(testInfo);

    try {
      await app.launch();
      expect(macosProtocolOwner()).toEqual(before);

      await app.relaunch();
      expect(macosProtocolOwner()).toEqual(before);
    } finally {
      await app.dispose();
    }

    expect(macosProtocolOwner()).toEqual(before);
  });
});
