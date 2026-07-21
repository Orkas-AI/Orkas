import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: true },
  Notification: { isSupported: () => true },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

import {
  permissionFromMacNativeState,
  permissionFromWindowsSetting,
  systemNotificationSettingsUrl,
  windowsNotificationPermissionProbe,
} from '../../../src/main/features/notification_permissions';

describe('system notification permission helpers', () => {
  it('normalizes the macOS native authorization state', () => {
    expect(permissionFromMacNativeState('granted')).toBe('granted');
    expect(permissionFromMacNativeState('denied')).toBe('denied');
    expect(permissionFromMacNativeState('not_determined')).toBe('not_determined');
    expect(permissionFromMacNativeState('unexpected')).toBe('unknown');
    expect(permissionFromMacNativeState(null)).toBe('unknown');
  });

  it('maps Windows ToastNotifier settings to granted or denied', () => {
    expect(permissionFromWindowsSetting('0')).toBe('granted');
    for (const value of [1, 2, 3, 4, '1', '2', '3', '4']) {
      expect(permissionFromWindowsSetting(value)).toBe('denied');
    }
    for (const value of ['5', '', '  ', '1.5', 'NaN', 1.5, Number.NaN, null, undefined, {}]) {
      expect(permissionFromWindowsSetting(value)).toBe('unknown');
    }
  });

  it('builds a hidden, bounded Windows Runtime permission probe and escapes the app id', () => {
    const probe = windowsNotificationPermissionProbe("com.orka's.desktop");
    expect(probe.file).toBe('powershell.exe');
    expect(probe.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    expect(probe.args[4]).toContain("CreateToastNotifier('com.orka''s.desktop')");
    expect(probe.args[4]).toContain('[int]$notifier.Setting');
    expect(probe.options).toEqual({ encoding: 'utf8', windowsHide: true, timeout: 5_000 });
  });

  it('builds platform notification-settings deep links', () => {
    expect(systemNotificationSettingsUrl('darwin', 'com.orkas.desktop'))
      .toBe('x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.orkas.desktop');
    expect(systemNotificationSettingsUrl('win32', 'com.orkas.desktop')).toBe('ms-settings:notifications');
    expect(systemNotificationSettingsUrl('linux', 'com.orkas.desktop')).toBeNull();
  });
});
