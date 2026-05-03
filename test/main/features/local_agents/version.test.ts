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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts the semver from --version stdout', async () => {
    if (isWindows) return; // Windows .cmd version harness is brittle; covered indirectly.
    const binPath = path.join(tmpDir, 'fake-cli');
    fs.writeFileSync(binPath, '#!/bin/sh\necho "claude 2.1.100 (Claude Code)"\n');
    fs.chmodSync(binPath, 0o755);
    expect(await detectVersion(binPath)).toBe('2.1.100');
  });

  it('falls back to stderr when stdout is empty', async () => {
    if (isWindows) return;
    const binPath = path.join(tmpDir, 'fake-cli-stderr');
    fs.writeFileSync(binPath, '#!/bin/sh\necho "v0.50.0" 1>&2\n');
    fs.chmodSync(binPath, 0o755);
    expect(await detectVersion(binPath)).toBe('0.50.0');
  });

  it('returns null when binary cannot run', async () => {
    expect(await detectVersion(path.join(tmpDir, 'nonexistent'))).toBeNull();
  });

  it('returns null when output has no semver', async () => {
    if (isWindows) return;
    const binPath = path.join(tmpDir, 'noisy-cli');
    fs.writeFileSync(binPath, '#!/bin/sh\necho "no version here"\n');
    fs.chmodSync(binPath, 0o755);
    expect(await detectVersion(binPath)).toBeNull();
  });
});
