import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import log from 'electron-log/main';
import {
  detectAll,
  detectOne,
  detectPreferredVersion,
  detectPreferredVersionResult,
  findAllInstalled,
  invalidateCache,
  localCliCapabilities,
  localCliSearchDirs,
  localCliResumeStrategy,
  LOCAL_CLI_CAPABILITIES,
  LOCAL_CLI_TYPES,
  VERSION_PROBE_TIMEOUT_MS,
} from '../../../../src/main/features/local_agents/registry';

const isWindows = process.platform === 'win32';

describe('local CLI context capabilities', () => {
  it('declares the complete conversation contract for every registered backend', () => {
    expect(Object.keys(LOCAL_CLI_CAPABILITIES).sort()).toEqual([...LOCAL_CLI_TYPES].sort());
    expect(LOCAL_CLI_CAPABILITIES).toEqual({
      claude: {
        resume: 'native',
        instructionChannel: 'native',
        durableInstructionScope: 'invocation',
        codingProjectDirectory: true,
        orkasBridge: true,
      },
      codex: {
        resume: 'native',
        instructionChannel: 'native',
        durableInstructionScope: 'session',
        codingProjectDirectory: true,
        orkasBridge: true,
      },
      openclaw: {
        resume: 'session-id',
        instructionChannel: 'user-message',
        durableInstructionScope: 'session',
        codingProjectDirectory: false,
        orkasBridge: false,
      },
      opencode: {
        resume: 'native',
        instructionChannel: 'user-message',
        durableInstructionScope: 'session',
        codingProjectDirectory: false,
        orkasBridge: false,
      },
      hermes: {
        resume: 'none',
        instructionChannel: 'user-message',
        durableInstructionScope: 'invocation',
        codingProjectDirectory: false,
        orkasBridge: false,
      },
    });
  });

  it('fails closed for an unknown CLI instead of assuming session persistence', () => {
    expect(localCliCapabilities('unknown')).toEqual({
      resume: 'none',
      instructionChannel: 'user-message',
      durableInstructionScope: 'invocation',
      codingProjectDirectory: false,
      orkasBridge: false,
    });
    expect(localCliResumeStrategy('unknown')).toBe('none');
  });
});

describe('local CLI version probe scheduling', () => {
  it('allows 15 seconds for production version probes', () => {
    expect(VERSION_PROBE_TIMEOUT_MS).toBe(15_000);
  });

  it('starts compatibility probes together while preserving preferred-result order', async () => {
    const started: string[] = [];
    const timeouts: number[] = [];
    const resolvers = new Map<string, (value: string | null) => void>();
    const pending = detectPreferredVersion(
      '/mock/hermes',
      [['version'], ['--version']],
      async (_binPath, timeoutMs, args) => new Promise((resolve) => {
        started.push(args.join(' '));
        timeouts.push(timeoutMs);
        resolvers.set(args.join(' '), resolve);
      }),
    );

    // Both child operations must be admitted before either one settles.
    expect(started).toEqual(['version', '--version']);
    expect(timeouts).toEqual([15_000, 15_000]);
    resolvers.get('--version')?.('9.9.9');
    resolvers.get('version')?.('0.18.2');

    // Declaration order remains authoritative even when the fallback finishes
    // first, matching the documented Hermes `version` preference.
    await expect(pending).resolves.toBe('0.18.2');
  });

  it('does not wait for a lower-priority probe after the preferred one succeeds', async () => {
    const pending = detectPreferredVersion(
      '/mock/hermes',
      [['version'], ['--version']],
      async (_binPath, _timeoutMs, args) => {
        if (args[0] === 'version') return '0.18.2';
        return new Promise<string | null>(() => {});
      },
    );

    await expect(pending).resolves.toBe('0.18.2');
  });

  it('uses the fallback only after all higher-priority probes fail', async () => {
    const settled: string[] = [];
    const result = await detectPreferredVersion(
      '/mock/hermes',
      [['version'], ['--version']],
      async (_binPath, _timeoutMs, args) => {
        settled.push(args[0]);
        if (args[0] === 'version') return null;
        return '0.17.0';
      },
    );

    expect(settled).toEqual(['version', '--version']);
    expect(result).toBe('0.17.0');
  });

  it('treats a rejected probe as unavailable and still accepts a fallback', async () => {
    const result = await detectPreferredVersion(
      '/mock/hermes',
      [['version'], ['--version']],
      async (_binPath, _timeoutMs, args) => {
        if (args[0] === 'version') throw new Error('spawn failed');
        return '0.17.0';
      },
    );

    expect(result).toBe('0.17.0');
  });

  it('reports timeout only when every compatible version probe times out', async () => {
    const allTimedOut = await detectPreferredVersionResult(
      '/mock/hermes',
      [['version'], ['--version']],
      async () => ({ status: 'timeout', version: null }),
    );
    expect(allTimedOut).toEqual({ status: 'timeout', version: null });

    const mixedFailure = await detectPreferredVersionResult(
      '/mock/hermes',
      [['version'], ['--version']],
      async (_binPath, _timeoutMs, args) => args[0] === 'version'
        ? { status: 'failed', version: null }
        : { status: 'timeout', version: null },
    );
    expect(mixedFailure).toEqual({ status: 'failed', version: null });
  });
});

function writeMockCli(basePath: string, output: string): string {
  const binPath = isWindows ? `${basePath}.cmd` : basePath;
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  if (isWindows) {
    fs.writeFileSync(binPath, `@echo off\r\necho ${output}\r\n`);
  } else {
    fs.writeFileSync(binPath, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\n`);
    fs.chmodSync(binPath, 0o755);
  }
  return binPath;
}

function writeArgAwareMockCli(
  basePath: string,
  outputs: Partial<Record<'version' | '--version', string>>,
): string {
  const binPath = isWindows ? `${basePath}.cmd` : basePath;
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  if (isWindows) {
    const lines = ['@echo off'];
    for (const [arg, output] of Object.entries(outputs)) {
      lines.push(
        `if "%~1"=="${arg}" (`,
        `  echo ${output}`,
        '  exit /b 0',
        ')',
      );
    }
    lines.push('echo unsupported version probe', 'exit /b 2', '');
    fs.writeFileSync(binPath, lines.join('\r\n'));
  } else {
    const lines = ['#!/bin/sh', 'case "$1" in'];
    for (const [arg, output] of Object.entries(outputs)) {
      lines.push(
        `  ${arg})`,
        `    printf '%s\\n' ${JSON.stringify(output)}`,
        '    ;;',
      );
    }
    lines.push(
      '  *)',
      "    printf '%s\\n' 'unsupported version probe'",
      '    exit 2',
      '    ;;',
      'esac',
      '',
    );
    fs.writeFileSync(binPath, lines.join('\n'));
    fs.chmodSync(binPath, 0o755);
  }
  return binPath;
}

function writeCountingMockCli(basePath: string, logPath: string): string {
  const scriptPath = `${basePath}.js`;
  const script = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(logPath)}, String(process.argv[2] || '') + '\\n');`,
    "setTimeout(() => process.stdout.write('2.1.0\\n'), 120);",
    '',
  ].join('\n');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, script);
  if (isWindows) {
    const binPath = `${basePath}.cmd`;
    fs.writeFileSync(
      binPath,
      `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
    );
    return binPath;
  }
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('local_agents/registry', () => {
  let tmpDir: string;
  let savedPath: string | undefined;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedPathExt: string | undefined;
  let savedFileLevel: unknown;
  let savedEnvOverrides: Record<string, string | undefined> = {};

  const ENV_KEYS = [
    'ORKAS_CLAUDE_PATH',
    'ORKAS_CODEX_PATH',
    'ORKAS_OPENCLAW_PATH',
    'ORKAS_OPENCODE_PATH',
    'ORKAS_HERMES_PATH',
    'APPDATA',
    'LOCALAPPDATA',
    'VOLTA_HOME',
    'PNPM_HOME',
    'NVM_SYMLINK',
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-registry-'));
    savedPath = process.env.PATH;
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedPathExt = process.env.PATHEXT;
    process.env.HOME = path.join(tmpDir, 'home');
    process.env.USERPROFILE = process.env.HOME;
    if (isWindows) process.env.PATHEXT = '.CMD;.EXE;.BAT';
    fs.mkdirSync(process.env.HOME, { recursive: true });
    fs.mkdirSync(path.join(process.env.HOME, 'Library', 'Logs', 'orkas'), { recursive: true });
    savedFileLevel = log.transports.file.level;
    log.transports.file.level = false;
    savedEnvOverrides = {};
    for (const k of ENV_KEYS) {
      savedEnvOverrides[k] = process.env[k];
      delete process.env[k];
    }
    process.env.APPDATA = path.join(process.env.HOME, 'AppData', 'Roaming');
    process.env.LOCALAPPDATA = path.join(process.env.HOME, 'AppData', 'Local');
    invalidateCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env.PATH = savedPath;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = savedPathExt;
    log.transports.file.level = savedFileLevel as any;
    for (const k of ENV_KEYS) {
      const v = savedEnvOverrides[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    invalidateCache();
  });

  it('returns one entry per known CLI type', async () => {
    process.env.PATH = '';
    const result = await detectAll();
    const types = result.map(r => r.type).sort();
    expect(types).toEqual([...LOCAL_CLI_TYPES].sort());
  });

  it('finds installed CLIs without starting version processes', async () => {
    const probeLog = path.join(tmpDir, 'presence-probe-calls.log');
    const fake = writeCountingMockCli(path.join(tmpDir, 'present-opencode'), probeLog);
    process.env.PATH = '';
    process.env.ORKAS_CLAUDE_PATH = path.join(tmpDir, 'missing-claude');
    process.env.ORKAS_CODEX_PATH = path.join(tmpDir, 'missing-codex');
    process.env.ORKAS_OPENCLAW_PATH = path.join(tmpDir, 'missing-openclaw');
    process.env.ORKAS_OPENCODE_PATH = fake;
    process.env.ORKAS_HERMES_PATH = path.join(tmpDir, 'missing-hermes');

    const result = await findAllInstalled();
    const opencode = result.find(entry => entry.type === 'opencode');

    expect(opencode).toEqual({
      type: 'opencode',
      path: fake,
      version: null,
      available: true,
      validation: 'pending',
    });
    expect(fs.existsSync(probeLog)).toBe(false);
  });

  it('marks not_found when binary missing on PATH', async () => {
    process.env.PATH = tmpDir;
    const r = await detectOne('opencode');
    expect(r.available).toBe(false);
    expect(r.error).toBe('not_found');
    expect(r.type).toBe('opencode');
  });

  it('honors ORKAS_<TYPE>_PATH override', async () => {
    const fake = writeMockCli(path.join(tmpDir, 'my-claude'), '2.0.0');
    // Print a version that satisfies the claude minimum so it ends up "available".
    process.env.PATH = '';
    process.env.ORKAS_CLAUDE_PATH = fake;

    const r = await detectOne('claude');
    expect(isWindows ? r.path?.toLowerCase() : r.path).toBe(isWindows ? fake.toLowerCase() : fake);
    expect(r.version).toBe('2.0.0');
    expect(r.available).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('finds Codex in the standalone default ~/.local/bin even when PATH omits it', async () => {
    const binDir = path.join(process.env.HOME!, '.local', 'bin');
    const fake = writeMockCli(path.join(binDir, 'codex'), 'codex-cli 0.145.0');
    process.env.PATH = '';

    // Restrict this probe to the already-asserted default directory so a real
    // newer Codex/ChatGPT app on the developer machine cannot replace the
    // fixture and make the test host-version-dependent.
    const r = await detectOne('codex', { searchDirs: [binDir] });
    expect(isWindows ? r.path?.toLowerCase() : r.path).toBe(isWindows ? fake.toLowerCase() : fake);
    expect(r.version).toBe('0.145.0');
    expect(r.available).toBe(true);
  });

  it('selects the newest Codex installation instead of the first PATH hit', async () => {
    const oldDir = path.join(tmpDir, 'old-codex');
    const newDir = path.join(tmpDir, 'new-codex');
    const oldBin = writeMockCli(path.join(oldDir, 'codex'), 'codex-cli 0.139.0');
    const newBin = writeMockCli(path.join(newDir, 'codex'), 'codex-cli 0.145.0-alpha.18');
    process.env.PATH = `${oldDir}${path.delimiter}${newDir}`;

    // PATH is the subject of this case. Exclude host fallback directories so
    // a bundled GUI-app Codex cannot outrank both controlled candidates.
    const r = await detectOne('codex', { searchDirs: [] });
    expect(isWindows ? r.path?.toLowerCase() : r.path).toBe(isWindows ? newBin.toLowerCase() : newBin);
    expect(r.path).not.toBe(oldBin);
    expect(r.version).toBe('0.145.0');
    expect(r.available).toBe(true);
  });

  it('keeps ORKAS_CODEX_PATH authoritative even when a newer Codex is discoverable', async () => {
    const pinned = writeMockCli(path.join(tmpDir, 'pinned-codex'), 'codex-cli 0.145.0');
    const newerDir = path.join(tmpDir, 'newer-codex');
    writeMockCli(path.join(newerDir, 'codex'), 'codex-cli 0.150.0');
    process.env.PATH = newerDir;
    process.env.ORKAS_CODEX_PATH = pinned;

    const r = await detectOne('codex');
    expect(isWindows ? r.path?.toLowerCase() : r.path).toBe(isWindows ? pinned.toLowerCase() : pinned);
    expect(r.version).toBe('0.145.0');
    expect(r.available).toBe(true);
  });

  it('uses the npm Codex package version when the wrapper has no --version output', async () => {
    if (isWindows) return;
    const pkgRoot = path.join(tmpDir, 'node_modules', '@openai', 'codex');
    const binDir = path.join(pkgRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({
      name: '@openai/codex',
      version: '0.145.0',
    }));
    const fake = path.join(binDir, 'codex.js');
    fs.writeFileSync(fake, '#!/bin/sh\necho ""\n');
    fs.chmodSync(fake, 0o755);
    process.env.PATH = '';
    process.env.ORKAS_CODEX_PATH = fake;

    const r = await detectOne('codex');
    expect(r.path).toBe(fake);
    expect(r.version).toBe('0.145.0');
    expect(r.available).toBe(true);
  });

  it('marks version_too_old when below minimum', async () => {
    const fake = writeMockCli(path.join(tmpDir, 'old-claude'), '1.5.0');
    process.env.PATH = '';
    process.env.ORKAS_CLAUDE_PATH = fake;

    const r = await detectOne('claude');
    expect(r.available).toBe(false);
    expect(r.error).toBe('version_too_old');
    expect(r.errorDetail).toMatch(/below required minimum/);
  });

  it('marks version_unknown when --version output has no semver', async () => {
    const fake = writeMockCli(path.join(tmpDir, 'mute-cli'), 'no version');
    process.env.PATH = '';
    process.env.ORKAS_OPENCODE_PATH = fake;

    const r = await detectOne('opencode');
    expect(r.available).toBe(false);
    expect(r.error).toBe('version_unknown');
    expect(r.path).toBe(fake);
  });

  it('marks version_timeout when an installed CLI exceeds the probe deadline', async () => {
    const fake = writeCountingMockCli(
      path.join(tmpDir, 'slow-opencode'),
      path.join(tmpDir, 'slow-opencode-probe.log'),
    );
    process.env.PATH = '';
    process.env.ORKAS_OPENCODE_PATH = fake;

    const r = await detectOne('opencode', { versionProbeTimeoutMs: 20 });
    expect(r.available).toBe(false);
    expect(r.error).toBe('version_timeout');
    expect(r.path).toBe(fake);
    expect(r.errorDetail).toContain('did not finish within 20ms');
  });

  it('uses the documented version subcommand for Hermes', async () => {
    const fake = writeArgAwareMockCli(path.join(tmpDir, 'hermes'), {
      version: 'Hermes Agent v0.18.2',
      '--version': 'Hermes Agent v9.9.9',
    });
    process.env.PATH = '';
    process.env.ORKAS_HERMES_PATH = fake;

    const r = await detectOne('hermes');
    expect(isWindows ? r.path?.toLowerCase() : r.path).toBe(isWindows ? fake.toLowerCase() : fake);
    expect(r.version).toBe('0.18.2');
    expect(r.available).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('falls back to --version for Hermes installations without the version subcommand', async () => {
    const fake = writeArgAwareMockCli(path.join(tmpDir, 'legacy-hermes'), {
      '--version': 'Hermes Agent v0.17.0',
    });
    process.env.PATH = '';
    process.env.ORKAS_HERMES_PATH = fake;

    const r = await detectOne('hermes');
    expect(isWindows ? r.path?.toLowerCase() : r.path).toBe(isWindows ? fake.toLowerCase() : fake);
    expect(r.version).toBe('0.17.0');
    expect(r.available).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('detectAll keeps results cached for the process lifetime until forced', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const fake = writeMockCli(path.join(tmpDir, 'ok-opencode'), '0.10.0');
    process.env.PATH = '';
    process.env.ORKAS_OPENCODE_PATH = fake;

    const first = await detectAll();
    const opencodeFirst = first.find(e => e.type === 'opencode')!;
    expect(opencodeFirst.available).toBe(true);

    // Delete the binary and move far past the former 60-second TTL. A normal
    // read still uses the process-lifetime cache.
    fs.rmSync(fake);
    now.mockReturnValue(86_401_000);
    const cached = await detectAll();
    expect(cached.find(e => e.type === 'opencode')!.available).toBe(true);

    // Force re-detect bypasses cache.
    const fresh = await detectAll({ force: true });
    expect(fresh.find(e => e.type === 'opencode')!.available).toBe(false);
  });

  it('coalesces concurrent forced discovery into one set of version processes', async () => {
    const probeLog = path.join(tmpDir, 'probe-calls.log');
    const fake = writeCountingMockCli(path.join(tmpDir, 'counting-cli'), probeLog);
    process.env.PATH = '';
    process.env.ORKAS_CLAUDE_PATH = fake;
    process.env.ORKAS_CODEX_PATH = fake;
    process.env.ORKAS_OPENCLAW_PATH = fake;
    process.env.ORKAS_OPENCODE_PATH = fake;
    process.env.ORKAS_HERMES_PATH = fake;

    const [first, second] = await Promise.all([
      detectAll({ force: true }),
      detectAll({ force: true }),
    ]);

    expect(second).toBe(first);
    expect(first.every(entry => entry.available)).toBe(true);
    const probes = fs.readFileSync(probeLog, 'utf8').trim().split(/\r?\n/).sort();
    // Four single-probe CLIs plus Hermes `version` and `--version`.
    expect(probes).toEqual([
      '--version',
      '--version',
      '--version',
      '--version',
      '--version',
      'version',
    ]);
  });
});

describe('local_agents/registry › Windows GUI search paths', () => {
  it('covers npm, WindowsApps, pnpm, Volta, nvm, and the Codex app directory', () => {
    const dirs = localCliSearchDirs('codex', 'win32', {
      APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      VOLTA_HOME: 'C:\\Users\\alice\\.volta',
      PNPM_HOME: 'D:\\pnpm',
      NVM_SYMLINK: 'C:\\Program Files\\nodejs',
    }, 'C:\\Users\\alice');

    expect(dirs).toEqual(expect.arrayContaining([
      'C:\\Users\\alice\\AppData\\Roaming\\npm',
      'C:\\Users\\alice\\AppData\\Local\\Microsoft\\WindowsApps',
      'C:\\Users\\alice\\AppData\\Local\\pnpm',
      'C:\\Users\\alice\\.local\\bin',
      'C:\\Users\\alice\\.volta\\bin',
      'D:\\pnpm',
      'C:\\Program Files\\nodejs',
      'C:\\Users\\alice\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin',
    ]));
  });
});

describe('local_agents/registry › macOS GUI search paths', () => {
  it('covers user npm installs and bundled Codex app locations', () => {
    const dirs = localCliSearchDirs('codex', 'darwin', {
      NPM_CONFIG_PREFIX: '/Users/user/custom-npm',
      VOLTA_HOME: '/Users/user/.volta',
      PNPM_HOME: '/Users/user/Library/pnpm',
    }, '/Users/user');

    expect(dirs).toEqual(expect.arrayContaining([
      '/Users/user/.local/bin',
      '/Users/user/.npm-global/bin',
      '/Users/user/custom-npm/bin',
      '/Users/user/.volta/bin',
      '/Users/user/Library/pnpm',
      '/Applications/Codex.app/Contents/Resources',
      '/Applications/ChatGPT.app/Contents/Resources',
    ]));
  });
});
