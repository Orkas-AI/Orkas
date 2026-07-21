import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const ensureDeps = require('../../../scripts/ensure-deps.cjs') as {
  dependencyInstallReason(input: {
    nodeModulesExists: boolean;
    stored: string;
    current: string;
    missingPackages: string[];
  }): string;
  missingDeclaredDependencyPackages(options: {
    packageFile: string;
    nodeModulesDir: string;
  }): string[];
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeManifest(nodeModulesDir: string, name: string, contents: unknown = { version: '1.0.0' }) {
  const manifest = path.join(nodeModulesDir, ...name.split('/'), 'package.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

describe('ensure-deps package-tree health', () => {
  it('detects missing and corrupt required package manifests while ignoring optional packages', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-dependency-health-'));
    tempDirs.push(root);
    const packageFile = path.join(root, 'package.json');
    const nodeModulesDir = path.join(root, 'node_modules');
    fs.writeFileSync(packageFile, JSON.stringify({
      dependencies: { ready: '^1.0.0', '@scope/missing': '^1.0.0' },
      devDependencies: { corrupt: '^1.0.0' },
      optionalDependencies: { 'platform-optional': '^1.0.0' },
    }));
    writeManifest(nodeModulesDir, 'ready');
    writeManifest(nodeModulesDir, 'corrupt', '{not-json');

    expect(ensureDeps.missingDeclaredDependencyPackages({ packageFile, nodeModulesDir })).toEqual([
      '@scope/missing',
      'corrupt',
    ]);
  });

  it('requests installation when the fingerprint matches but required packages are incomplete', () => {
    expect(ensureDeps.dependencyInstallReason({
      nodeModulesExists: true,
      stored: 'same',
      current: 'same',
      missingPackages: ['missing-package'],
    })).toBe('packages_incomplete');
    expect(ensureDeps.dependencyInstallReason({
      nodeModulesExists: true,
      stored: 'same',
      current: 'same',
      missingPackages: [],
    })).toBe('');
  });
});
