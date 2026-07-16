import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const fetchWhisper = require('../../../scripts/fetch-whisper.cjs') as {
  expectedFiles: (target: any) => Record<string, { bytes: number; sha256: string }>;
  isWindowsIllegalInstruction: (status: number | null) => boolean;
  matchesFile: (file: string, expected: { bytes: number; sha256: string }) => boolean;
  targetOptions: (argv: string[]) => { platform: string; arch: string; force: boolean };
  writeCapabilityState: (dir: string, capability: { status: string; reason?: string }) => void;
};
const { WHISPER_RUNTIME_CONTRACT } = require('../../../bin/runtime-gate.cjs') as {
  WHISPER_RUNTIME_CONTRACT: any;
};

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('fetch-whisper', () => {
  it('parses the explicit package target without a system-install option', () => {
    expect(fetchWhisper.targetOptions([
      'node', 'fetch-whisper.cjs', '--platform', 'win32', '--arch', 'x64', '--force',
    ])).toEqual({ platform: 'win32', arch: 'x64', force: true });
  });

  it('keeps the checked-in macOS CLIs and licenses pinned to the runtime contract', () => {
    const vendor = path.join(process.cwd(), 'vendor', 'whisper', `v${WHISPER_RUNTIME_CONTRACT.version}`);
    for (const key of ['darwin-arm64', 'darwin-x64']) {
      const spec = WHISPER_RUNTIME_CONTRACT.targets[key].files['bin/whisper-cli'];
      expect(fetchWhisper.matchesFile(path.join(vendor, key, 'whisper-cli'), spec)).toBe(true);
    }
    for (const [name, spec] of Object.entries(WHISPER_RUNTIME_CONTRACT.licenses)) {
      expect(fetchWhisper.matchesFile(path.join(vendor, name), spec as any)).toBe(true);
    }
  });

  it('recognizes signed and unsigned Windows illegal-instruction exit codes', () => {
    expect(fetchWhisper.isWindowsIllegalInstruction(-1073741795)).toBe(true);
    expect(fetchWhisper.isWindowsIllegalInstruction(0xC000001D)).toBe(true);
    expect(fetchWhisper.isWindowsIllegalInstruction(1)).toBe(false);
    expect(fetchWhisper.isWindowsIllegalInstruction(null)).toBe(false);
  });

  it('persists an unsupported-CPU capability state without changing verified file records', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-whisper-marker-'));
    tempDirs.push(dir);
    const markerFile = path.join(dir, '.orkas-whisper-ready.json');
    fs.writeFileSync(markerFile, JSON.stringify({ schema: 1, files: { cli: { bytes: 1 } }, capability: { status: 'ready' } }));

    fetchWhisper.writeCapabilityState(dir, { status: 'disabled', reason: 'unsupported_cpu' });

    expect(JSON.parse(fs.readFileSync(markerFile, 'utf8'))).toEqual({
      schema: 1,
      files: { cli: { bytes: 1 } },
      capability: { status: 'disabled', reason: 'unsupported_cpu' },
    });
  });

  it('registers the model, licenses, binaries, and app-local VC DLLs as verified files', () => {
    const target = WHISPER_RUNTIME_CONTRACT.targets['win32-x64'];
    expect(Object.keys(fetchWhisper.expectedFiles(target))).toEqual(expect.arrayContaining([
      'bin/whisper-cli.exe',
      'models/ggml-base-q5_1.bin',
      'LICENSE.whisper.cpp',
      'LICENSE.model',
      'bin/msvcp140.dll',
      'bin/msvcp140_1.dll',
      'bin/vcruntime140.dll',
      'bin/vcruntime140_1.dll',
      'bin/vcomp140.dll',
    ]));
    expect(Object.keys(fetchWhisper.expectedFiles(target))).not.toContain('vc_redist.x64.exe');
  });
});
