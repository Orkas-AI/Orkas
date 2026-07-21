import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseSemver,
  compareSemver,
  checkMinVersion,
  detectVersion,
  MIN_VERSIONS,
} from '../../../../src/main/features/local_agents/version';

const isWindows = process.platform === 'win32';
const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

function writeVersionCli(tmpDir: string, name: string, output: string, stderr = false): string {
  const binPath = path.join(tmpDir, isWindows ? `${name}.cmd` : name);
  if (isWindows) {
    fs.writeFileSync(binPath, `@echo off\r\n${stderr ? '>&2 ' : ''}echo ${output}\r\n`);
  } else {
    fs.writeFileSync(binPath, `#!/bin/sh\n${stderr ? '>&2 ' : ''}printf '%s\\n' ${JSON.stringify(output)}\n`);
    fs.chmodSync(binPath, 0o755);
  }
  return binPath;
}

describe('local_agents/version › parseSemver', () => {
  it('parses bare semver', () => {
    expect(parseSemver('2.1.100')).toEqual({ major: 2, minor: 1, patch: 100 });
  });

  it('parses v-prefixed semver', () => {
    expect(parseSemver('v0.99.0')).toEqual({ major: 0, minor: 99, patch: 0 });
  });

  it('parses semver embedded in a longer line', () => {
    expect(parseSemver('claude 2.1.100 (Claude Code)')).toEqual({ major: 2, minor: 1, patch: 100 });
  });

  it('returns null for non-semver', () => {
    expect(parseSemver('beta')).toBeNull();
    expect(parseSemver('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseSemver(undefined as unknown as string)).toBeNull();
    expect(parseSemver(null as unknown as string)).toBeNull();
  });
});

describe('local_agents/version › compareSemver', () => {
  it('orders by major / minor / patch', () => {
    const a = parseSemver('1.0.0')!;
    const b = parseSemver('1.0.1')!;
    const c = parseSemver('2.0.0')!;
    expect(compareSemver(a, b)).toBe(-1);
    expect(compareSemver(b, a)).toBe(1);
    expect(compareSemver(a, a)).toBe(0);
    expect(compareSemver(c, b)).toBe(1);
  });
});

describe('local_agents/version › checkMinVersion', () => {
  it('returns null when CLI has no minimum', () => {
    expect(checkMinVersion('opencode', '0.1.0')).toBeNull();
    expect(checkMinVersion('hermes', '0.0.0')).toBeNull();
  });

  it('returns null when detected meets/exceeds the minimum', () => {
    expect(checkMinVersion('claude', MIN_VERSIONS.claude)).toBeNull();
    expect(checkMinVersion('claude', '2.5.0')).toBeNull();
    expect(checkMinVersion('claude', '3.0.0')).toBeNull();
  });

  it('returns an explanatory string when detected is below minimum', () => {
    const msg = checkMinVersion('claude', '1.99.0');
    expect(msg).toMatch(/below required minimum/);
    expect(msg).toContain('claude');
    expect(msg).toContain('1.99.0');
  });

  it('returns null when detected is missing or unparsable (do not gate on noise)', () => {
    expect(checkMinVersion('claude', null)).toBeNull();
    expect(checkMinVersion('claude', 'beta')).toBeNull();
  });
});

describe('local_agents/version › detectVersion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-detect-version-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('extracts the semver from --version stdout', async () => {
    const binPath = writeVersionCli(tmpDir, 'fake-cli', 'claude 2.1.100');
    expect(await detectVersion(binPath)).toBe('2.1.100');
  });

  it('falls back to stderr when stdout is empty', async () => {
    const binPath = writeVersionCli(tmpDir, 'fake-cli-stderr', 'v0.50.0', true);
    expect(await detectVersion(binPath)).toBe('0.50.0');
  });

  it('reads a stderr version even when stdout contains an unparseable banner', async () => {
    const binPath = path.join(tmpDir, isWindows ? 'split-output.cmd' : 'split-output');
    if (isWindows) {
      fs.writeFileSync(binPath, '@echo off\r\necho Hermes Agent\r\n>&2 echo v0.18.2\r\n');
    } else {
      fs.writeFileSync(binPath, '#!/bin/sh\nprintf \'%s\\n\' \'Hermes Agent\'\nprintf \'%s\\n\' \'v0.18.2\' >&2\n');
      fs.chmodSync(binPath, 0o755);
    }
    expect(await detectVersion(binPath)).toBe('0.18.2');
  });

  it('returns null when binary cannot run', async () => {
    expect(await detectVersion(path.join(tmpDir, 'nonexistent'))).toBeNull();
  });

  it('rejects semver-looking output from a failed version command', async () => {
    const binPath = path.join(tmpDir, isWindows ? 'failed-version.cmd' : 'failed-version');
    if (isWindows) {
      fs.writeFileSync(binPath, '@echo off\r\necho usage dependency 9.9.9\r\nexit /b 2\r\n');
    } else {
      fs.writeFileSync(binPath, '#!/bin/sh\nprintf \'%s\\n\' \'usage dependency 9.9.9\'\nexit 2\n');
      fs.chmodSync(binPath, 0o755);
    }
    expect(await detectVersion(binPath)).toBeNull();
  });

  it('returns null when output has no semver', async () => {
    const binPath = writeVersionCli(tmpDir, 'noisy-cli', 'no version here');
    expect(await detectVersion(binPath)).toBeNull();
  });

  it('bounds output from a broken version command', async () => {
    const script = path.join(tmpDir, 'noisy-version.js');
    fs.writeFileSync(script, "process.stdout.write('x'.repeat(128 * 1024)); setInterval(() => {}, 1000);");
    const launcher = path.join(tmpDir, isWindows ? 'noisy-version.cmd' : 'noisy-version');
    if (isWindows) {
      fs.writeFileSync(launcher, `@echo off\r\n"${TEST_NODE}" "${script}"\r\n`);
    } else {
      fs.writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(TEST_NODE)} ${JSON.stringify(script)}\n`);
      fs.chmodSync(launcher, 0o755);
    }
    const startedAt = performance.now();

    expect(await detectVersion(launcher, 10_000)).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });

  it.runIf(isWindows)('times out a Windows command shim and terminates its descendant process tree', async () => {
    const script = path.join(tmpDir, 'hanging-version.js');
    const pidFile = path.join(tmpDir, 'descendant.pid');
    fs.writeFileSync(script, `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(${JSON.stringify(TEST_NODE)}, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true,
});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`);
    const launcher = path.join(tmpDir, 'hanging-version.cmd');
    fs.writeFileSync(launcher, `@echo off\r\n"${TEST_NODE}" "${script}"\r\n`);

    const startedAt = performance.now();
    // Leave enough launch headroom for a heavily loaded Windows CI host; the
    // assertion is about tree termination, not scheduler latency.
    expect(await detectVersion(launcher, 1_500)).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(5_000);

    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const deadline = Date.now() + 2_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(alive).toBe(false);
  });
});
