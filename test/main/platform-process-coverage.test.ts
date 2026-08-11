import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

type ProcessOwner = {
  suite: string;
  evidence: string;
};

/**
 * Every production module that launches a child process must name a focused
 * behavior suite. This catches the class of regressions that commonly passes
 * on macOS but fails on Windows: shell selection, argv quoting, `.cmd` shims,
 * hidden windows, process-tree cleanup, output encoding, and locked files.
 */
const PROCESS_OWNER_SUITE: Record<string, ProcessOwner> = {
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
  'src/main/features/generation_reference_assets.ts': {
    suite: 'test/main/features/generation_reference_assets.test.ts',
    evidence: 'runReferenceFfmpegForTest',
  },
  'src/main/features/local_agents/backends/base.ts': {
    suite: 'test/main/features/local_agents/base.test.ts',
    evidence: 'killProcessTree',
  },
  'src/main/features/local_agents/version.ts': {
    suite: 'test/main/features/local_agents/version.test.ts',
    evidence: 'detectVersion',
  },
  'src/main/features/notification_permissions.ts': {
    suite: 'test/main/features/notification_permissions.test.ts',
    evidence: 'windowsNotificationPermissionProbe',
  },
  'src/main/features/ocr_runtime.ts': {
    suite: 'test/main/features/ocr_runtime.test.ts',
    evidence: '_ensureOcrRuntimeForTest',
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
    evidence: 'spawn',
  },
  'src/main/features/video_studio.ts': {
    suite: 'test/main/features/video_studio_native_qa.test.ts',
    evidence: 'runVideoProcessForTest',
  },
  'src/main/features/video_studio_delivery.ts': {
    suite: 'test/main/features/video_studio_delivery.test.ts',
    evidence: 'verifyProductionDelivery',
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
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(abs);
  }
  return files;
}

describe('platform process test ownership', () => {
  it('assigns every child-process production module to a focused behavior suite', () => {
    const roots = [
      'src/core-agent/src',
      'src/main',
    ].map((dir) => path.resolve(process.cwd(), dir));
    const processOwners = roots
      .flatMap(walk)
      .filter((file) => (
        /(?:from\s+|import\s*\(|require\s*\()\s*['"](?:node:)?child_process['"]/
          .test(fs.readFileSync(file, 'utf8'))
      ))
      .map((file) => path.relative(process.cwd(), file).split(path.sep).join('/'))
      .sort();

    expect(Object.keys(PROCESS_OWNER_SUITE).sort()).toEqual(processOwners);
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

  it('runs every child-process owner suite in the serialized native-host lane', () => {
    const runner = fs.readFileSync(path.resolve(process.cwd(), 'scripts/run-platform-native-tests.mjs'), 'utf8');
    const missing = [...new Set(Object.values(PROCESS_OWNER_SUITE).map(({ suite }) => suite))]
      .filter((suite) => !runner.includes(suite));
    expect(missing).toEqual([]);
  });

  it('repeats every real Windows descendant-termination suite three times', () => {
    const runner = fs.readFileSync(path.resolve(process.cwd(), 'scripts/run-windows-stability-tests.mjs'), 'utf8');
    expect(runner).toContain('const repetitions = 3');
    expect(runner).toContain("'-t'");
    expect(runner).toContain('for (const suite of suites)');
    for (const suite of [
      'src/core-agent/test/process-session.test.ts',
      'test/main/features/local_agents/version.test.ts',
      'test/main/features/office/office_engine.test.ts',
      'test/main/features/packages.test.ts',
      'test/main/features/generation_reference_assets.test.ts',
      'test/main/util/media_probe.test.ts',
      'test/main/features/video_studio_native_qa.test.ts',
    ]) {
      expect(runner, `${suite} is not in the repeated Windows lane`).toContain(suite);
    }
  });
});
