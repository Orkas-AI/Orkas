#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pcRoot = resolve(here, '..');
const runner = resolve(here, 'run-tests.mjs');

if (process.platform !== 'win32' && process.platform !== 'darwin') {
  console.log(`[platform-native-tests] skipped: unsupported host ${process.platform}`);
  process.exit(0);
}

// Keep system/native tests explicit and serial. This lane intentionally
// overlaps the general suite: a Windows-only process-tree or PowerShell case
// must remain visible as a dedicated CI failure instead of being buried among
// hundreds of platform-neutral tests. Real bundled Whisper remains the
// release-only `test:windows-native` lane because it requires downloaded
// FFmpeg, model, VC runtime, and CPU-dispatch payloads.
const commonSuites = [
  'src/core-agent/test/tools.test.ts',
  'src/core-agent/test/sandbox.test.ts',
  'test/main/model/core-agent/file-tools.test.ts',
  'test/main/model/core-agent/tool-result-tools.test.ts',
  'test/main/model/core-agent/local-tools.test.ts',
  'test/main/model/local-tools.test.ts',
  'test/main/model/core-agent/video-studio-state-tool.test.ts',
  'test/main/model/core-agent/office-tools.test.ts',
  'test/main/features/office/office_engine.test.ts',
  'test/main/features/ocr_runtime.test.ts',
  'test/main/features/notification_permissions.test.ts',
  'test/main/features/local_agents/base.test.ts',
  'test/main/features/local_agents/spawn-command.test.ts',
  'test/main/features/local_agents/version.test.ts',
  'test/main/util/bundled-runtime.test.ts',
  'test/main/util/run-skill.test.ts',
  'test/main/features/packages.test.ts',
  'test/main/util/media_probe.test.ts',
  'test/main/features/video_studio_native_qa.test.ts',
];

const platformSuites = process.platform === 'win32'
  ? [
      'test/main/util/prepare-win-native-deps.test.ts',
      'test/main/util/fetch-win-vc-runtime.test.ts',
    ]
  : [
      'test/main/features/platform-foundations.test.ts',
      'test/main/features/user_workspace.test.ts',
      'test/main/conversation-files.test.ts',
    ];

console.log(`[platform-native-tests] host=${process.platform}; suites=${commonSuites.length + platformSuites.length}`);
const result = spawnSync(process.execPath, [
  runner,
  'run',
  '--maxWorkers=1',
  ...commonSuites,
  ...platformSuites,
], {
  cwd: pcRoot,
  env: { ...process.env, ORKAS_PLATFORM_NATIVE_TEST: '1' },
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
