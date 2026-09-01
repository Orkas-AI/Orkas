import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
const {
  isSourceMainProcess,
  parsePosixProcessList,
  tokenizeCommandLine,
} = requireModule('../../../scripts/stop-source-instance.cjs') as {
  isSourceMainProcess: (
    processInfo: { pid: number; executablePath?: string; commandLine: string },
    appRoot: string,
    platform: NodeJS.Platform,
  ) => boolean;
  parsePosixProcessList: (output: string) => Array<{
    pid: number;
    parentPid: number;
    commandLine: string;
  }>;
  tokenizeCommandLine: (commandLine: string) => string[];
};

describe('source launcher previous-instance cleanup', () => {
  it('matches only the Electron main process owned by the current macOS checkout', () => {
    const appRoot = '/Users/test/Projects/OrkasSource';
    const executable = `${appRoot}/node_modules/electron/dist/Orkas.app/Contents/MacOS/Electron`;

    expect(isSourceMainProcess({
      pid: 120,
      commandLine: `${executable} ${appRoot}`,
    }, appRoot, 'darwin')).toBe(true);

    expect(isSourceMainProcess({
      pid: 121,
      commandLine: `${executable} ${appRoot} --type=renderer`,
    }, appRoot, 'darwin')).toBe(false);

    expect(isSourceMainProcess({
      pid: 122,
      commandLine: `${executable} /Users/test/Projects/OtherCheckout`,
    }, appRoot, 'darwin')).toBe(false);

    expect(isSourceMainProcess({
      pid: 123,
      commandLine: `${appRoot}/node_modules/electron/dist/Orkas.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper --type=gpu-process`,
    }, appRoot, 'darwin')).toBe(false);
  });

  it('supports Linux dot launches without matching a sibling Electron runtime', () => {
    const appRoot = '/opt/work/OrkasSource';
    const executable = `${appRoot}/node_modules/electron/dist/electron`;

    expect(isSourceMainProcess({
      pid: 220,
      commandLine: `${executable} .`,
    }, appRoot, 'linux')).toBe(true);
    expect(isSourceMainProcess({
      pid: 221,
      commandLine: '/opt/work/Orkas/node_modules/electron/dist/electron .',
    }, appRoot, 'linux')).toBe(false);
  });

  it('uses the exact Windows executable path and accepts paths with spaces', () => {
    const appRoot = String.raw`C:\Work Trees\OrkasSource`;
    const executable = path.win32.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');

    expect(isSourceMainProcess({
      pid: 320,
      executablePath: executable,
      commandLine: `"${executable}" "${appRoot}"`,
    }, appRoot, 'win32')).toBe(true);
    expect(isSourceMainProcess({
      pid: 321,
      executablePath: String.raw`C:\Work Trees\Orkas\node_modules\electron\dist\electron.exe`,
      commandLine: String.raw`"C:\Work Trees\Orkas\node_modules\electron\dist\electron.exe" .`,
    }, appRoot, 'win32')).toBe(false);
  });

  it('parses process inventory and quoted launcher arguments', () => {
    expect(parsePosixProcessList([
      '  10     1 /opt/OrkasSource/node_modules/electron/dist/electron .',
      '  11    10 helper --type=renderer',
      '',
    ].join('\n'))).toEqual([
      {
        pid: 10,
        parentPid: 1,
        commandLine: '/opt/OrkasSource/node_modules/electron/dist/electron .',
      },
      {
        pid: 11,
        parentPid: 10,
        commandLine: 'helper --type=renderer',
      },
    ]);
    expect(tokenizeCommandLine('"/Work Trees/electron" "/Work Trees/OrkasSource"'))
      .toEqual(['/Work Trees/electron', '/Work Trees/OrkasSource']);
  });

  it('terminates the Windows process tree by validated PID rather than image name', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'scripts/stop-source-instance.cjs'),
      'utf8',
    );

    expect(source).toContain("execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F']");
    expect(source).toContain('Get-CimInstance Win32_Process');
    expect(source).not.toMatch(/taskkill[^\n]+\/IM/i);
  });
});
