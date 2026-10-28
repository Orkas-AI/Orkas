import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import * as vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const nativeRequire = createRequire(import.meta.url);
function nativeSuiteSelection(source: string, platform: 'darwin' | 'win32' | 'linux', childStatus = 0): string[] {
  const runner = path.resolve('scripts/run-platform-native-tests.mjs');
  const calls: string[][] = [];
  const exit = Symbol('runner exit');
  const code = ts.transpileModule(source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(runner).href)), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  try {
    vm.runInNewContext(code, {
      exports: {},
      require: (name: string) => name === 'node:child_process'
        ? { spawnSync: (_executable: string, args: string[]) => { calls.push(args); return { status: childStatus }; } }
        : nativeRequire(name),
      process: { platform, execPath: process.execPath, env: {}, exit: (code: number) => {
        if (code !== 0) throw new Error('Native runner failed');
        throw exit;
      } },
      console: { log() {}, error() { throw new Error('Native runner emitted an error'); } },
    }, { filename: runner });
  } catch (error) { if (error !== exit) throw error; }
  const invocation = calls.find(args => args[0].endsWith('run-tests.mjs'));
  if (!invocation) throw new Error('Native suite invocation was missing');
  return invocation;
}

type ProcessOwner = {
  suite: string;
  evidence: string;
  platforms?: readonly ('darwin' | 'win32' | 'linux')[];
};

/**
 * Every production module that launches a child process must name a focused
 * behavior suite. This catches the class of regressions that commonly passes
 * on macOS but fails on Windows: shell selection, argv quoting, `.cmd` shims,
 * hidden windows, process-tree cleanup, output encoding, and locked files.
 */
const PROCESS_OWNER_SUITE: Record<string, ProcessOwner> = {
  'bin/bridge-skill-runner.cjs': {
    suite: 'test/main/features/local_agents/bridge_skill_runner.test.ts',
    evidence: 'createBridgeSkillRunner',
  },
  'bin/local-cli-auth.cjs': {
    suite: 'test/main/features/connectors/local-cli.test.ts',
    evidence: 'local-cli-auth.cjs',
  },
  'bin/local-cli-mcp-server.cjs': {
    suite: 'test/main/features/connectors/local-cli-stdio-adapter.test.ts',
    evidence: 'local-cli-mcp-server.cjs',
  },
  'bin/orkas-pkg.cjs': {
    suite: 'test/main/util/orkas-pkg.test.ts',
    evidence: 'orkas-pkg.cjs',
  },
  'bin/run-skill.cjs': {
    suite: 'test/main/util/run-skill.test.ts',
    evidence: 'run-skill.cjs',
  },
  'bin/sharp-worker.cjs': {
    suite: 'test/main/util/sharp-runtime.test.ts',
    evidence: 'sharp-worker.cjs',
  },
  'src/core-agent/src/auth/oauth-flow.ts': {
    suite: 'src/core-agent/test/oauth-flow.test.ts',
    evidence: 'browserOpenCommand',
  },
  'src/core-agent/src/sandbox/executor.ts': {
    suite: 'src/core-agent/test/sandbox.test.ts',
    evidence: 'SandboxExecutor',
  },
  'src/core-agent/src/tools/process-session.ts': {
    suite: 'src/core-agent/test/process-session.test.ts',
    evidence: 'getProcessSessionTools',
  },
  'src/main/features/connectors/local-cli.ts': {
    suite: 'test/main/features/connectors/local-cli.test.ts',
    evidence: 'removeLocalCliAuthorization',
  },
  'src/main/features/generation_reference_assets.ts': {
    suite: 'test/main/features/generation_reference_assets.test.ts',
    evidence: 'runReferenceFfmpegForTest',
  },
  'src/main/features/local_agents/backends/base.ts': {
    suite: 'test/main/features/local_agents/base.test.ts',
    evidence: 'killProcessTree',
  },
  'src/main/features/local_agents/upgrade.ts': {
    suite: 'test/main/features/local_agents/upgrade.test.ts',
    evidence: 'runUpgradeCommand',
  },
  'src/main/features/local_agents/version.ts': {
    suite: 'test/main/features/local_agents/version.test.ts',
    evidence: 'detectVersion',
  },
  'src/main/features/notification_permissions.ts': {
    suite: 'test/main/features/notification_permissions.test.ts',
    evidence: 'windowsNotificationPermissionProbe',
  },
  'src/main/features/office/office_engine.ts': {
    suite: 'test/main/features/office/office_engine.test.ts',
    evidence: 'runOfficeCli',
  },
  'src/main/features/packages.ts': {
    suite: 'test/main/features/packages.test.ts',
    evidence: 'runPackageProcessForTest',
  },
  'src/main/index.ts': {
    suite: 'test/main/index-process.test.ts',
    evidence: 'ORKAS_RELAUNCH_OWNER_PID',
  },
  'src/main/install-data-root.cjs': {
    platforms: ['win32'],
    suite: 'test/main/util/migrate-source-data-root.test.ts',
    evidence: 'Get-CimInstance Win32_LogicalDisk',
  },
  'src/main/features/video_studio.ts': {
    suite: 'test/main/features/video_studio_native_qa.test.ts',
    evidence: 'runVideoProcessForTest',
  },
  'src/main/features/web_assist_passkey.ts': {
    suite: 'test/main/features/web_assist_passkey.test.ts',
    evidence: 'attachWebAssistPasskeys',
  },
  'src/main/model/core-agent/interactive-cli-sessions.ts': {
    suite: 'test/main/model/local-tools.test.ts',
    evidence: 'startInteractiveCliSession',
  },
  'src/main/model/core-agent/local-tools.ts': {
    suite: 'test/main/model/core-agent/local-tools.test.ts',
    evidence: 'createLocalTools',
  },
  'src/main/model/core-agent/repository-search.ts': {
    suite: 'test/main/model/core-agent/file-tools.test.ts',
    evidence: 'include_ignored',
  },
  'src/main/util/extract-xls.ts': {
    suite: 'test/main/util/extract-xls.test.ts',
    evidence: 'xlsBufferToMarkdown',
  },
  'src/main/util/windows-shutdown-processes.ts': {
    platforms: ['win32'],
    suite: 'test/main/util/windows-shutdown-processes.test.ts',
    evidence: 'captureWindowsShutdownProcesses',
  },
  'src/main/util/media_probe.ts': {
    suite: 'test/main/util/media_probe.test.ts',
    evidence: 'runMediaProbeProcessForTest',
  },
};

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(abs));
    else if (entry.isFile() && /\.(?:ts|[cm]?js)$/.test(entry.name)) files.push(abs);
  }
  return files;
}

function processOwnerFiles(root: string, excluded: string[]): string[] {
  return ['src/core-agent/src', 'src/main', 'bin'].flatMap(dir => walk(path.join(root, dir)))
    .filter(file => /(?:from\s+|import\s*\(|require\s*\()\s*['"](?:node:)?child_process['"]/
      .test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(root, file).split(path.sep).join('/'))
    // Only exact packaging exclusions may remove a build-time bin helper.
    // A new helper remains unowned until it receives a behavioral suite.
    .filter(file => !file.startsWith('bin/') || !excluded.includes(`!${file}`))
    .sort();
}

describe('platform process test ownership', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('runs existing MCP, migration and graceful exit contracts in the actual %s native selection', platform => {
    const source = fs.readFileSync(path.resolve('scripts/run-platform-native-tests.mjs'), 'utf8');
    const selected = nativeSuiteSelection(source, platform);
    for (const suite of [
      'test/main/features/connectors/mcp-client.test.ts',
      'test/main/util/shutdown.test.ts',
      'test/main/util/migrate-source-data-root.test.ts',
    ]) expect(selected).toContain(suite);
    for (const suite of selected.filter(arg => arg.endsWith('.test.ts'))) {
      expect(fs.existsSync(path.resolve(suite)), `native selection has a missing suite: ${suite}`).toBe(true);
    }
  });

  it('detects the missing macOS MCP lane when a suite is Windows-only', () => {
    const source = fs.readFileSync(path.resolve('scripts/run-platform-native-tests.mjs'), 'utf8');
    // Negative control: a suite present only in the Windows branch must not
    // make the macOS lane appear covered through a source-text match.
    const windowsOnly = source.replace(/^[ \t]*'test\/main\/features\/connectors\/mcp-client\.test\.ts',\r?\n/m, '')
      .replace("      'test/main/util/windows-shutdown-processes.test.ts',", "      'test/main/util/windows-shutdown-processes.test.ts',\n      'test/main/features/connectors/mcp-client.test.ts',");
    expect(nativeSuiteSelection(windowsOnly, 'win32')).toContain('test/main/features/connectors/mcp-client.test.ts');
    expect(nativeSuiteSelection(windowsOnly, 'darwin')).not.toContain('test/main/features/connectors/mcp-client.test.ts');
  });


  it('assigns every child-process production module to a focused behavior suite', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
    const processOwners = processOwnerFiles(process.cwd(), pkg.build.files);
    expect(Object.keys(PROCESS_OWNER_SUITE).sort()).toEqual(processOwners);
  });

  it('discovers unowned helpers in new and generic directories instead of silently excluding them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-process-inventory-'));
    try {
      const expected = ['bin/new/helper.cjs', 'src/core-agent/src/data/worker.js', 'src/main/build/worker.mjs'];
      for (const file of [...expected, 'bin/build-only.cjs']) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), "const { spawn } = require('node:child_process');\n");
      }
      expect(processOwnerFiles(root, ['!bin/build-only.cjs'])).toEqual(expected);
      expect(expected.every(file => !(file in PROCESS_OWNER_SUITE))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires direct evidence in each named suite', () => {
    const invalid: string[] = [];
    for (const [source, owner] of Object.entries(PROCESS_OWNER_SUITE)) {
      const suite = path.resolve(process.cwd(), owner.suite);
      if (!fs.existsSync(suite)) {
        invalid.push(`${source}: missing ${owner.suite}`);
        continue;
      }
      if (!fs.readFileSync(suite, 'utf8').includes(owner.evidence)) {
        invalid.push(`${source}: ${owner.suite} lacks ${owner.evidence}`);
      }
    }
    expect(invalid).toEqual([]);
  });

  it.each(['darwin', 'win32', 'linux'] as const)('runs every applicable process owner in the actual %s native lane', platform => {
    const runner = fs.readFileSync(path.resolve(process.cwd(), 'scripts/run-platform-native-tests.mjs'), 'utf8');
    const selected = nativeSuiteSelection(runner, platform);
    const missing = [...new Set(Object.values(PROCESS_OWNER_SUITE)
      .filter(owner => !owner.platforms || owner.platforms.includes(platform))
      .map(({ suite }) => suite))]
      .filter(suite => !selected.includes(suite));
    expect(missing).toEqual([]);
    expect(selected).toContain('--maxWorkers=1');
  });

  it.each(['darwin', 'win32', 'linux'] as const)('fails the %s native lane when a selected suite fails', platform => {
    const source = fs.readFileSync(path.resolve('scripts/run-platform-native-tests.mjs'), 'utf8');
    expect(() => nativeSuiteSelection(source, platform, 1)).toThrow('Native runner failed');
  });

  it('repeats every real Windows descendant-termination suite three times', () => {
    const runner = fs.readFileSync(path.resolve(process.cwd(), 'scripts/run-windows-stability-tests.mjs'), 'utf8');
    expect(runner).toContain('const repetitions = 3');
    expect(runner).toContain("'-t'");
    expect(runner).toContain('for (const suite of suites)');
    expect(runner).toContain('stops only this installation');
    expect(runner).toContain('releases orphaned app/runtime executables');
    for (const suite of [
      'src/core-agent/test/process-session.test.ts',
      'test/main/features/local_agents/version.test.ts',
      'test/main/features/office/office_engine.test.ts',
      'test/main/features/packages.test.ts',
      'test/main/features/generation_reference_assets.test.ts',
      'test/main/util/media_probe.test.ts',
      'test/main/util/windows-shutdown-processes.test.ts',
      'test/main/util/windows-installer-processes.test.ts',
      'test/main/features/connectors/mcp-client.test.ts',
      'test/main/features/video_studio_native_qa.test.ts',
    ]) {
      expect(runner, `${suite} is not in the repeated Windows lane`).toContain(suite);
    }
  });

});
