import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const addonBuilder = require('../../../scripts/build-notification-permission-addon.cjs') as {
  build(options: {
    platform: NodeJS.Platform;
    arch: string;
    force?: boolean;
    keepOtherArches?: boolean;
    log?: (message: string) => void;
    outputRoot?: string;
  }): string | null;
};

interface NotificationPermissionAddon {
  getPermissionState(): Promise<string>;
  resolvePermissionState(
    authorizationStatus: number,
    alertSetting: number,
    notificationCenterSetting: number,
    alertStyle: number,
  ): string;
}

const UN_SETTING_DISABLED = 1;
const UN_SETTING_ENABLED = 2;
const UN_ALERT_STYLE_NONE = 0;
const UN_ALERT_STYLE_BANNER = 1;

describe.runIf(process.platform === 'darwin')('macOS native notification presentation state', () => {
  let addon: NotificationPermissionAddon;
  let output = '';
  let outputRoot = '';

  beforeAll(() => {
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-notification-native-test-'));
    output = addonBuilder.build({
      platform: 'darwin',
      arch: process.arch,
      force: true,
      keepOtherArches: true,
      log: () => {},
      outputRoot,
    }) || '';
    expect(output).not.toBe('');
    addon = require(output) as NotificationPermissionAddon;
  });

  afterAll(() => {
    if (output) delete require.cache[output];
    if (outputRoot) fs.rmSync(outputRoot, { recursive: true, force: true });
  });

  it.each([
    [UN_SETTING_DISABLED, UN_SETTING_DISABLED, UN_ALERT_STYLE_NONE],
    [UN_SETTING_ENABLED, UN_SETTING_ENABLED, UN_ALERT_STYLE_BANNER],
  ])(
    'keeps not-determined authorization authoritative for presentation settings %i/%i/%i',
    (alertSetting, notificationCenterSetting, alertStyle) => {
      expect(addon.resolvePermissionState(
        0,
        alertSetting,
        notificationCenterSetting,
        alertStyle,
      )).toBe('not_determined');
    },
  );

  it('keeps denied authorization authoritative', () => {
    expect(addon.resolvePermissionState(
      1,
      UN_SETTING_ENABLED,
      UN_SETTING_ENABLED,
      UN_ALERT_STYLE_BANNER,
    )).toBe('denied');
  });

  it('queries asynchronously without escaping the stable state contract', async () => {
    const state = await addon.getPermissionState();
    expect([
      'granted',
      'denied',
      'presentation_disabled',
      'not_determined',
      'unknown',
    ]).toContain(state);
  });

  it.each([2, 3, 4])(
    'accepts visible banners for authorization status %i',
    (authorizationStatus) => {
      expect(addon.resolvePermissionState(
        authorizationStatus,
        UN_SETTING_ENABLED,
        UN_SETTING_DISABLED,
        UN_ALERT_STYLE_BANNER,
      )).toBe('granted');
    },
  );

  it('accepts Notification Center delivery even when desktop alerts are disabled', () => {
    expect(addon.resolvePermissionState(
      2,
      UN_SETTING_DISABLED,
      UN_SETTING_ENABLED,
      UN_ALERT_STYLE_NONE,
    )).toBe('granted');
  });

  it('detects the badge-only state when neither presentation path is visible', () => {
    expect(addon.resolvePermissionState(
      2,
      UN_SETTING_DISABLED,
      UN_SETTING_DISABLED,
      UN_ALERT_STYLE_NONE,
    )).toBe('presentation_disabled');
    expect(addon.resolvePermissionState(
      2,
      UN_SETTING_ENABLED,
      UN_SETTING_DISABLED,
      UN_ALERT_STYLE_NONE,
    )).toBe('presentation_disabled');
  });

  it('fails closed for unknown authorization values or malformed arguments', () => {
    expect(addon.resolvePermissionState(
      99,
      UN_SETTING_ENABLED,
      UN_SETTING_ENABLED,
      UN_ALERT_STYLE_BANNER,
    )).toBe('unknown');
    expect((addon.resolvePermissionState as (...args: unknown[]) => string)('2'))
      .toBe('unknown');
  });
});
