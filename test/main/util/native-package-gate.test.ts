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
    '@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.3.node',
    '@img/sharp-win32-x64/lib/libvips-cpp-8.18.3.dll',
    '@img/sharp-win32-x64/lib/libvips-42.dll',
  ]) {
    writePe(root, relativePath);
  }
  return root;
}

function macFixture(arch: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-native-gate-mac-'));
  tempDirs.push(root);
  const onnx = path.join(root, 'onnxruntime-node');
  fs.mkdirSync(onnx, { recursive: true });
  fs.writeFileSync(path.join(onnx, 'package.json'), JSON.stringify({ version: '1.21.0' }));
  // Names come from the locked Sharp 0.35.4 / libvips 1.3.3 package payloads.
  for (const relativePath of [
    `@esbuild/darwin-${arch}/bin/esbuild`,
    'esbuild/bin/esbuild',
    `sqlite-vec-darwin-${arch}/vec0.dylib`,
    `@napi-rs/canvas-darwin-${arch}/skia.darwin-${arch}.node`,
    '@anush008/tokenizers-darwin-universal/tokenizers.darwin-universal.node',
    'better-sqlite3/build/Release/better_sqlite3.node',
    `onnxruntime-node/bin/napi-v3/darwin/${arch}/onnxruntime_binding.node`,
    `onnxruntime-node/bin/napi-v3/darwin/${arch}/libonnxruntime.1.21.0.dylib`,
    `@img/sharp-darwin-${arch}/lib/sharp-darwin-${arch}-0.35.4.node`,
    `@img/sharp-libvips-darwin-${arch}/lib/libvips-cpp.8.18.6.dylib`,
    'fsevents/fsevents.node',
  ]) {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(arch === 'arm64' ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(arch === 'arm64' ? 0 : 3, 8);
    bytes.writeUInt32LE(6, 12);
    fs.writeFileSync(file, bytes);
  }
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('native-package-gate', () => {
  it('verifies current Windows Sharp payload and rejects a missing libvips DLL', () => {
    const root = windowsFixture();
    const lib = path.join(root, '@img/sharp-win32-x64/lib');
    fs.renameSync(path.join(lib, 'sharp-win32-x64-0.35.3.node'), path.join(lib, 'sharp-win32-x64-0.35.4.node'));
    fs.renameSync(path.join(lib, 'libvips-cpp-8.18.3.dll'), path.join(lib, 'libvips-cpp-8.18.6.dll'));
    expect(verifyNativePackagePayload(root, 'win32', 'x64')).toEqual(
      requiredNativeVerificationEntries('win32', 'x64'),
    );
    fs.rmSync(path.join(lib, 'libvips-cpp-8.18.6.dll'));
    expect(() => verifyNativePackagePayload(root, 'win32', 'x64'))
      .toThrow(/expected exactly one sharp-libvips-cpp/);
  });

  it.each(['arm64', 'x64'])('verifies current Mac %s payload and rejects a missing Sharp companion', (arch) => {
    const root = macFixture(arch);
    expect(verifyNativePackagePayload(root, 'darwin', arch)).toEqual(
      requiredNativeVerificationEntries('darwin', arch),
    );
    fs.rmSync(path.join(root, `@img/sharp-libvips-darwin-${arch}/lib/libvips-cpp.8.18.6.dylib`));
    expect(() => verifyNativePackagePayload(root, 'darwin', arch))
      .toThrow(/expected exactly one sharp-libvips-cpp/);
  });

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

  it.each([
    [
      'tokenizers binding',
      '@anush008/tokenizers/node_modules/@anush008/tokenizers-win32-x64-msvc/tokenizers.win32-x64-msvc.node',
      /expected exactly one tokenizers/,
    ],
    [
      'ONNX Runtime binding',
      'fastembed/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node',
      /expected exactly one onnxruntime-binding/,
    ],
  ])('fails when the Windows %s is missing', (_label, relativePath, expected) => {
    const root = windowsFixture();
    fs.rmSync(path.join(root, ...relativePath.split('/')));
    expect(() => verifyNativePackagePayload(root, 'win32', 'x64')).toThrow(expected);
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
