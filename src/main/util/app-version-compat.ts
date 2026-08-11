export type VersionComparison = -1 | 0 | 1;

export interface ParsedSemver {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
  build: string[];
  normalized: string;
}

const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Parse one complete semantic version. Invalid or partial versions fail closed. */
export function parseSemver(value: unknown): ParsedSemver | null {
  const text = typeof value === 'string' ? value.trim() : '';
  const match = SEMVER_RE.exec(text);
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    return null;
  }
  const build = match[5] ? match[5].split('.') : [];
  const core = `${match[1]}.${match[2]}.${match[3]}`;
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease,
    build,
    normalized: `${core}${prerelease.length ? `-${prerelease.join('.')}` : ''}${build.length ? `+${build.join('.')}` : ''}`,
  };
}

export function normalizeSemver(value: unknown): string {
  return parseSemver(value)?.normalized || '';
}

/** Compare semantic precedence. Build metadata deliberately does not affect ordering. */
export function compareVersions(a: unknown, b: unknown): VersionComparison | null {
  const aa = parseSemver(a);
  const bb = parseSemver(b);
  if (!aa || !bb) return null;

  for (const key of ['major', 'minor', 'patch'] as const) {
    const av = BigInt(aa[key]);
    const bv = BigInt(bb[key]);
    if (av > bv) return 1;
    if (av < bv) return -1;
  }

  if (aa.prerelease.length === 0 && bb.prerelease.length === 0) return 0;
  if (aa.prerelease.length === 0) return 1;
  if (bb.prerelease.length === 0) return -1;
  const count = Math.max(aa.prerelease.length, bb.prerelease.length);
  for (let i = 0; i < count; i += 1) {
    const av = aa.prerelease[i];
    const bv = bb.prerelease[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    const aNumeric = /^\d+$/.test(av);
    const bNumeric = /^\d+$/.test(bv);
    if (aNumeric && bNumeric) return BigInt(av) > BigInt(bv) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return av > bv ? 1 : -1;
  }
  return 0;
}

/** Compatibility export for old callers. Prefer parseSemver/compareVersions. */
export function versionTokens(value: unknown): Array<number | string> {
  const parsed = parseSemver(value);
  if (!parsed) return [];
  return [parsed.major, parsed.minor, parsed.patch, ...parsed.prerelease];
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
  const compared = compareVersions(currentVersion, min);
  return compared !== null && compared >= 0;
}
