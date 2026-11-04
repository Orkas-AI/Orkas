import { randomUUID } from 'node:crypto';
import { readDeviceRecord, updateDeviceRecord } from '../util/device-record';

export const STARTUP_ARGUMENT = '--orkas-startup';
interface Dependencies {
  platform: NodeJS.Platform;
  available: boolean;
  executable: string;
  get(options?: { path: string; args: string[] }): { openAtLogin: boolean; status?: string; executableWillLaunchAtLogin?: boolean };
  set(settings: { openAtLogin: boolean; path?: string; args?: string[]; enabled?: boolean }): void;
  getUser(): string;
  hasEnabledAutomations(uid: string): Promise<boolean>;
}
export interface StartupState { enabled: boolean; available: boolean; status: 'enabled' | 'disabled' | 'approval' | 'unavailable' }
const failure = (code: string) => Object.assign(new Error(code), { code });

/** The OS owns startup consent. The device record owns only the one-time UI marker. */
export function createLoginStartup(deps: Dependencies) {
  let pending: { id: string; owner: number; uid: string; expires: number } | null = null;
  const available = deps.available && ['darwin', 'win32'].includes(deps.platform);
  const options = () => deps.platform === 'win32' ? { path: deps.executable, args: [STARTUP_ARGUMENT] } : undefined;
  const read = (): StartupState => {
    if (!available) return { enabled: false, available: false, status: 'unavailable' };
    try {
      const lookup = options();
      // Electron 42 parses the Windows lookup as a command line. Quote the
      // executable so spaced install paths still match effective launch items.
      const native = deps.get(lookup ? { ...lookup, path: `"${deps.executable}"` } : undefined);
      if (deps.platform === 'darwin' && native.status === 'requires-approval') return { enabled: false, available: true, status: 'approval' };
      const enabled = native.openAtLogin === true && (deps.platform === 'darwin'
        ? (!native.status || native.status === 'enabled') : native.executableWillLaunchAtLogin === true);
      return { enabled, available: true, status: enabled ? 'enabled' : 'disabled' };
    } catch { throw failure('E_STARTUP_READ'); }
  };
  const setEnabled = (enabled: boolean) => {
    if (!available) throw failure('E_STARTUP_UNAVAILABLE');
    if (typeof enabled !== 'boolean') throw failure('E_STARTUP_INPUT');
    try {
      deps.set({ ...options(), openAtLogin: enabled, ...(deps.platform === 'win32' ? { enabled } : {}) });
      const result = read();
      if (result.enabled !== enabled && !(enabled && result.status === 'approval')) throw failure('E_STARTUP_SAVE');
      return result;
    } catch { throw failure('E_STARTUP_SAVE'); }
  };
  const releasePrompt = (owner: number) => { if (pending?.owner === owner) pending = null; };
  const claimPrompt = async (owner: number, uid: string) => {
    try {
      if (pending && pending.expires <= Date.now()) pending = null;
      if (pending && pending.uid !== deps.getUser()) pending = null;
      if (pending || uid !== deps.getUser() || read().status !== 'disabled' || readDeviceRecord().desktop?.startup_prompt_shown === true) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hasEnabled = await Promise.race([
        deps.hasEnabledAutomations(uid),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failure('E_STARTUP_READ')), 5000); }),
      ]).finally(() => clearTimeout(timer));
      if (!hasEnabled) return null;
      // Another renderer or account can win while authoritative tasks are read.
      if (pending || uid !== deps.getUser() || read().status !== 'disabled' || readDeviceRecord().desktop?.startup_prompt_shown === true) return null;
      const id = randomUUID(); pending = { id, owner, uid, expires: Date.now() + 30_000 };
      return id;
    } catch { throw failure('E_STARTUP_READ'); }
  };
  const markPromptShown = (owner: number, uid: string, id: unknown) => {
    if (!pending || pending.owner !== owner || pending.uid !== uid || uid !== deps.getUser() || pending.id !== id || pending.expires <= Date.now()) return false;
    try {
      updateDeviceRecord(record => ({ ...record, desktop: { ...record.desktop, startup_prompt_shown: true } }));
      pending = null; return true;
    } catch { throw failure('E_STARTUP_SAVE'); }
  };
  return { read, setEnabled, claimPrompt, markPromptShown, releasePrompt };
}
export function shouldHideStartupWindow(input: { platform: NodeJS.Platform; argv: string[]; wasOpenedAtLogin: boolean }): boolean {
  return (input.platform === 'darwin' ? input.wasOpenedAtLogin : input.platform === 'win32' && input.argv.includes(STARTUP_ARGUMENT));
}
let service: ReturnType<typeof createLoginStartup> | null = null;
export function setLoginStartup(value: ReturnType<typeof createLoginStartup>) { service = value; }
export function getLoginStartup() { if (!service) throw failure('E_STARTUP_UNAVAILABLE'); return service; }
