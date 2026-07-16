import { describe, expect, it } from 'vitest';

import { resolveCliCommand } from '../../../../src/main/features/local_agents/spawn-command';

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
});
