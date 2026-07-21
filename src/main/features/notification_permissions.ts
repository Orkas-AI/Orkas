/**
 * Best-effort operating-system notification permission status.
 *
 * Electron only exposes `Notification.isSupported()`, which says whether the
 * platform has a notification implementation; it does not expose the user's
 * per-app authorization choice. Keep the platform-specific probes here so the
 * Settings UI never mistakes "supported" for "allowed".
 *
 * The status is device-local. It must never be written into the cloud-synced
 * user preference that controls whether Orkas wants to send notifications.
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { app, Notification, shell } from 'electron';

import { createLogger } from '../logger';

const log = createLogger('notification-permissions');
const execFileAsync = promisify(execFile);

export type SystemNotificationPermissionState =
  | 'granted'
  | 'denied'
  | 'not_determined'
  | 'unsupported'
  | 'unknown';

export interface SystemNotificationPermission {
  state: SystemNotificationPermissionState;
  can_open_settings: boolean;
}

interface MacNotificationPermissionAddon {
  getPermissionState: () => Promise<unknown> | unknown;
}

let observedDeliveryState: 'granted' | 'denied' | null = null;
let lastLoggedPermissionState: SystemNotificationPermissionState | null = null;
let lastPermissionQueryFailure = '';

function notificationAppId(): string {
  return 'com.orkas.desktop';
}

/** A delivered notification is stronger evidence than a stale preference file. */
export function markSystemNotificationDelivered(): void {
  observedDeliveryState = 'granted';
}

/** Electron emits `failed` when the OS rejects a notification. */
export function markSystemNotificationFailed(): void {
  observedDeliveryState = 'denied';
}

function logPermissionQueryFailure(kind: string, err: unknown): void {
  const message = (err as Error)?.message || String(err);
  const key = `${kind}:${message}`;
  if (lastPermissionQueryFailure === key) return;
  lastPermissionQueryFailure = key;
  log.warn(`${kind} notification permission query failed`, { error: message });
}

function permissionObserved(state: SystemNotificationPermissionState): void {
  if (lastLoggedPermissionState === state) return;
  log.info('system notification permission observed', {
    platform: process.platform,
    previous_state: lastLoggedPermissionState,
    state,
  });
  lastLoggedPermissionState = state;
}

/** Normalize the small, stable contract exposed by the macOS native addon. */
export function permissionFromMacNativeState(value: unknown): SystemNotificationPermissionState {
  return ['granted', 'denied', 'not_determined', 'unknown'].includes(String(value))
    ? String(value) as SystemNotificationPermissionState
    : 'unknown';
}

export function permissionFromWindowsSetting(value: unknown): SystemNotificationPermissionState {
  if (typeof value !== 'number' && typeof value !== 'string') return 'unknown';
  if (typeof value === 'string' && !value.trim()) return 'unknown';
  const setting = Number(value);
  if (!Number.isInteger(setting)) return 'unknown';
  if (setting === 0) return 'granted';
  if ([1, 2, 3, 4].includes(setting)) return 'denied';
  return 'unknown';
}

export function systemNotificationSettingsUrl(platform: NodeJS.Platform, appId: string): string | null {
  if (platform === 'darwin') {
    return `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${encodeURIComponent(appId)}`;
  }
  if (platform === 'win32') return 'ms-settings:notifications';
  return null;
}

export interface WindowsNotificationPermissionProbe {
  file: string;
  args: string[];
  options: {
    encoding: 'utf8';
    windowsHide: true;
    timeout: number;
  };
}

/**
 * Build the Windows Runtime notification probe as data so quoting and launch
 * flags stay independently testable. AppUserModelIDs may contain an apostrophe;
 * PowerShell single-quoted literals escape it by doubling the character.
 */
export function windowsNotificationPermissionProbe(appId: string): WindowsNotificationPermissionProbe {
  const safeAppId = appId.replace(/'/g, "''");
  const command = [
    `$notifier = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]::CreateToastNotifier('${safeAppId}')`,
    '[Console]::Write([int]$notifier.Setting)',
  ].join('; ');
  return {
    file: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    options: { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
  };
}

function macAddonPath(): string {
  const filename = `notification_permissions-darwin-${process.arch}.node`;
  const bundled = path.join(__dirname, '..', 'native', 'build', filename);
  return app.isPackaged
    ? bundled.replace(/([\\/])app\.asar([\\/])/g, '$1app.asar.unpacked$2')
    : bundled;
}

async function queryMacPermission(): Promise<SystemNotificationPermissionState> {
  try {
    // This must run inside Orkas itself. Reading com.apple.ncprefs is both
    // unreliable on current macOS releases and loses the process identity
    // that UNUserNotificationCenter uses for the per-app authorization row.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const addon = require(macAddonPath()) as MacNotificationPermissionAddon;
    const state = permissionFromMacNativeState(await addon.getPermissionState());
    lastPermissionQueryFailure = '';
    if (state === 'unknown' || state === 'not_determined') {
      return observedDeliveryState || state;
    }
    return state;
  } catch (err) {
    logPermissionQueryFailure('macOS native', err);
    return observedDeliveryState || 'unknown';
  }
}

async function queryWindowsPermission(appId: string): Promise<SystemNotificationPermissionState> {
  // ToastNotifier.Setting is the Windows API that distinguishes app-level,
  // user-level, policy, and manifest blocking. Electron has already registered
  // this same AppUserModelID during startup.
  const probe = windowsNotificationPermissionProbe(appId);
  try {
    const { stdout } = await execFileAsync(probe.file, probe.args, probe.options);
    const state = permissionFromWindowsSetting(String(stdout).trim());
    lastPermissionQueryFailure = '';
    return state === 'unknown' ? (observedDeliveryState || state) : state;
  } catch (err) {
    logPermissionQueryFailure('Windows', err);
    return observedDeliveryState || 'unknown';
  }
}

export async function getSystemNotificationPermission(): Promise<SystemNotificationPermission> {
  let result: SystemNotificationPermission;
  if (!Notification.isSupported()) {
    result = { state: 'unsupported', can_open_settings: false };
  } else if (process.platform === 'darwin') {
    result = {
      state: await queryMacPermission(),
      can_open_settings: true,
    };
  } else if (process.platform === 'win32') {
    result = {
      state: await queryWindowsPermission(notificationAppId()),
      can_open_settings: true,
    };
  } else {
    // Linux desktop environments do not expose one portable per-app setting URI.
    result = { state: observedDeliveryState || 'unknown', can_open_settings: false };
  }
  permissionObserved(result.state);
  return result;
}

export async function openSystemNotificationSettings(): Promise<boolean> {
  const url = systemNotificationSettingsUrl(process.platform, notificationAppId());
  if (!url) return false;

  try {
    await shell.openExternal(url);
    log.info('system notification settings opened', { platform: process.platform });
    return true;
  } catch (err) {
    log.warn('open system notification settings failed', {
      error: (err as Error)?.message || String(err),
    });
    return false;
  }
}
