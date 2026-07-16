import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const {
  requiredNativeVerificationEntries,
  verifyNativePackagePayload,
} = require('../../../bin/native-package-gate.cjs') as {
  requiredNativeVerificationEntries: (platform: string, arch: string) => string[];
  verifyNativePackagePayload: (
    nodeModules: string,
    platform: string,
    arch: string,
    options?: { checkArch?: boolean },
  ) => string[];
};
const { __test: nativePrune } = require('../../../scripts/codesign-adhoc.cjs') as {
  __test: {
    pruneEsbuildPackage: (nodeModules: string, platform: string, arch: string) => void;
    pruneOnnxRuntimePackage: (packageDir: string, platform: string, arch: string) => void;
  };
};

const tempDirs: string[] = [];

function writePe(root: string, relativePath: string, machine = 0x8664): string {
  const file = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = Buffer.alloc(0x80);
  body.write('MZ', 0, 'ascii');
  body.writeUInt32LE(0x40, 0x3c);
  body.write('PE\0\0', 0x40, 'binary');
  body.writeUInt16LE(machine, 0x44);
  fs.writeFileSync(file, body);
  return file;
}

function windowsFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-native-gate-'));
  tempDirs.push(root);
  const packageJson = path.join(
    root,
    'fastembed',
    'node_modules',
    'onnxruntime-node',
    'package.json',
  );
  fs.mkdirSync(path.dirname(packageJson), { recursive: true });
  fs.writeFileSync(packageJson, JSON.stringify({ name: 'onnxruntime-node', version: '1.21.0' }));

  for (const relativePath of [
    '@esbuild/win32-x64/esbuild.exe',
    'esbuild/bin/esbuild',
    'sqlite-vec/node_modules/sqlite-vec-windows-x64/vec0.dll',
    '@napi-rs/canvas/node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node',
    '@anush008/tokenizers/node_modules/@anush008/tokenizers-win32-x64-msvc/tokenizers.win32-x64-msvc.node',
    'better-sqlite3/build/Release/better_sqlite3.node',
    'fastembed/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node',
    'fastembed/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll',
  ]) {
    writePe(root, relativePath);
  }
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('native-package-gate', () => {
  it('verifies every declared Windows native binary and its PE machine', () => {
    const root = windowsFixture();
    expect(verifyNativePackagePayload(root, 'win32', 'x64')).toEqual(
      requiredNativeVerificationEntries('win32', 'x64'),
    );
  });

  it('accepts Electron Builder hoisting ONNX Runtime out of FastEmbed', () => {
    const root = windowsFixture();
    fs.renameSync(
      path.join(root, 'fastembed/node_modules/onnxruntime-node'),
      path.join(root, 'onnxruntime-node'),
    );
    expect(verifyNativePackagePayload(root, 'win32', 'x64')).toEqual(
      requiredNativeVerificationEntries('win32', 'x64'),
    );
  });

  it('fails when the ONNX Runtime core companion is missing', () => {
    const root = windowsFixture();
    fs.rmSync(path.join(
      root,
      'fastembed/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll',
    ));
    expect(() => verifyNativePackagePayload(root, 'win32', 'x64'))
      .toThrow(/expected exactly one onnxruntime-core/);
  });

  it('rejects unused or newly introduced native payloads until registered', () => {
    const root = windowsFixture();
    writePe(
      root,
      'fastembed/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/DirectML.dll',
    );
    expect(() => verifyNativePackagePayload(root, 'win32', 'x64'))
      .toThrow(/unregistered native package payload.*DirectML\.dll/);
  });

  it('rejects a foreign-architecture PE even when its path looks correct', () => {
    const root = windowsFixture();
    writePe(root, 'better-sqlite3/build/Release/better_sqlite3.node', 0xaa64);
    expect(() => verifyNativePackagePayload(root, 'win32', 'x64'))
      .toThrow(/arch mismatch: expected x64/);
  });

  it('normalizes the esbuild launcher and removes unused DirectML before verification', () => {
    const root = windowsFixture();
    const launcher = writePe(root, 'esbuild/bin/esbuild', 0xaa64);
    const onnxDir = path.join(root, 'fastembed/node_modules/onnxruntime-node');
    const directMl = writePe(
      root,
      'fastembed/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/DirectML.dll',
    );

    nativePrune.pruneEsbuildPackage(root, 'win32', 'x64');
    nativePrune.pruneOnnxRuntimePackage(onnxDir, 'win32', 'x64');

    expect(fs.readFileSync(launcher)).toEqual(fs.readFileSync(path.join(root, '@esbuild/win32-x64/esbuild.exe')));
    expect(fs.existsSync(directMl)).toBe(false);
    expect(verifyNativePackagePayload(root, 'win32', 'x64')).toEqual(
      requiredNativeVerificationEntries('win32', 'x64'),
    );
  });
});
