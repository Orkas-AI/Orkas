import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import log from 'electron-log/main';
import {
  detectAll,
  detectOne,
  invalidateCache,
  localCliSearchDirs,
  LOCAL_CLI_TYPES,
} from '../../../../src/main/features/local_agents/registry';

const isWindows = process.platform === 'win32';

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
    const fake = writeMockCli(path.join(binDir, 'codex'), 'codex-cli 0.139.0');
    process.env.PATH = '';

    const r = await detectOne('codex');
    expect(isWindows ? r.path?.toLowerCase() : r.path).toBe(isWindows ? fake.toLowerCase() : fake);
    expect(r.version).toBe('0.139.0');
    expect(r.available).toBe(true);
  });

  it('uses the npm Codex package version when the wrapper has no --version output', async () => {
    if (isWindows) return;
    const pkgRoot = path.join(tmpDir, 'node_modules', '@openai', 'codex');
    const binDir = path.join(pkgRoot, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({
      name: '@openai/codex',
      version: '0.130.0',
    }));
    const fake = path.join(binDir, 'codex.js');
    fs.writeFileSync(fake, '#!/bin/sh\necho ""\n');
    fs.chmodSync(fake, 0o755);
    process.env.PATH = '';
    process.env.ORKAS_CODEX_PATH = fake;

    const r = await detectOne('codex');
    expect(r.path).toBe(fake);
    expect(r.version).toBe('0.130.0');
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

  it('detectAll caches results within the TTL window', async () => {
    const fake = writeMockCli(path.join(tmpDir, 'ok-opencode'), '0.10.0');
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
