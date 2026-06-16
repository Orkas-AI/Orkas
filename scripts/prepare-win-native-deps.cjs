'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PC_DIR = path.resolve(__dirname, '..');
const LOCK_FILE = path.join(PC_DIR, 'package-lock.json');

function readLockPackage(name) {
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  const item = lock.packages?.[`node_modules/${name}`];
  if (!item?.version) {
    throw new Error(`package-lock.json is missing node_modules/${name}`);
  }
  return item.version;
}

function readElectronVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(PC_DIR, 'package.json'), 'utf8'));
  const spec = String(pkg.devDependencies?.electron || '');
  const match = spec.match(/\d+(?:\.\d+){0,2}/);
  if (!match) {
    throw new Error(`package.json is missing a concrete Electron version: ${spec}`);
  }
  return match[0];
}

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function quoteCmdArg(value) {
  const raw = String(value);
  if (/^[A-Za-z0-9_@./:=+-]+$/.test(raw)) {
    return raw;
  }
  return `"${raw.replace(/"/g, '""')}"`;
}

function runNpm(cwd, args) {
  const command = npmCmd();
  const spawnArgs = args;
  const spawnOptions = {
    cwd,
    stdio: 'inherit',
    shell: false,
  };
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', [command, ...args].map(quoteCmdArg).join(' ')], spawnOptions)
    : spawnSync(command, spawnArgs, spawnOptions);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed with exit code ${result.status}`);
  }
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

function packagePath(packageName) {
  return path.join(PC_DIR, 'node_modules', ...packageName.split('/'));
}

function ensurePackageFromRegistry(packageName) {
  const version = readLockPackage(packageName);
  const targetDir = packagePath(packageName);

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

function ensureFile(label, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`missing ${label}: ${file}`);
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

function main() {
  const esbuildVersion = readLockPackage('@esbuild/win32-x64');
  const sqliteVecVersion = readLockPackage('sqlite-vec-windows-x64');
  const electronVersion = readElectronVersion();
  const sqliteVecDir = path.join(PC_DIR, 'node_modules', 'sqlite-vec');
  const betterSqliteDir = path.join(PC_DIR, 'node_modules', 'better-sqlite3');

  if (!fs.existsSync(sqliteVecDir) || !fs.statSync(sqliteVecDir).isDirectory()) {
    throw new Error(`sqlite-vec is not installed: ${sqliteVecDir}`);
  }
  if (!fs.existsSync(betterSqliteDir) || !fs.statSync(betterSqliteDir).isDirectory()) {
    throw new Error(`better-sqlite3 is not installed: ${betterSqliteDir}`);
  }

  console.log(`[prepare-win-native-deps] ensuring @esbuild/win32-x64@${esbuildVersion}`);
  runNpm(PC_DIR, [
    'install',
    '--no-save',
    '--ignore-scripts',
    '--include=optional',
    '--force',
    `@esbuild/win32-x64@${esbuildVersion}`,
  ]);

  console.log(`[prepare-win-native-deps] ensuring sqlite-vec-windows-x64@${sqliteVecVersion}`);
  ensurePackageFromRegistry('sqlite-vec-windows-x64');
  ensurePackageFromRegistry('@napi-rs/canvas-win32-x64-msvc');
  ensurePackageFromRegistry('@anush008/tokenizers-win32-x64-msvc');

  console.log(`[prepare-win-native-deps] ensuring better-sqlite3 Electron ${electronVersion} win32-x64 prebuild`);
  run(betterSqliteDir, process.execPath, [
    require.resolve('prebuild-install/bin.js'),
    '--runtime',
    'electron',
    '--target',
    electronVersion,
    '--platform',
    'win32',
    '--arch',
    'x64',
    '--force',
  ]);

  console.log('[prepare-win-native-deps] pruning non-Windows native runtime packages');
  removeDirectories(path.join(PC_DIR, 'node_modules', '@esbuild'), (name) => name !== 'win32-x64');
  removeDirectories(path.join(PC_DIR, 'node_modules'), (name) => /^sqlite-vec-(darwin|linux)-/i.test(name));
  removeDirectories(path.join(PC_DIR, 'node_modules', '@napi-rs'), (name) => /^canvas-/i.test(name) && name !== 'canvas-win32-x64-msvc');
  removeDirectories(path.join(PC_DIR, 'node_modules', '@anush008'), (name) => /^tokenizers-/i.test(name) && name !== 'tokenizers-win32-x64-msvc');
  fs.rmSync(path.join(PC_DIR, 'node_modules', 'fsevents'), { recursive: true, force: true });

  ensureFile(
    'Windows esbuild runtime binary',
    path.join(PC_DIR, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'),
  );
  ensureFile(
    'Windows sqlite-vec runtime binary',
    path.join(PC_DIR, 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll'),
  );
  ensureFile(
    'Windows better-sqlite3 runtime binary',
    path.join(betterSqliteDir, 'build', 'Release', 'better_sqlite3.node'),
  );
  ensureFile(
    'Windows canvas runtime binary',
    path.join(PC_DIR, 'node_modules', '@napi-rs', 'canvas-win32-x64-msvc', 'skia.win32-x64-msvc.node'),
  );
  ensureFile(
    'Windows tokenizers runtime binary',
    path.join(PC_DIR, 'node_modules', '@anush008', 'tokenizers-win32-x64-msvc', 'tokenizers.win32-x64-msvc.node'),
  );
}

main();
