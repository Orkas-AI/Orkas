import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { exerciseWindowsInstaller } from '../../helpers/windows-installer-scenario';

const pcRoot = path.resolve(__dirname, '../../..');
const script = path.join(pcRoot, 'scripts/windows-installer-processes.ps1');

describe('Windows installer residual process cleanup', () => {
  it('wires cleanup into the installer before old-version removal', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(pcRoot, 'package.json'), 'utf8'));
    expect(manifest.build.nsis?.include).toBe('scripts/windows-installer.nsh');
    const include = fs.readFileSync(path.join(pcRoot, manifest.build.nsis.include), 'utf8');
    // customInit is an installer-only hook, before CHECK_APP_RUNNING and the
    // old uninstaller. customInstall would run after the locked-file failure.
    expect(include).toContain('!macro customInit');
    expect(include).toContain('windows-installer-processes.ps1');
    expect(fs.existsSync(script)).toBe(true);
  });

  it('replaces the upstream prefix/name check in both installer and uninstaller with the scoped helper', () => {
    const include = fs.readFileSync(path.join(pcRoot, 'scripts/windows-installer.nsh'), 'utf8');
    expect(include).toContain('!macro customCheckAppRunning');
    expect(include).not.toContain('!insertmacro _CHECK_APP_RUNNING');
  });

  it.runIf(process.platform === 'win32')('preserves the installer ancestor when an uninstaller requests cleanup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-control-ancestor-'));
    try {
      fs.writeFileSync(path.join(root, 'Orkas.exe'), 'fixture installation marker');
      const ancestor = path.join(root, 'installer.exe');
      fs.copyFileSync(process.env.ORKAS_TEST_NODE!, ancestor);
      const powershell = path.win32.join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
      const uninstaller = `const r = require('node:child_process').spawnSync(${JSON.stringify(powershell)}, ${JSON.stringify(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-InstallDir', root, '-InstallerProcessId'])}.concat(String(process.pid)), {timeout:15000, encoding:'utf8', windowsHide:true}); if(r.stdout || r.stderr) process.stderr.write(r.stdout+r.stderr); process.exit(r.status ?? 9);`;
      const parent = `const r = require('node:child_process').spawnSync(${JSON.stringify(process.env.ORKAS_TEST_NODE)}, ['-e', ${JSON.stringify(uninstaller)}], {timeout:18000,encoding:'utf8',windowsHide:true}); process.stdout.write('installer-alive:' + r.status); if(r.stderr) process.stderr.write(r.stderr); process.exit(r.status ?? 8);`;
      const result = spawnSync(ancestor, ['-e', parent], {
        timeout: 20000, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('installer-alive:0');
      expect(result.stderr).toBe('');
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }, 25000);

  it.runIf(process.platform === 'win32')(
    'releases orphaned app/runtime executables while preserving a sibling install and the installer',
    async () => {
      await exerciseWindowsInstaller(process.env.ORKAS_TEST_NODE!, script);
    }, 60_000,
  );

});
