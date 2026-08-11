import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const settingsSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/settings.js'),
  'utf8',
);
const htmlSource = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');
const styleSource = readFileSync(resolve(__dirname, '../../src/renderer/style.css'), 'utf8');
const taskNotificationLocales = ['en', 'ja', 'pt', 'zh'].map((locale) => JSON.parse(readFileSync(
  resolve(__dirname, `../../src/renderer/locales/${locale}.json`),
  'utf8',
)));

function loadHarness(
  setResult: { ok: boolean; enabled?: boolean; error?: string; code?: string }
    | Promise<{ ok: boolean; enabled?: boolean; error?: string; code?: string }>,
  permission = { state: 'unknown', can_open_settings: false },
  storedEnabled = false,
  getResult: { ok: boolean; enabled?: boolean; permission?: Record<string, unknown> }
    | Promise<{ ok: boolean; enabled?: boolean; permission?: Record<string, unknown> }>
    | null = null,
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
  const warningText: any = { dataset: {}, textContent: '' };
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
    if (channel === 'prefs.getTaskNotifications') {
      return getResult || { ok: true, enabled: storedEnabled, permission };
    }
    if (channel === 'prefs.setTaskNotifications') {
      const resolved = await setResult;
      return resolved.ok
        ? { ok: true, enabled: resolved.enabled ?? !!payload?.enabled }
        : resolved;
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
        'settings-task-notification-permission-text': warningText,
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
    warningText,
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

  it('keeps a non-actionable permission row actually hidden', () => {
    expect(styleSource).toMatch(
      /\.settings-row\[hidden\]\s*{[^}]*display:\s*none\s*!important\s*;/s,
    );
  });

  it('ships localized badge-only recovery copy and an independently addressable status node', () => {
    expect(htmlSource).toMatch(/id="settings-task-notification-permission-text"/);
    for (const locale of taskNotificationLocales) {
      expect(locale['settings.task_notifications.presentation_disabled']).toBeTypeOf('string');
      expect(locale['settings.task_notifications.presentation_disabled'].trim()).not.toBe('');
    }
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
    expect(click).not.toHaveBeenCalledWith('task_notification_toggle', expect.anything());
    expect(event).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('task notification toggle saved', {
      previous_enabled: false,
      enabled: true,
      permission_state: 'unknown',
    });
  });

  it('keeps an early user change when the initial preference read resolves late', async () => {
    const deferred = Promise.withResolvers<{
      ok: boolean;
      enabled: boolean;
      permission: { state: string; can_open_settings: boolean };
    }>();
    const { sandbox, checkbox, listeners } = loadHarness(
      { ok: true },
      { state: 'granted', can_open_settings: true },
      true,
      deferred.promise,
    );

    sandbox._settingsRenderTaskNotifications();
    const refresh = sandbox._settingsRefreshTaskNotifications();
    checkbox.checked = false;
    await listeners.get('change')!();
    deferred.resolve({
      ok: true,
      enabled: true,
      permission: { state: 'granted', can_open_settings: true },
    });
    await refresh;

    expect(checkbox.checked).toBe(false);
  });

  it('keeps a denied OS permission when its refresh races with an enabling write', async () => {
    const permissionRead = Promise.withResolvers<{
      ok: boolean;
      enabled: boolean;
      permission: { state: string; can_open_settings: boolean };
    }>();
    const preferenceWrite = Promise.withResolvers<{ ok: boolean; enabled: boolean }>();
    const h = loadHarness(
      preferenceWrite.promise,
      { state: 'granted', can_open_settings: true },
      false,
      permissionRead.promise,
    );
    vm.runInNewContext(`_settingsState.taskNotifications = {
      enabled: false,
      permission: { state: 'granted', can_open_settings: true },
    }`, h.sandbox);
    h.sandbox._settingsRenderTaskNotifications();

    const refresh = h.sandbox._settingsRefreshTaskNotifications('window_focus');
    h.checkbox.checked = true;
    const toggle = h.listeners.get('change')!();
    permissionRead.resolve({
      ok: true,
      enabled: false,
      permission: { state: 'denied', can_open_settings: true },
    });
    await refresh;

    expect(h.checkbox.checked).toBe(true);
    expect(h.warning.hidden).toBe(false);
    expect(h.openButton.hidden).toBe(false);

    preferenceWrite.resolve({ ok: true, enabled: true });
    await toggle;

    expect(h.checkbox.checked).toBe(true);
    expect(h.warning.hidden).toBe(false);
    expect(h.openButton.hidden).toBe(false);
    expect(h.event).not.toHaveBeenCalled();
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
      actual_enabled: false,
      error_code: 'update_rejected',
    });
  });

  it('does not report success when persistence returns a different saved value', async () => {
    const { sandbox, checkbox, listeners, event, logger } = loadHarness({ ok: true, enabled: false });
    await sandbox._settingsRefreshTaskNotifications();
    sandbox._settingsRenderTaskNotifications();
    checkbox.checked = true;

    await listeners.get('change')!();

    expect(checkbox.checked).toBe(false);
    expect(event).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('set task notifications rejected', {
      target_enabled: true,
      actual_enabled: false,
      error_code: 'update_mismatch',
    });
  });

  it('does not emit a synthetic permission state when preference loading is rejected', async () => {
    const { sandbox, event } = loadHarness(
      { ok: true },
      { state: 'denied', can_open_settings: true },
      false,
      { ok: false },
    );

    await expect(sandbox._settingsRefreshTaskNotifications()).resolves.toBe(false);

    expect(event).not.toHaveBeenCalledWith('task_notification_permission_state', expect.anything());
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

  it('explains when macOS permits only a badge but no visible notification', async () => {
    const permission = { state: 'presentation_disabled', can_open_settings: true };
    const {
      sandbox,
      warning,
      warningText,
      openButton,
      windowListeners,
      scheduled,
      event,
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
    expect(warningText.dataset.i18n).toBe('settings.task_notifications.presentation_disabled');
    expect(warningText.textContent).toBe('settings.task_notifications.presentation_disabled');
    expect(event).not.toHaveBeenCalled();

    permission.state = 'granted';
    windowListeners.get('focus')!();
    await scheduled.shift()!();

    expect(warning.hidden).toBe(true);
    expect(event).not.toHaveBeenCalled();
  });

  it('keeps the badge-only warning actionable only when the platform exposes settings', async () => {
    const { sandbox, warning, openButton } = loadHarness(
      { ok: true },
      { state: 'presentation_disabled', can_open_settings: false },
      true,
    );

    await sandbox._settingsRefreshTaskNotifications();
    sandbox._settingsRenderTaskNotifications();

    expect(warning.hidden).toBe(false);
    expect(openButton.hidden).toBe(true);
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

  it.each(['denied', 'presentation_disabled'])(
    'does not warn about %s OS state while the Orkas notification preference is off',
    async (permissionState) => {
      const { sandbox, warning } = loadHarness(
        { ok: true },
        { state: permissionState, can_open_settings: true },
      );
      await sandbox._settingsRefreshTaskNotifications();
      sandbox._settingsRenderTaskNotifications();

      expect(warning.hidden).toBe(true);
    },
  );

  it('keeps an unrequested permission observable without presenting it as disabled', async () => {
    const { sandbox, warning, event } = loadHarness(
      { ok: true },
      { state: 'not_determined', can_open_settings: true },
      true,
    );
    await sandbox._settingsRefreshTaskNotifications();
    sandbox._settingsRenderTaskNotifications();

    expect(warning.hidden).toBe(true);
    expect(event).not.toHaveBeenCalled();
  });
});
