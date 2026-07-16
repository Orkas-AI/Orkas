export function versionTokens(value: unknown): Array<number | string> {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return [];
  return text
    .replace(/^v/i, '')
    .split(/[.+_-]/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

export function compareVersions(a: unknown, b: unknown): number {
  const aa = versionTokens(a);
  const bb = versionTokens(b);
  if (!aa.length || !bb.length) return 0;
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
  }
  return 0;
}

export function normalizeMinAppVersion(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || '';
}

export type MinAppVersionSource = {
  min_app_version?: unknown;
  minAppVersion?: unknown;
  min_version?: unknown;
  minVersion?: unknown;
  min_pc_version?: unknown;
  minPcVersion?: unknown;
};

export function minAppVersionFrom(...sources: Array<MinAppVersionSource | null | undefined>): string {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const min = normalizeMinAppVersion(
      source.min_app_version
        ?? source.minAppVersion
        ?? source.min_version
        ?? source.minVersion
        ?? source.min_pc_version
        ?? source.minPcVersion,
    );
    if (min) return min;
  }
  return '';
}

export function satisfiesMinAppVersion(currentVersion: string, minAppVersion: string): boolean {
  const min = normalizeMinAppVersion(minAppVersion);
  if (!min) return true;
  if (!versionTokens(currentVersion).length) return false;
  return compareVersions(currentVersion, min) >= 0;
}
