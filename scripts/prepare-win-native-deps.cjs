'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ensureFile,
  isPeX64,
  markerMatches,
  packagePath,
  packageVersion,
  readElectronVersion,
  readLockPackage,
  scriptHashes,
  writeMarker,
} = require('./native-prepare-cache.cjs');

const PC_DIR = path.resolve(__dirname, '..');
const LOCK_FILE = path.join(PC_DIR, 'package-lock.json');
const CACHE_HELPER = path.join(__dirname, 'native-prepare-cache.cjs');
const TARGET_PLATFORM = 'win32';
const TARGET_ARCH = 'x64';

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function npmPack(cwd, spec) {
  const result = spawnSync(npmCmd(), ['pack', spec, '--json'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm pack ${spec} failed with exit code ${result.status}`);
  }
  const packs = JSON.parse(result.stdout);
  const filename = packs?.[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack ${spec} did not report an output filename`);
  }
  return path.join(cwd, filename);
}

function allFilesExist(files) {
  return files.every((file) => fs.existsSync(file) && fs.statSync(file).isFile());
}

function ensurePackageFromRegistry(packageName, requiredFiles = []) {
  const version = readLockPackage(LOCK_FILE, packageName);
  const targetDir = packagePath(PC_DIR, packageName);

  if (packageVersion(PC_DIR, packageName) === version && allFilesExist(requiredFiles)) {
    console.log(`[prepare-win-native-deps] reusing ${packageName}@${version}`);
    return;
  }

  console.log(`[prepare-win-native-deps] ensuring ${packageName}@${version}`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-win-native-deps-'));
  try {
    const tarball = npmPack(tmpDir, `${packageName}@${version}`);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    run(targetDir, 'tar', ['-xzf', tarball, '--strip-components=1']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function expectedState(electronVersion) {
  return {
    schema: 1,
    platform: TARGET_PLATFORM,
    arch: TARGET_ARCH,
    electronVersion,
    scriptHashes: scriptHashes({
      prepareWinNativeDeps: __filename,
      nativePrepareCache: CACHE_HELPER,
    }),
    packages: {
      '@esbuild/win32-x64': readLockPackage(LOCK_FILE, '@esbuild/win32-x64'),
      'sqlite-vec-windows-x64': readLockPackage(LOCK_FILE, 'sqlite-vec-windows-x64'),
      '@napi-rs/canvas-win32-x64-msvc': readLockPackage(LOCK_FILE, '@napi-rs/canvas-win32-x64-msvc'),
      '@anush008/tokenizers-win32-x64-msvc': readLockPackage(LOCK_FILE, '@anush008/tokenizers-win32-x64-msvc'),
      'better-sqlite3': readLockPackage(LOCK_FILE, 'better-sqlite3'),
    },
  };
}

function removeLegacyMarker() {
  fs.rmSync(path.join(PC_DIR, 'node_modules', '.orkas-native-prepared'), { recursive: true, force: true });
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

function main() {
  const electronVersion = readElectronVersion(PC_DIR);
  const state = expectedState(electronVersion);
  const sqliteVecDir = path.join(PC_DIR, 'node_modules', 'sqlite-vec');
  const betterSqliteDir = path.join(PC_DIR, 'node_modules', 'better-sqlite3');
  const betterSqliteBinary = path.join(betterSqliteDir, 'build', 'Release', 'better_sqlite3.node');
  const required = {
    esbuild: path.join(PC_DIR, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
    sqliteVec: path.join(PC_DIR, 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll'),
    betterSqlite: betterSqliteBinary,
    canvas: path.join(PC_DIR, 'node_modules', '@napi-rs', 'canvas-win32-x64-msvc', 'skia.win32-x64-msvc.node'),
    tokenizers: path.join(PC_DIR, 'node_modules', '@anush008', 'tokenizers-win32-x64-msvc', 'tokenizers.win32-x64-msvc.node'),
  };

  if (!fs.existsSync(sqliteVecDir) || !fs.statSync(sqliteVecDir).isDirectory()) {
    throw new Error(`sqlite-vec is not installed: ${sqliteVecDir}`);
  }
  if (!fs.existsSync(betterSqliteDir) || !fs.statSync(betterSqliteDir).isDirectory()) {
    throw new Error(`better-sqlite3 is not installed: ${betterSqliteDir}`);
  }

  const prepared = markerMatches(PC_DIR, state, Object.values(required), () => isPeX64(betterSqliteBinary));
  removeLegacyMarker();
  if (prepared) {
    console.log(`[prepare-win-native-deps] using cached Windows native dependencies for Electron ${electronVersion}`);
    return;
  }

  ensurePackageFromRegistry('@esbuild/win32-x64', [required.esbuild]);

  ensurePackageFromRegistry('sqlite-vec-windows-x64', [required.sqliteVec]);
  ensurePackageFromRegistry('@napi-rs/canvas-win32-x64-msvc', [required.canvas]);
  ensurePackageFromRegistry('@anush008/tokenizers-win32-x64-msvc', [required.tokenizers]);

  if (packageVersion(PC_DIR, 'better-sqlite3') === state.packages['better-sqlite3'] && isPeX64(betterSqliteBinary)) {
    console.log(`[prepare-win-native-deps] reusing better-sqlite3 Electron ${electronVersion} win32-x64 prebuild`);
  } else {
    console.log(`[prepare-win-native-deps] ensuring better-sqlite3 Electron ${electronVersion} win32-x64 prebuild`);
    run(betterSqliteDir, process.execPath, [
      require.resolve('prebuild-install/bin.js'),
      '--runtime',
      'electron',
      '--target',
      electronVersion,
      '--platform',
      TARGET_PLATFORM,
      '--arch',
      TARGET_ARCH,
      '--force',
    ]);
  }

  console.log('[prepare-win-native-deps] pruning non-Windows native runtime packages');
  removeDirectories(path.join(PC_DIR, 'node_modules', '@esbuild'), (name) => name !== 'win32-x64');
  removeDirectories(path.join(PC_DIR, 'node_modules'), (name) => /^sqlite-vec-(darwin|linux)-/i.test(name));
  removeDirectories(path.join(PC_DIR, 'node_modules', '@napi-rs'), (name) => /^canvas-/i.test(name) && name !== 'canvas-win32-x64-msvc');
  removeDirectories(path.join(PC_DIR, 'node_modules', '@anush008'), (name) => /^tokenizers-/i.test(name) && name !== 'tokenizers-win32-x64-msvc');
  fs.rmSync(path.join(PC_DIR, 'node_modules', 'fsevents'), { recursive: true, force: true });

  ensureFile(
    'Windows esbuild runtime binary',
    required.esbuild,
  );
  ensureFile(
    'Windows sqlite-vec runtime binary',
    required.sqliteVec,
  );
  ensureFile(
    'Windows better-sqlite3 runtime binary',
    required.betterSqlite,
  );
  if (!isPeX64(required.betterSqlite)) {
    throw new Error(`Windows better-sqlite3 runtime binary is not PE x64: ${required.betterSqlite}`);
  }
  ensureFile(
    'Windows canvas runtime binary',
    required.canvas,
  );
  ensureFile(
    'Windows tokenizers runtime binary',
    required.tokenizers,
  );
  writeMarker(PC_DIR, state);
}

main();
