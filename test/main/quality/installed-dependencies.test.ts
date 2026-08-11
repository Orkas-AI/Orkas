import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_PC_ROOT,
  formatDriftReport,
  installedDependencyDrift,
} from '../../../scripts/check-installed-dependencies.mjs';

function fakeProject(spec: {
  declared: Record<string, string>;
  lock: Record<string, { version: string; optional?: boolean }>;
  installed: Record<string, string>;
}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'orkas-dep-drift-'));
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ dependencies: spec.declared }),
  );
  writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      packages: Object.fromEntries(
        Object.entries(spec.lock).map(([name, entry]) => [`node_modules/${name}`, entry]),
      ),
    }),
  );
  for (const [name, version] of Object.entries(spec.installed)) {
    const dir = path.join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  }
  return root;
}

// A merge that advances the lockfile leaves whatever was installed before in
// place, and the resulting test failures name the wrong culprit: a stale SDK
// reported that it could not resolve a current model id, which reads as a
// broken model catalog. This guard exists to say the real reason first.
describe('installed dependency drift guard', () => {
  it('reports a package whose installed version trails the lockfile', () => {
    const root = fakeProject({
      declared: { alpha: '^1.0.0' },
      lock: { alpha: { version: '1.2.0' } },
      installed: { alpha: '1.0.3' },
    });
    try {
      const { drifted } = installedDependencyDrift(root);
      expect(drifted).toEqual([{ name: 'alpha', expected: '1.2.0', installed: '1.0.3' }]);
      const report = formatDriftReport(drifted);
      expect(report).toContain('alpha: lockfile 1.2.0, installed 1.0.3');
      expect(report).toContain('npm install');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a declared package that is not installed at all', () => {
    const root = fakeProject({
      declared: { beta: '^2.0.0' },
      lock: { beta: { version: '2.1.0' } },
      installed: {},
    });
    try {
      const { drifted } = installedDependencyDrift(root);
      expect(drifted).toEqual([{ name: 'beta', expected: '2.1.0', installed: null }]);
      expect(formatDriftReport(drifted)).toContain('(missing)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Platform-specific optionals are legitimately absent, and a guard that cried
  // wolf on every macOS checkout would be turned off within a week.
  it('ignores an absent optional package', () => {
    const root = fakeProject({
      declared: { gamma: '^3.0.0' },
      lock: { gamma: { version: '3.0.0', optional: true } },
      installed: {},
    });
    try {
      expect(installedDependencyDrift(root).drifted).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes when every declared package matches', () => {
    const root = fakeProject({
      declared: { alpha: '^1.0.0', beta: '^2.0.0' },
      lock: { alpha: { version: '1.2.0' }, beta: { version: '2.1.0' } },
      installed: { alpha: '1.2.0', beta: '2.1.0' },
    });
    try {
      const { checked, drifted } = installedDependencyDrift(root);
      expect(checked).toBe(2);
      expect(drifted).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The runner calls this on every invocation, so the real tree must be clean —
  // otherwise every test run in this repository starts with a false alarm.
  it('finds no drift in the checked-in project itself', () => {
    const { checked, drifted } = installedDependencyDrift(DEFAULT_PC_ROOT);
    expect(checked).toBeGreaterThan(10);
    expect(drifted).toEqual([]);
  });
});
