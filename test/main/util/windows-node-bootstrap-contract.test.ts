import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const pcRoot = process.cwd();

describe('Windows no-Node startup bootstrap contract', () => {
  it('routes run.cmd through the pinned bootstrap before dependency preparation', () => {
    const runCmd = fs.readFileSync(path.join(pcRoot, 'run.cmd'), 'utf8');
    const bootstrapIndex = runCmd.indexOf(
      'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\\scripts\\bootstrap-node.ps1"',
    );
    const depsIndex = runCmd.indexOf('scripts\\ensure-deps.cjs');

    expect(bootstrapIndex).toBeGreaterThan(0);
    expect(depsIndex).toBeGreaterThan(bootstrapIndex);
    expect(runCmd).toContain('set "RUNTIME_KEY=win32-x64"');
    expect(runCmd).toContain('if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "RUNTIME_KEY=win32-arm64"');
    expect(runCmd).toContain('set "PATH=%APP_DIR%\\resources\\runtime\\node\\!RUNTIME_KEY!;%PATH%"');
    expect(runCmd).toContain('Node.js is still unavailable after bootstrap');
  });

  it('keeps cache, integrity, self-check, and rollback gates in the PowerShell entry', () => {
    const source = fs.readFileSync(
      path.join(pcRoot, 'scripts', 'bootstrap-node.ps1'),
      'utf8',
    );

    expect(source).toContain('[string]$PcRoot = (Split-Path -Parent $PSScriptRoot)');
    expect(source).toContain('[string]$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()');
    expect(source).toContain('$marker.schema -ne 1');
    expect(source).toContain('$marker.sha256 -ne $asset.sha256');
    expect(source).toContain('$actualSize -ne [int64]$asset.size');
    expect(source).toContain('Get-FileHash -Algorithm SHA256');
    expect(source).toContain('$version -ne "v$($nodeSpec.version)"');
    expect(source).toContain('Move-Item -LiteralPath $nodeRoot -Destination $backupRoot');
    expect(source).toContain('Move-Item -LiteralPath $backupRoot -Destination $nodeRoot');
    expect(source).toContain('Remove-Item -Recurse -Force -LiteralPath $tempRoot');
  });

  it('runs the real PowerShell integration before the real Whisper smoke', () => {
    const runner = fs.readFileSync(
      path.join(pcRoot, 'scripts', 'run-windows-native-tests.mjs'),
      'utf8',
    );
    const integration = 'windows-node-bootstrap.integration.ps1';
    const whisper = 'Windows real bundled whisper transcribes within the performance budget';

    expect(fs.existsSync(path.join(pcRoot, 'test', 'windows', integration))).toBe(true);
    expect(runner.indexOf(integration)).toBeGreaterThan(0);
    expect(runner.indexOf(whisper)).toBeGreaterThan(runner.indexOf(integration));
    expect(runner).toContain("timeout: 5 * 60_000");
    expect(runner).toContain("timeout: 2 * 60_000");

    const packageJson = JSON.parse(fs.readFileSync(path.join(pcRoot, 'package.json'), 'utf8'));
    expect(packageJson.scripts['test:windows-native'])
      .toBe('node scripts/run-windows-native-tests.mjs');
  });

  it('pins both supported Windows architecture assets in the shared runtime manifest', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(pcRoot, 'resources', 'runtime', 'manifest.json'),
      'utf8',
    ));
    for (const architecture of ['win32-x64', 'win32-arm64']) {
      expect(manifest.node.assets[architecture]).toMatchObject({
        name: expect.stringMatching(/\.zip$/),
        size: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        url: expect.stringMatching(/^https:\/\//),
      });
    }
  });
});
