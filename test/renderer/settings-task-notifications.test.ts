import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const settingsSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/settings.js'),
  'utf8',
);
const htmlSource = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');

function loadHarness(
  setResult: { ok: boolean; enabled?: boolean; error?: string; code?: string },
  permission = { state: 'unknown', can_open_settings: false },
  storedEnabled = false,
) {
  const listeners = new Map<string, () => Promise<void>>();
  const windowListeners = new Map<string, () => void>();
  const scheduled: Array<() => unknown> = [];
  const checkbox: any = {
    checked: false,
    disabled: false,
    dataset: {},
    addEventListener(type: string, listener: () => Promise<void>) {
      listeners.set(type, listener);
    },
  };
  const warning: any = { hidden: true };
  const openButton: any = {
    hidden: true,
    disabled: false,
    dataset: {},
    addEventListener(type: string, listener: () => Promise<void>) {
      listeners.set(`open:${type}`, listener);
    },
  };
  const click = vi.fn();
  const event = vi.fn();
  const error = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const invoke = vi.fn(async (channel: string, payload?: { enabled?: boolean }) => {
    if (channel === 'prefs.getTaskNotifications') return { ok: true, enabled: storedEnabled, permission };
    if (channel === 'prefs.setTaskNotifications') {
      return setResult.ok
        ? { ok: true, enabled: !!payload?.enabled }
        : setResult;
    }
    if (channel === 'prefs.openTaskNotificationSettings') return { ok: true, opened: true };
    return { ok: true };
  });
  const sandbox: any = {
    console,
    createLogger: () => logger,
    t: (key: string) => key,
    document: {
      getElementById: (id: string) => ({
        'settings-task-notifications-toggle': checkbox,
        'settings-task-notification-permission': warning,
        'settings-task-notification-open-settings': openButton,
      } as Record<string, any>)[id] || null,
      querySelectorAll: () => [],
    },
    Monitor: { click, event, error },
    window: {
      addEventListener(type: string, listener: () => void) {
        windowListeners.set(type, listener);
      },
      Monitor: true,
      orkas: { invoke },
    },
    setTimeout(callback: () => unknown) {
      scheduled.push(callback);
      return scheduled.length;
    },
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
  };
  vm.runInNewContext(settingsSource, sandbox, { filename: 'settings.js' });
  return {
    sandbox,
    checkbox,
    warning,
    openButton,
    listeners,
    windowListeners,
    scheduled,
    invoke,
    click,
    event,
    error,
    logger,
  };
}

describe('Settings → General task notification toggle', () => {
  it('renders checked by default in markup', () => {
    expect(htmlSource).toMatch(/id="settings-task-notifications-toggle" checked/);
  });

  it('loads the persisted value and saves a user change', async () => {
    const { sandbox, checkbox, listeners, invoke, click, event, logger } = loadHarness({ ok: true });
    await sandbox._settingsRefreshTaskNotifications();
    sandbox._settingsRenderTaskNotifications();
    expect(checkbox.checked).toBe(false);

    checkbox.checked = true;
    await listeners.get('change')!();

    expect(invoke).toHaveBeenCalledWith('prefs.setTaskNotifications', { enabled: true });
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('task notification toggle saved', {
      previous_enabled: false,
      enabled: true,
      permission_state: 'unknown',
    });
  });

  it('rolls the toggle back when persistence is rejected', async () => {
    const { sandbox, checkbox, listeners, click, event, error, logger } = loadHarness({
      ok: false,
      error: 'disk unavailable',
      code: 'E_STORAGE',
    });
    await sandbox._settingsRefreshTaskNotifications();
    sandbox._settingsRenderTaskNotifications();
    checkbox.checked = true;

    await listeners.get('change')!();

    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('set task notifications rejected', {
      target_enabled: true,
      error: 'disk unavailable',
    });
  });

  it('shows an OS-permission warning and opens system settings when notifications are denied', async () => {
    const permission = { state: 'denied', can_open_settings: true };
    const {
      sandbox,
      warning,
      openButton,
      listeners,
      windowListeners,
      scheduled,
      invoke,
      click,
    } = loadHarness(
      { ok: true },
      permission,
      true,
    );
    sandbox._settingsBindTaskNotificationsOnce();
    await sandbox._settingsRefreshTaskNotifications();
    sandbox._settingsRenderTaskNotifications();

    expect(warning.hidden).toBe(false);
    expect(openButton.hidden).toBe(false);
    await listeners.get('open:click')!();

    expect(invoke).toHaveBeenCalledWith('prefs.openTaskNotificationSettings');
    expect(openButton.disabled).toBe(false);
    expect(click).not.toHaveBeenCalled();

    permission.state = 'granted';
    windowListeners.get('focus')!();
    await scheduled.shift()!();
    expect(warning.hidden).toBe(true);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'prefs.getTaskNotifications')).toHaveLength(2);
  });

  it('refreshes permission when Orkas regains focus even if settings were opened externally', async () => {
    const permission = { state: 'granted', can_open_settings: true };
    const { sandbox, warning, windowListeners, scheduled, invoke, event } = loadHarness(
      { ok: true },
      permission,
      true,
    );
    sandbox._settingsBindTaskNotificationsOnce();
    await sandbox._settingsRefreshTaskNotifications();
    sandbox._settingsRenderTaskNotifications();
    expect(warning.hidden).toBe(true);

    permission.state = 'denied';
    windowListeners.get('focus')!();
    await scheduled.shift()!();

    expect(warning.hidden).toBe(false);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'prefs.getTaskNotifications')).toHaveLength(2);
    expect(event).not.toHaveBeenCalled();
  });

  it('does not warn about OS permission while the Orkas notification preference is off', async () => {
    const { sandbox, warning } = loadHarness(
      { ok: true },
      { state: 'denied', can_open_settings: true },
    );
    await sandbox._settingsRefreshTaskNotifications();
    sandbox._settingsRenderTaskNotifications();

    expect(warning.hidden).toBe(true);
  });

  it('does not claim system settings disabled Orkas when no per-app settings destination is available', async () => {
    const { sandbox, warning, openButton } = loadHarness(
      { ok: true },
      { state: 'denied', can_open_settings: false },
      true,
    );
    await sandbox._settingsRefreshTaskNotifications();
    sandbox._settingsRenderTaskNotifications();

    expect(warning.hidden).toBe(true);
    expect(openButton.hidden).toBe(true);
  });
});
