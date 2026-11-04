import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ file: '' }));
vi.mock('../../../src/main/paths', () => ({ get DEVICE_FILE() { return state.file; } }));
import { createLoginStartup, shouldHideStartupWindow, STARTUP_ARGUMENT } from '../../../src/main/features/login_startup';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'login-startup-')); state.file = path.join(root, 'device.json'); });
afterEach(() => fs.rmSync(root, { force: true, recursive: true }));
function fixture(platform: 'darwin' | 'win32' = 'darwin', available = true) {
  let native: any = platform === 'darwin' ? { openAtLogin: false, status: 'not-registered' } : { openAtLogin: false, executableWillLaunchAtLogin: false };
  const write = vi.fn((settings: any) => { native = platform === 'darwin'
    ? { openAtLogin: settings.openAtLogin, status: settings.openAtLogin ? 'enabled' : 'not-registered' }
    : { openAtLogin: settings.openAtLogin, executableWillLaunchAtLogin: settings.openAtLogin }; });
  let uid = 'a', automations = false;
  const deps = { platform, available, executable: '/Applications/Orkas.app/Orkas', get: vi.fn(() => native), set: write,
    getUser: () => uid, hasEnabledAutomations: vi.fn(async () => automations) };
  const service = createLoginStartup(deps);
  return { service, deps, write, native: (value: any) => { native = value; }, user: (value: string) => { uid = value; }, enabledTasks: () => { automations = true; } };
}
describe('explicit device-local startup consent', () => {
  it.each(['darwin', 'win32'] as const)('defaults off without registering anything, enables/disables through the %s system source', platform => {
    const h = fixture(platform);
    expect(h.service.read()).toMatchObject({ enabled: false, status: 'disabled', available: true });
    expect(h.write).not.toHaveBeenCalled(); expect(fs.existsSync(state.file)).toBe(false);
    expect(h.service.setEnabled(true)).toMatchObject({ enabled: true, status: 'enabled' });
    expect(h.service.setEnabled(false)).toMatchObject({ enabled: false, status: 'disabled' });
    expect(h.write.mock.calls[0][0]).toMatchObject(platform === 'win32' ? { args: [STARTUP_ARGUMENT], openAtLogin: true } : { openAtLogin: true });
  });
  it('does not infer permission from local preferences or re-enable an OS-disabled item', () => {
    fs.writeFileSync(state.file, JSON.stringify({ device_id: 'identity', desktop: { background_enabled: false, startup_enabled: true, future: 4 } }));
    const h = fixture('win32');
    h.native({ openAtLogin: true, executableWillLaunchAtLogin: false });
    expect(h.service.read()).toMatchObject({ enabled: false, status: 'disabled' });
    h.service.setEnabled(true);
    expect(JSON.parse(fs.readFileSync(state.file, 'utf8')).desktop).toMatchObject({ background_enabled: false, future: 4 });
  });
  it('recognizes an approved Windows installation with spaces without changing the registered executable', () => {
    const h = fixture('win32');
    h.deps.executable = 'C:\\Program Files\\Orkas\\Orkas.exe';
    // Electron 42 parses the lookup path as a command line. A bare spaced
    // path reports registration but omits the effective launch item.
    h.deps.get.mockImplementation((options?: any) => ({ openAtLogin: true,
      executableWillLaunchAtLogin: options?.path === '"C:\\Program Files\\Orkas\\Orkas.exe"' }));
    expect(h.service.read()).toMatchObject({ enabled: true, status: 'enabled' });
    expect(h.service.setEnabled(true).enabled).toBe(true);
    expect(h.write).toHaveBeenCalledExactlyOnceWith({ path: 'C:\\Program Files\\Orkas\\Orkas.exe',
      args: ['--orkas-startup'], openAtLogin: true, enabled: true });
  });
  it('reports pending system approval, refused writes and read failure without claiming enabled', () => {
    const h = fixture(); h.write.mockImplementation(() => { h.native({ openAtLogin: true, status: 'requires-approval' }); });
    expect(h.service.setEnabled(true)).toMatchObject({ enabled: false, status: 'approval' });
    h.write.mockImplementation(() => { h.native({ openAtLogin: false, status: 'not-registered' }); });
    expect(() => h.service.setEnabled(true)).toThrow('E_STARTUP_SAVE');
    h.deps.get.mockImplementation(() => { throw new Error('private OS detail'); });
    expect(() => h.service.read()).toThrow('E_STARTUP_READ');
  });
  it('never touches machine startup registration in development or isolated runtimes', () => {
    const h = fixture('darwin', false);
    expect(h.service.read()).toMatchObject({ enabled: false, available: false });
    expect(() => h.service.setEnabled(true)).toThrow('E_STARTUP_UNAVAILABLE');
    expect(h.deps.get).not.toHaveBeenCalled(); expect(h.write).not.toHaveBeenCalled();
  });
  it.each(['not-registered', 'not-found', 'requires-approval', 'unknown'])('does not claim macOS enable success from openAtLogin alone when status is %s', status => {
    const h = fixture(); h.native({ openAtLogin: true, status });
    expect(h.service.read()).toEqual({ enabled: false, available: true, status: status === 'requires-approval' ? 'approval' : 'disabled' });
    expect(h.write).not.toHaveBeenCalled();
  });
  it.each([[false, true], [true, false], [false, false]])('requires both matching Windows registration (%s) and effective system approval (%s)', (openAtLogin, executableWillLaunchAtLogin) => {
    const h = fixture('win32'); h.native({ openAtLogin, executableWillLaunchAtLogin });
    expect(h.service.read().enabled).toBe(false); expect(h.write).not.toHaveBeenCalled();
  });
  it('rejects failed disable and post-write readback failure, retains the OS truth, and supports retry', () => {
    const h = fixture('win32'); h.service.setEnabled(true);
    h.write.mockImplementationOnce(() => {});
    expect(() => h.service.setEnabled(false)).toThrow('E_STARTUP_SAVE');
    expect(h.service.read().enabled).toBe(true);
    h.deps.get.mockImplementationOnce(() => { throw new Error('readback unavailable'); });
    expect(() => h.service.setEnabled(false)).toThrow('E_STARTUP_SAVE');
    expect(h.service.read().enabled).toBe(false);
    expect(h.service.setEnabled(true).enabled).toBe(true);
    expect(fs.existsSync(state.file)).toBe(false);
  });
});
describe('one-time guidance at the automation tab', () => {
  it('coalesces concurrent tab entries and recovers a crashed renderer lease without consuming guidance', async () => {
    vi.useFakeTimers();
    try {
      const h = fixture(); h.enabledTasks();
      const ids = await Promise.all([h.service.claimPrompt(1, 'a'), h.service.claimPrompt(2, 'a')]);
      expect(ids.filter(Boolean)).toHaveLength(1);
      const owner = ids[0] ? 1 : 2, id = ids.find(Boolean);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(h.service.markPromptShown(owner, 'a', id)).toBe(false);
      expect(fs.existsSync(state.file)).toBe(false);
      const retry = await h.service.claimPrompt(3, 'a');
      expect(retry).toEqual(expect.any(String));
      expect(h.service.markPromptShown(3, 'a', retry)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('bounds an unavailable task lookup and permits a later retry without granting startup consent', async () => {
    vi.useFakeTimers();
    try {
      const h = fixture(); h.enabledTasks();
      h.deps.hasEnabledAutomations.mockImplementationOnce(() => new Promise(() => {}));
      const pending = expect(h.service.claimPrompt(1, 'a')).rejects.toThrow('E_STARTUP_READ');
      await vi.advanceTimersByTimeAsync(5001); await pending;
      expect(fs.existsSync(state.file)).toBe(false); expect(h.write).not.toHaveBeenCalled();
      expect(await h.service.claimPrompt(1, 'a')).toEqual(expect.any(String));
    } finally { vi.useRealTimers(); }
  });
  it('requires enabled tasks, an off switch and a never-shown marker; only rendered acknowledgement consumes it', async () => {
    const h = fixture(); expect(await h.service.claimPrompt(1, 'a')).toBeNull();
    h.enabledTasks(); const id = await h.service.claimPrompt(1, 'a'); expect(id).toEqual(expect.any(String));
    expect(await h.service.claimPrompt(2, 'a')).toBeNull();
    expect(h.service.markPromptShown(2, 'a', id)).toBe(false);
    h.service.releasePrompt(1); expect(fs.existsSync(state.file)).toBe(false);
    const next = await h.service.claimPrompt(2, 'a');
    expect(h.service.markPromptShown(2, 'a', next)).toBe(true);
    const reopened = fixture(); reopened.enabledTasks();
    expect(await reopened.service.claimPrompt(1, 'a')).toBeNull();
    expect(h.write).not.toHaveBeenCalled();
  });
  it('does not prompt for already enabled or pending startup and does not consume a marker', async () => {
    const h = fixture(); h.enabledTasks(); h.service.setEnabled(true);
    expect(await h.service.claimPrompt(1, 'a')).toBeNull();
    h.native({ openAtLogin: true, status: 'requires-approval' });
    expect(await h.service.claimPrompt(1, 'a')).toBeNull(); expect(fs.existsSync(state.file)).toBe(false);
  });
  it('invalidates a delayed account result and lets the new account try later', async () => {
    const h = fixture(); let finish!: (enabled: boolean) => void;
    h.deps.hasEnabledAutomations.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.service.claimPrompt(1, 'a'); h.user('b'); finish(true);
    expect(await pending).toBeNull(); h.enabledTasks();
    const id = await h.service.claimPrompt(2, 'b'); expect(id).toEqual(expect.any(String));
    expect(h.service.markPromptShown(2, 'a', id)).toBe(false);
  });
  it('preserves identity and close preferences, and does not consume corrupt storage or failed task reads', async () => {
    const h = fixture(); h.enabledTasks();
    h.deps.hasEnabledAutomations.mockRejectedValueOnce(new Error('unavailable'));
    await expect(h.service.claimPrompt(1, 'a')).rejects.toThrow('E_STARTUP_READ');
    fs.writeFileSync(state.file, JSON.stringify({ device_id: 'stable', future: 7, desktop: { background_enabled: false, close_choice_made: true } }));
    const id = await h.service.claimPrompt(1, 'a'); fs.writeFileSync(state.file, '{bad');
    expect(() => h.service.markPromptShown(1, 'a', id)).toThrow('E_STARTUP_SAVE');
    expect(fs.readFileSync(state.file, 'utf8')).toBe('{bad');
    fs.writeFileSync(state.file, JSON.stringify({ device_id: 'stable', future: 7, desktop: { background_enabled: false, close_choice_made: true } }));
    expect(h.service.markPromptShown(1, 'a', id)).toBe(true);
    expect(JSON.parse(fs.readFileSync(state.file, 'utf8'))).toMatchObject({ device_id: 'stable', future: 7, desktop: { background_enabled: false, close_choice_made: true, startup_prompt_shown: true } });
  });
});
describe('startup presentation is hidden for system startup and visible for manual launch', () => {
  it.each([
    ['darwin', [], true, true, true], ['darwin', [], false, true, false],
    ['win32', [STARTUP_ARGUMENT], false, true, true], ['win32', [STARTUP_ARGUMENT], false, false, true],
    ['win32', [], false, true, false],
  ] as const)('selects the window presentation for %s %j', (platform, argv, wasOpenedAtLogin, background, expected) => {
    expect(shouldHideStartupWindow({ platform, argv: [...argv], wasOpenedAtLogin })).toBe(expected);
  });
});
