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
  ensurePackageFromRegistry(packageName);
}

function packagePath(packageName) {
  return path.join(PC_DIR, 'node_modules', ...packageName.split('/'));
}

function ensurePackageFromRegistry(packageName) {
  const version = readLockPackage(packageName);
  const targetDir = packagePath(packageName);

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

function ensureFile(label, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`missing ${label}: ${file}`);
  }
}

function main() {
  const targetArch = process.argv[2] || process.env.ORKAS_TARGET_ARCH || process.arch;
  if (!['arm64', 'x64'].includes(targetArch)) {
    throw new Error(`[prepare-mac-native-deps] unsupported macOS arch: ${targetArch}`);
  }

  fs.mkdirSync(path.join(PC_DIR, 'node_modules', '@esbuild'), { recursive: true });

  ensureEsbuildPackage(`darwin-${targetArch}`);
  ensurePackageFromRegistry(`sqlite-vec-darwin-${targetArch}`);
  ensurePackageFromRegistry(`@napi-rs/canvas-darwin-${targetArch}`);

  console.log(`[prepare-mac-native-deps] pruning non-${targetArch} native runtime packages`);
  removeDirectories(path.join(PC_DIR, 'node_modules', '@esbuild'), (name) => name !== `darwin-${targetArch}`);
  removeDirectories(path.join(PC_DIR, 'node_modules'), (name) => /^sqlite-vec-(?!darwin-)/i.test(name) || (/^sqlite-vec-darwin-/i.test(name) && name !== `sqlite-vec-darwin-${targetArch}`));
  removeDirectories(path.join(PC_DIR, 'node_modules', '@napi-rs'), (name) => /^canvas-/i.test(name) && name !== `canvas-darwin-${targetArch}`);
  removeDirectories(path.join(PC_DIR, 'node_modules', '@anush008'), (name) => /^tokenizers-/i.test(name) && name !== 'tokenizers-darwin-universal');

  ensureFile(
    `macOS ${targetArch} esbuild runtime binary`,
    path.join(PC_DIR, 'node_modules', '@esbuild', `darwin-${targetArch}`, 'bin', 'esbuild'),
  );
  ensureFile(
    `macOS ${targetArch} sqlite-vec runtime binary`,
    path.join(PC_DIR, 'node_modules', `sqlite-vec-darwin-${targetArch}`, 'vec0.dylib'),
  );
  ensureFile(
    `macOS ${targetArch} canvas runtime binary`,
    path.join(PC_DIR, 'node_modules', '@napi-rs', `canvas-darwin-${targetArch}`, `skia.darwin-${targetArch}.node`),
  );
}

main();
