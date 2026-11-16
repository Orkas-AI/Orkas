import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
const { shouldProvisionWhisper } = require(
  path.join(process.cwd(), 'scripts', 'ensure-dev-dependencies.cjs'),
) as {
  shouldProvisionWhisper: (platform: string, arch: string) => boolean;
};

describe('ensure-dev-dependencies.cjs', () => {
  it.each([
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['win32', 'x64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
  ])('keeps Whisper required for supported target %s-%s', (platform, arch) => {
    expect(shouldProvisionWhisper(platform, arch)).toBe(true);
  });

  it.each([
    ['win32', 'arm64'],
  ])('does not provision Whisper for unsupported target %s-%s', (platform, arch) => {
    expect(shouldProvisionWhisper(platform, arch)).toBe(false);
  });
});


const entry = path.resolve('scripts/ensure-dev-dependencies.cjs');
const requireScript = createRequire(entry);

// Execute the CLI entry, preserving its actual readiness/error boundary. Only
// provisioning children are controlled; no downloads or toolchains are needed.
async function prepare(platform = 'darwin', fail = '', fault = 'exit') {
  const calls: string[] = [];
  const completed = new Set<string>();
  const messages: string[] = [];
  let active = 0;
  let peak = 0;
  let readyWhileActive = false;
  let exitWhileActive = false;
  let exitCode = 0;
  let nativePrerequisites: string[] = [];
  const result = (args: string[]) => {
    const name = path.basename(args[0]) + (args.includes('--host-only') ? ':host' : '');
    calls.push(name);
    if (name === 'verify-native-dependencies.cjs') nativePrerequisites = [...completed];
    return { name, status: name === fail ? 1 : 0 };
  };
  const req = (name: string) => name === 'node:child_process' ? {
    spawn: (_node: string, args: string[]) => {
      const record = result(args);
      const child = new EventEmitter();
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        if (record.status && fault === 'spawn') child.emit('error', new Error('controlled launch failure'));
        active--;
        completed.add(record.name);
        child.emit('close', record.status && fault !== 'exit' ? null : record.status,
          record.status && fault === 'signal' ? 'SIGTERM' : null);
      }, record.name === fail ? 0 : 5);
      return child;
    },
  } : requireScript(name);
  const module = {};
  await vm.runInNewContext(fs.readFileSync(entry, 'utf8'), {
    require: Object.assign(req, { main: module }), module, __dirname: path.dirname(entry),
    process: { execPath: process.execPath, env: {}, platform, arch: platform === 'win32' ? 'x64' : 'arm64',
      exit: (code: number) => { exitCode = code; exitWhileActive = active > 0; } },
    console: {
      log: (message: string) => {
        if (message.includes('built-in dependencies ready')) readyWhileActive = active > 0;
        messages.push(message);
      },
      error: (message: string) => messages.push(message),
    },
  });
  return { calls, completed, messages, peak, readyWhileActive, exitWhileActive, exitCode, nativePrerequisites };
}

describe('development dependency preparation', () => {
  it.each(['darwin', 'win32'])('overlaps independent preparation on %s and waits for every prerequisite', async platform => {
    const run = await prepare(platform);
    expect(run.peak, run.messages.join('\n')).toBe(2);
    expect(run.readyWhileActive).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.nativePrerequisites).toEqual(expect.arrayContaining([
      'ensure-sqlite-electron-abi.mjs', 'ensure-runtime.cjs', 'build-phone-passkey.cjs',
    ]));
    expect(run.completed).toEqual(new Set([
      'verify-native-dependencies.cjs:host', 'build-notification-permission-addon.cjs',
      'ensure-sqlite-electron-abi.mjs', 'build-phone-passkey.cjs', 'ensure-runtime.cjs',
      'fetch-embedding-model.mjs', 'fetch-officecli.cjs', 'fetch-ffmpeg.cjs',
      'verify-native-dependencies.cjs', 'fetch-whisper.cjs', 'fetch-libraw.cjs',
      ...(platform === 'win32' ? ['fetch-win-vc-runtime.cjs'] : []),
    ]));
    expect(run.messages.at(-1)).toContain('built-in dependencies ready');
  });

  it.each(['verify-native-dependencies.cjs:host', 'build-phone-passkey.cjs', 'verify-native-dependencies.cjs', 'fetch-embedding-model.mjs'])(
    'fails readiness and drains running preparation after %s fails', async fail => {
      const run = await prepare('darwin', fail);
      expect(run.calls).toContain(fail);
      expect(run.exitCode).toBe(1);
      expect(run.exitWhileActive).toBe(false);
      expect(run.messages.join('\n')).not.toContain('built-in dependencies ready');
      expect(run.messages.at(-1)).toContain('failed');
      if (fail === 'build-phone-passkey.cjs') expect(run.calls).not.toContain('ensure-runtime.cjs');
      if (fail === 'fetch-embedding-model.mjs') expect(run.calls).not.toContain('fetch-officecli.cjs');
      if (fail.endsWith(':host')) expect(run.calls).toEqual([fail]);
    },
  );

  it('blocks Windows preparation when the VC runtime cannot be prepared', async () => {
    const run = await prepare('win32', 'fetch-win-vc-runtime.cjs');
    expect(run.exitCode).toBe(1);
    expect(run.calls).toEqual(['verify-native-dependencies.cjs:host', 'fetch-win-vc-runtime.cjs']);
    expect(run.messages.join('\n')).not.toContain('built-in dependencies ready');
  });

  it.each(['spawn', 'signal'])('drains the other lane after a child %s failure', async fault => {
    const run = await prepare('darwin', 'fetch-embedding-model.mjs', fault);
    expect(run.calls).toContain('fetch-embedding-model.mjs');
    expect(run.exitCode).toBe(1);
    expect(run.exitWhileActive).toBe(false);
    expect(run.calls).not.toContain('fetch-officecli.cjs');
    expect(run.messages.join('\n')).not.toContain('built-in dependencies ready');
  });
});
