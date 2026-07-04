'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ensureFile,
  isMachArch,
  markerMatches,
  packagePath,
  packageVersion,
  readLockPackage,
  scriptHashes,
  writeMarker,
} = require('./native-prepare-cache.cjs');

const PC_DIR = path.resolve(__dirname, '..');
const LOCK_FILE = path.join(PC_DIR, 'package-lock.json');
const CACHE_HELPER = path.join(__dirname, 'native-prepare-cache.cjs');
const TARGET_PLATFORM = 'darwin';

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function run(cwd, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: options.stdio || 'inherit',
    encoding: options.encoding,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return result;
}

function npmPack(cwd, spec) {
  const result = run(cwd, npmCmd(), ['pack', spec, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const packs = JSON.parse(result.stdout);
  const filename = packs?.[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack ${spec} did not report an output filename`);
  }
  return path.join(cwd, filename);
}

function ensureEsbuildPackage(platformName) {
  const packageName = `@esbuild/${platformName}`;
  const required = [path.join(PC_DIR, 'node_modules', '@esbuild', platformName, 'bin', 'esbuild')];
  ensurePackageFromRegistry(packageName, required);
}

function allFilesExist(files) {
  return files.every((file) => fs.existsSync(file) && fs.statSync(file).isFile());
}

function ensurePackageFromRegistry(packageName, requiredFiles = []) {
  const version = readLockPackage(LOCK_FILE, packageName);
  const targetDir = packagePath(PC_DIR, packageName);

  if (packageVersion(PC_DIR, packageName) === version && allFilesExist(requiredFiles)) {
    console.log(`[prepare-mac-native-deps] reusing ${packageName}@${version}`);
    return;
  }

  console.log(`[prepare-mac-native-deps] ensuring ${packageName}@${version}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-mac-native-deps-'));
  try {
    const tarball = npmPack(tmpDir, `${packageName}@${version}`);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    run(targetDir, 'tar', ['-xzf', tarball, '--strip-components=1']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function removeDirectories(parentDir, shouldRemove) {
  if (!fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
    return;
  }
  for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
    if (entry.isDirectory() && shouldRemove(entry.name)) {
      fs.rmSync(path.join(parentDir, entry.name), { recursive: true, force: true });
    }
  }
}

function expectedState(targetArch) {
  return {
    schema: 1,
    platform: TARGET_PLATFORM,
    arch: targetArch,
    scriptHashes: scriptHashes({
      prepareMacNativeDeps: __filename,
      nativePrepareCache: CACHE_HELPER,
    }),
    packages: {
      [`@esbuild/darwin-${targetArch}`]: readLockPackage(LOCK_FILE, `@esbuild/darwin-${targetArch}`),
      [`sqlite-vec-darwin-${targetArch}`]: readLockPackage(LOCK_FILE, `sqlite-vec-darwin-${targetArch}`),
      [`@napi-rs/canvas-darwin-${targetArch}`]: readLockPackage(LOCK_FILE, `@napi-rs/canvas-darwin-${targetArch}`),
    },
  };
}

function assertMachArch(label, file, targetArch) {
  ensureFile(label, file);
  if (!isMachArch(file, targetArch)) {
    throw new Error(`${label} is not macOS ${targetArch}: ${file}`);
  }
}

function main() {
  const targetArch = process.argv[2] || process.env.ORKAS_TARGET_ARCH || process.arch;
  if (!['arm64', 'x64'].includes(targetArch)) {
    throw new Error(`[prepare-mac-native-deps] unsupported macOS arch: ${targetArch}`);
  }

  fs.mkdirSync(path.join(PC_DIR, 'node_modules', '@esbuild'), { recursive: true });

  const required = {
    esbuild: path.join(PC_DIR, 'node_modules', '@esbuild', `darwin-${targetArch}`, 'bin', 'esbuild'),
    sqliteVec: path.join(PC_DIR, 'node_modules', `sqlite-vec-darwin-${targetArch}`, 'vec0.dylib'),
    canvas: path.join(PC_DIR, 'node_modules', '@napi-rs', `canvas-darwin-${targetArch}`, `skia.darwin-${targetArch}.node`),
  };
  const state = expectedState(targetArch);
  const requiredFiles = Object.values(required);
  const targetFilesMatch = () => requiredFiles.every((file) => isMachArch(file, targetArch));
  if (markerMatches(PC_DIR, state, requiredFiles, targetFilesMatch)) {
    console.log(`[prepare-mac-native-deps] using cached macOS ${targetArch} native dependencies`);
    return;
  }

  ensureEsbuildPackage(`darwin-${targetArch}`);
  ensurePackageFromRegistry(`sqlite-vec-darwin-${targetArch}`, [required.sqliteVec]);
  ensurePackageFromRegistry(`@napi-rs/canvas-darwin-${targetArch}`, [required.canvas]);

  console.log(`[prepare-mac-native-deps] pruning non-${targetArch} native runtime packages`);
  removeDirectories(path.join(PC_DIR, 'node_modules', '@esbuild'), (name) => name !== `darwin-${targetArch}`);
  removeDirectories(path.join(PC_DIR, 'node_modules'), (name) => /^sqlite-vec-(?!darwin-)/i.test(name) || (/^sqlite-vec-darwin-/i.test(name) && name !== `sqlite-vec-darwin-${targetArch}`));
  removeDirectories(path.join(PC_DIR, 'node_modules', '@napi-rs'), (name) => /^canvas-/i.test(name) && name !== `canvas-darwin-${targetArch}`);
  removeDirectories(path.join(PC_DIR, 'node_modules', '@anush008'), (name) => /^tokenizers-/i.test(name) && name !== 'tokenizers-darwin-universal');

  assertMachArch(
    `macOS ${targetArch} esbuild runtime binary`,
    required.esbuild,
    targetArch,
  );
  assertMachArch(
    `macOS ${targetArch} sqlite-vec runtime binary`,
    required.sqliteVec,
    targetArch,
  );
  assertMachArch(
    `macOS ${targetArch} canvas runtime binary`,
    required.canvas,
    targetArch,
  );
  writeMarker(PC_DIR, state);
}

main();
