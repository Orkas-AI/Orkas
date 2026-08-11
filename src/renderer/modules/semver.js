(function initOrkasSemver(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.orkasSemver = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

  function parseSemver(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    const match = SEMVER_RE.exec(text);
    if (!match) return null;
    const prerelease = match[4] ? match[4].split('.') : [];
    if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return null;
    return {
      major: match[1], minor: match[2], patch: match[3], prerelease,
    };
  }

  function compareVersions(a, b) {
    const aa = parseSemver(a);
    const bb = parseSemver(b);
    if (!aa || !bb) return null;
    for (const key of ['major', 'minor', 'patch']) {
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

  return Object.freeze({ parseSemver, compareVersions });
}));
