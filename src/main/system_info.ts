import * as os from 'node:os';

type ElectronProcess = NodeJS.Process & { getSystemVersion?: () => string };

export type DesktopPlatform = 'mac' | 'windows' | 'pc';

export function preferredSystemLanguage(languages: unknown): string {
  if (!Array.isArray(languages)) return 'und';
  const first = languages.find((value) => typeof value === 'string' && value.trim());
  if (typeof first !== 'string') return 'und';
  try {
    const canonical = Intl.getCanonicalLocales(first.trim().replace(/_/g, '-'))[0] || '';
    return canonical && canonical.length <= 64 ? canonical : 'und';
  } catch {
    return 'und';
  }
}

export function osVersion(): string {
  try {
    const getSystemVersion = (process as ElectronProcess).getSystemVersion;
    if (typeof getSystemVersion === 'function') {
      const version = getSystemVersion.call(process);
      if (version) return String(version);
    }
  } catch {
    /* fallback below */
  }
  return os.release();
}

export function desktopPlatform(platform: string = process.platform): DesktopPlatform {
  const raw = String(platform || '').trim().toLowerCase();
  if (raw === 'darwin' || raw === 'mac' || raw === 'macos') return 'mac';
  if (raw === 'win32' || raw === 'win64' || raw === 'windows' || raw === 'win') return 'windows';
  return 'pc';
}
