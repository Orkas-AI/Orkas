// Electron entry shim: register tsx so the main process can
// `require('./src/main')` and resolve to src/main/index.ts (Node folder →
// index.ts rule + tsx/cjs transpilation). Keeps __dirname semantics identical
// to running plain JS — no compile step in dev.
//
// Two hooks:
//  - `tsx/cjs` (sync require hook) handles src/main/**/*.ts on the require()
//    code path.
//  - `tsx/esm` (ESM loader, registered via node:module) handles dynamic
//    `import()` specifiers that resolve to .ts files — notably the
//    `import('#core-agent')` subpath import that targets core-agent source.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

for (const arg of process.argv.slice(1)) {
  if (typeof arg !== 'string') continue;
  if (arg.startsWith('--orkas-profile=')) {
    process.env.ORKAS_PROFILE = arg.slice('--orkas-profile='.length);
  } else if (arg.startsWith('--orkas-api-base-url=')) {
    process.env.ORKAS_API_BASE_URL = arg.slice('--orkas-api-base-url='.length);
  } else if (arg.startsWith('--orkas-voice-api-base=')) {
    process.env.ORKAS_VOICE_API_BASE = arg.slice('--orkas-voice-api-base='.length);
  }
}

function configurePackagedEsbuildBinary() {
  if (!process.versions.electron || !process.resourcesPath || process.env.ESBUILD_BINARY_PATH) {
    return;
  }

  const platformPackages = {
    'darwin:arm64': ['@esbuild', 'darwin-arm64', 'bin', 'esbuild'],
    'darwin:x64': ['@esbuild', 'darwin-x64', 'bin', 'esbuild'],
    'linux:arm64': ['@esbuild', 'linux-arm64', 'bin', 'esbuild'],
    'linux:x64': ['@esbuild', 'linux-x64', 'bin', 'esbuild'],
    'win32:arm64': ['@esbuild', 'win32-arm64', 'esbuild.exe'],
    'win32:ia32': ['@esbuild', 'win32-ia32', 'esbuild.exe'],
    'win32:x64': ['@esbuild', 'win32-x64', 'esbuild.exe'],
  };
  const parts = platformPackages[`${process.platform}:${process.arch}`];
  if (!parts) return;

  const bin = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    ...parts,
  );
  if (fs.existsSync(bin)) {
    process.env.ESBUILD_BINARY_PATH = bin;
  }
}

configurePackagedEsbuildBinary();

require('tsx/cjs');
require('tsx/esm/api').register();

require('./src/main');
