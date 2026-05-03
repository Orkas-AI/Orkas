import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectAll,
  detectOne,
  invalidateCache,
  LOCAL_CLI_TYPES,
} from '../../../../src/main/features/local_agents/registry';

const isWindows = process.platform === 'win32';

describe('local_agents/registry', () => {
  let tmpDir: string;
  let savedPath: string | undefined;
  let savedEnvOverrides: Record<string, string | undefined> = {};

  const ENV_KEYS = [
    'ORKAS_CLAUDE_PATH',
    'ORKAS_CODEX_PATH',
    'ORKAS_OPENCLAW_PATH',
    'ORKAS_OPENCODE_PATH',
    'ORKAS_HERMES_PATH',
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-registry-'));
    savedPath = process.env.PATH;
    savedEnvOverrides = {};
    for (const k of ENV_KEYS) {
      savedEnvOverrides[k] = process.env[k];
      delete process.env[k];
    }
    invalidateCache();
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    for (const k of ENV_KEYS) {
      const v = savedEnvOverrides[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    invalidateCache();
  });

  it('returns one entry per known CLI type', async () => {
    process.env.PATH = '';
    const result = await detectAll();
    const types = result.map(r => r.type).sort();
    expect(types).toEqual([...LOCAL_CLI_TYPES].sort());
  });

  it('marks not_found when binary missing on PATH', async () => {
    process.env.PATH = tmpDir;
    const r = await detectOne('opencode');
    expect(r.available).toBe(false);
    expect(r.error).toBe('not_found');
    expect(r.type).toBe('opencode');
  });

  it('honors ORKAS_<TYPE>_PATH override', async () => {
    if (isWindows) return; // covered by which.test.ts on Windows
    const fake = path.join(tmpDir, 'my-claude');
    // Print a version that satisfies the claude minimum so it ends up "available".
    fs.writeFileSync(fake, '#!/bin/sh\necho "2.0.0"\n');
    fs.chmodSync(fake, 0o755);
    process.env.PATH = '';
    process.env.ORKAS_CLAUDE_PATH = fake;

    const r = await detectOne('claude');
    expect(r.path).toBe(fake);
    expect(r.version).toBe('2.0.0');
    expect(r.available).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('marks version_too_old when below minimum', async () => {
    if (isWindows) return;
    const fake = path.join(tmpDir, 'old-claude');
    fs.writeFileSync(fake, '#!/bin/sh\necho "1.5.0"\n');
    fs.chmodSync(fake, 0o755);
    process.env.PATH = '';
    process.env.ORKAS_CLAUDE_PATH = fake;

    const r = await detectOne('claude');
    expect(r.available).toBe(false);
    expect(r.error).toBe('version_too_old');
    expect(r.errorDetail).toMatch(/below required minimum/);
  });

  it('marks version_unknown when --version output has no semver', async () => {
    if (isWindows) return;
    const fake = path.join(tmpDir, 'mute-cli');
    fs.writeFileSync(fake, '#!/bin/sh\necho "no version"\n');
    fs.chmodSync(fake, 0o755);
    process.env.PATH = '';
    process.env.ORKAS_OPENCODE_PATH = fake;

    const r = await detectOne('opencode');
    expect(r.available).toBe(false);
    expect(r.error).toBe('version_unknown');
    expect(r.path).toBe(fake);
  });

  it('detectAll caches results within the TTL window', async () => {
    if (isWindows) return;
    const fake = path.join(tmpDir, 'ok-opencode');
    fs.writeFileSync(fake, '#!/bin/sh\necho "0.10.0"\n');
    fs.chmodSync(fake, 0o755);
    process.env.PATH = '';
    process.env.ORKAS_OPENCODE_PATH = fake;

    const first = await detectAll();
    const opencodeFirst = first.find(e => e.type === 'opencode')!;
    expect(opencodeFirst.available).toBe(true);

    // Delete the binary; cached result should still report available.
    fs.rmSync(fake);
    const cached = await detectAll();
    expect(cached.find(e => e.type === 'opencode')!.available).toBe(true);

    // Force re-detect bypasses cache.
    const fresh = await detectAll({ force: true });
    expect(fresh.find(e => e.type === 'opencode')!.available).toBe(false);
  });
});
