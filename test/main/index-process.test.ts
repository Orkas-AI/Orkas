import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('main process child-process ownership', () => {
  it('keeps unpackaged E2E launches isolated and hidden by default', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/index.ts'),
      'utf8',
    );

    expect(source).toContain('process.env.ORKAS_E2E_USER_DATA_DIR');
    expect(source).toContain('process.env.ORKAS_E2E_HIDE_WINDOW');
    expect(source).toMatch(
      /else if \(E2E_USER_DATA_DIR\)[\s\S]*app\.setPath\('userData', path\.resolve\(E2E_USER_DATA_DIR\)\)/,
    );
    expect(source).toContain(
      'show: !IS_PACKAGED_LAUNCH_SMOKE && !E2E_HIDE_WINDOW',
    );
  });

  it('passes the exact old-process owner before launching the replacement', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/index.ts'),
      'utf8',
    );
    const relaunchStart = source.indexOf("ipcMain.handle('orkas.relaunch'");
    expect(relaunchStart).toBeGreaterThan(-1);
    const relaunchBlock = source.slice(relaunchStart, relaunchStart + 1_800);

    expect(relaunchBlock).toContain('resolveCliCommand');
    expect(relaunchBlock).toContain('delete childEnv.ORKAS_WORKSPACE_ROOT');
    expect(relaunchBlock).toContain('delete childEnv.CORE_AGENT_AUTH_DIR');
    expect(relaunchBlock).toContain(
      'childEnv.ORKAS_RELAUNCH_OWNER_PID = String(process.pid)',
    );
    expect(relaunchBlock).toContain('detached: true');
    expect(relaunchBlock).toContain("stdio: 'ignore'");
    expect(relaunchBlock).toContain('windowsHide: true');
    expect(relaunchBlock).toContain('windowsVerbatimArguments: resolved.windowsVerbatimArguments');
    expect(relaunchBlock).toContain('env: childEnv');
    expect(relaunchBlock).toContain('child.unref()');
    expect(relaunchBlock).toContain('await openLifecycleTracking?.flushQuit()');

    const shellLauncher = fs.readFileSync(
      path.resolve(process.cwd(), 'run.sh'),
      'utf8',
    );
    const windowsLauncher = fs.readFileSync(
      path.resolve(process.cwd(), 'run.cmd'),
      'utf8',
    );
    expect(shellLauncher).toContain('ORKAS_RELAUNCH_OWNER_PID');
    expect(shellLauncher).toContain('scripts/stop-source-instance.cjs');
    expect(shellLauncher).not.toMatch(/pkill[^\n]+electron\/dist/i);
    expect(windowsLauncher).toContain('ORKAS_RELAUNCH_OWNER_PID');
    expect(windowsLauncher).toContain('scripts\\stop-source-instance.cjs');
    expect(windowsLauncher).not.toMatch(/taskkill[^\n]+electron\.exe/i);
  });
});
