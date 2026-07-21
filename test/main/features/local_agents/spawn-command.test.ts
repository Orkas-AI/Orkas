import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildCliSpawnEnv,
  resolveCliCommand,
} from '../../../../src/main/features/local_agents/spawn-command';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

describe('local_agents/spawn-command', () => {
  it('leaves native executables unchanged', () => {
    expect(resolveCliCommand('/usr/local/bin/claude', ['--version'], 'darwin')).toEqual({
      command: '/usr/local/bin/claude',
      args: ['--version'],
    });
    expect(resolveCliCommand('C:\\Tools\\codex.exe', ['run'], 'win32')).toEqual({
      command: 'C:\\Tools\\codex.exe',
      args: ['run'],
    });
  });

  it('routes Windows command shims through ComSpec with shell metacharacters escaped', () => {
    const resolved = resolveCliCommand(
      'C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd',
      ['--model', 'value & echo unsafe', '100%'],
      'win32',
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    );

    expect(resolved.command).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(resolved.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(resolved.args[3]).toContain('claude.cmd');
    expect(resolved.args[3]).toContain('^^^&');
    expect(resolved.args[3]).toContain('^^^%');
    expect(resolved.windowsVerbatimArguments).toBe(true);
  });

  it('recognizes case-insensitive .bat shims and falls back to cmd.exe', () => {
    const resolved = resolveCliCommand('C:\\Tools\\RUN.BAT', ['one'], 'win32', {});

    expect(resolved.command).toBe('cmd.exe');
    expect(resolved.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(resolved.windowsVerbatimArguments).toBe(true);
  });

  it.runIf(process.platform === 'win32')('round-trips hostile arguments through a real npm-style .cmd shim', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cmd-shim-'));
    try {
      const capture = path.join(tmpDir, 'capture.cjs');
      const shim = path.join(tmpDir, 'node_modules', '.bin', 'capture.cmd');
      fs.mkdirSync(path.dirname(shim), { recursive: true });
      fs.writeFileSync(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
      fs.writeFileSync(shim, [
        '@echo off',
        `"%ORKAS_TEST_NODE%" "${capture}" %*`,
        '',
      ].join('\r\n'));
      const args = ['plain', 'space value', 'value & echo unsafe', '100%', 'quote"value', 'C:\\tail\\'];
      const env = {
        ...process.env,
        ORKAS_TEST_NODE: TEST_NODE,
        ComSpec: process.env.ComSpec || process.env.COMSPEC || 'cmd.exe',
      };
      const resolved = resolveCliCommand(shim, args, 'win32', env);
      const result = spawnSync(resolved.command, resolved.args, {
        encoding: 'utf8',
        env,
        windowsHide: true,
        windowsVerbatimArguments: resolved.windowsVerbatimArguments,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(args);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('augments a minimal macOS GUI PATH for npm-installed CLIs', () => {
    const env = buildCliSpawnEnv(
      '/Users/user/.npm-global/bin/codex',
      { PATH: '/usr/bin:/bin' },
      'darwin',
      '/Users/user',
    );
    const entries = env.PATH!.split(':');

    expect(entries).toEqual(expect.arrayContaining([
      '/Users/user/.npm-global/bin',
      '/Users/user/.local/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]));
    expect(entries.filter(entry => entry === '/usr/bin')).toHaveLength(1);
  });

  it('builds a case-insensitive, semicolon-delimited Windows PATH', () => {
    const env = buildCliSpawnEnv(
      'C:\\Users\\Alice\\AppData\\Roaming\\npm\\codex.cmd',
      {
        Path: 'C:\\Windows\\System32;C:\\Tools;c:\\tools',
        APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local',
        VOLTA_HOME: 'C:\\Users\\Alice\\.volta',
        PNPM_HOME: 'D:\\pnpm',
      },
      'win32',
      'C:\\Users\\Alice',
    );
    const entries = env.PATH!.split(';');

    expect(entries.slice(0, 2)).toEqual(['C:\\Windows\\System32', 'C:\\Tools']);
    expect(entries.filter(entry => entry.toLowerCase() === 'c:\\tools')).toHaveLength(1);
    expect(entries).toEqual(expect.arrayContaining([
      'C:\\Users\\Alice\\AppData\\Roaming\\npm',
      'C:\\Users\\Alice\\AppData\\Local\\Programs\\nodejs',
      'C:\\Users\\Alice\\.volta\\bin',
      'D:\\pnpm',
    ]));
  });
});
