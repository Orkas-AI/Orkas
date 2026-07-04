/**
 * electron-builder afterPack hook —— 在 macOS 包最终生成前,对整个 .app
 * bundle 跑 ad-hoc codesign。**Why**:没有 Apple Developer ID 时,
 * electron-builder 会跳过签名,产出的 .app 从 dmg 拷出来后被 macOS
 * Gatekeeper(13+)直接判"已损坏",连"无法验证开发者"对话框都跳过。
 * Ad-hoc 签名让 bundle 至少有一个完整的签名结构,Gatekeeper 退化成
 * "未验证开发者",用户右键 → 打开一次就放行。
 *
 * 依赖清理对 macOS / Windows 都生效;签名补救仅 darwin 平台生效。
 */
'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { verifyRuntimeRoot } = require('../bin/runtime-gate.cjs');

const ARCH_NAMES = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
};

function removeIfExists(target) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

function requiredFile(label, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`[native-deps-gate] missing ${label}: ${file}`);
  }
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function pruneOnnxRuntimePackage(pkgDir, targetPlatform, targetArch) {
  const binDir = path.join(pkgDir, 'bin');
  if (!fs.existsSync(binDir)) return;

  const keepArch = targetArch === 'arm64' || targetArch === 'x64' ? targetArch : null;
  for (const napiDirName of listDirs(binDir)) {
    const napiDir = path.join(binDir, napiDirName);
    for (const platformDirName of listDirs(napiDir)) {
      if (platformDirName !== targetPlatform) {
        removeIfExists(path.join(napiDir, platformDirName));
      }
    }

    if (!keepArch) continue;
    const platformDir = path.join(napiDir, targetPlatform);
    for (const archDirName of listDirs(platformDir)) {
      if (archDirName !== keepArch) {
        removeIfExists(path.join(platformDir, archDirName));
      }
    }
  }
}

function targetEsbuildPackage(targetPlatform, targetArch) {
  if (targetPlatform === 'darwin' && (targetArch === 'arm64' || targetArch === 'x64')) {
    return `darwin-${targetArch}`;
  }
  if (targetPlatform === 'win32' && targetArch === 'x64') return 'win32-x64';
  return null;
}

function pruneEsbuildPackage(nodeModules, targetPlatform, targetArch) {
  const esbuildDir = path.join(nodeModules, '@esbuild');
  if (!fs.existsSync(esbuildDir)) return;

  const keepPackage = targetEsbuildPackage(targetPlatform, targetArch);
  for (const dirName of listDirs(esbuildDir)) {
    if (keepPackage && dirName !== keepPackage) {
      removeIfExists(path.join(esbuildDir, dirName));
    }
  }

  if (!keepPackage) return;
  const bin = targetPlatform === 'win32'
    ? path.join(esbuildDir, keepPackage, 'esbuild.exe')
    : path.join(esbuildDir, keepPackage, 'bin', 'esbuild');
  if (!fs.existsSync(bin)) {
    throw new Error(`[codesign-adhoc] missing ${targetPlatform} ${targetArch} esbuild runtime binary: ${bin}`);
  }
}

function targetSqliteVecPackage(targetPlatform, targetArch) {
  if (targetPlatform === 'darwin' && (targetArch === 'arm64' || targetArch === 'x64')) {
    return `sqlite-vec-darwin-${targetArch}`;
  }
  if (targetPlatform === 'win32' && targetArch === 'x64') return 'sqlite-vec-windows-x64';
  return null;
}

function pruneSqliteVecPackages(nodeModules, targetPlatform, targetArch) {
  const keepPackage = targetSqliteVecPackage(targetPlatform, targetArch);
  for (const dirName of listDirs(nodeModules)) {
    if (/^sqlite-vec-(darwin|linux|windows)-/i.test(dirName) && dirName !== keepPackage) {
      removeIfExists(path.join(nodeModules, dirName));
    }
  }
}

function targetCanvasPackage(targetPlatform, targetArch) {
  if (targetPlatform === 'darwin' && (targetArch === 'arm64' || targetArch === 'x64')) {
    return `canvas-darwin-${targetArch}`;
  }
  if (targetPlatform === 'win32' && targetArch === 'x64') return 'canvas-win32-x64-msvc';
  if (targetPlatform === 'win32' && targetArch === 'arm64') return 'canvas-win32-arm64-msvc';
  return null;
}

function pruneCanvasPackages(nodeModules, targetPlatform, targetArch) {
  const napiDir = path.join(nodeModules, '@napi-rs');
  const keepPackage = targetCanvasPackage(targetPlatform, targetArch);
  for (const dirName of listDirs(napiDir)) {
    if (/^canvas-/i.test(dirName) && dirName !== keepPackage) {
      removeIfExists(path.join(napiDir, dirName));
    }
  }
}

function targetTokenizersPackage(targetPlatform, targetArch) {
  if (targetPlatform === 'darwin') return 'tokenizers-darwin-universal';
  if (targetPlatform === 'win32' && targetArch === 'x64') return 'tokenizers-win32-x64-msvc';
  return null;
}

function pruneTokenizersPackages(nodeModules, targetPlatform, targetArch) {
  const tokenizersDir = path.join(nodeModules, '@anush008');
  const keepPackage = targetTokenizersPackage(targetPlatform, targetArch);
  for (const dirName of listDirs(tokenizersDir)) {
    if (/^tokenizers-/i.test(dirName) && dirName !== keepPackage) {
      removeIfExists(path.join(tokenizersDir, dirName));
    }
  }
}

function packageDir(nodeModules, packageName) {
  return path.join(nodeModules, ...packageName.split('/'));
}

function requireOnlyPackages(parentDir, pattern, allowedPackages) {
  const allowed = new Set(allowedPackages.filter(Boolean));
  for (const dirName of listDirs(parentDir)) {
    if (pattern.test(dirName) && !allowed.has(dirName)) {
      throw new Error(`[native-deps-gate] unexpected native package for target: ${path.join(parentDir, dirName)}`);
    }
  }
}

function verifyOnnxRuntimePackage(pkgDir, targetPlatform, targetArch, verified) {
  const binDir = path.join(pkgDir, 'bin');
  if (!fs.existsSync(binDir)) return;

  for (const napiDirName of listDirs(binDir)) {
    const napiDir = path.join(binDir, napiDirName);
    const platformDirs = listDirs(napiDir);
    for (const platformDirName of platformDirs) {
      if (platformDirName !== targetPlatform) {
        throw new Error(`[native-deps-gate] unexpected onnxruntime platform ${platformDirName}: ${path.join(napiDir, platformDirName)}`);
      }
    }

    const platformDir = path.join(napiDir, targetPlatform);
    const archDirs = listDirs(platformDir);
    for (const archDirName of archDirs) {
      if (archDirName !== targetArch) {
        throw new Error(`[native-deps-gate] unexpected onnxruntime arch ${archDirName}: ${path.join(platformDir, archDirName)}`);
      }
    }

    requiredFile(
      `onnxruntime ${targetPlatform}/${targetArch} binding`,
      path.join(platformDir, targetArch, 'onnxruntime_binding.node'),
    );
    verified.push(`${path.relative(pkgDir, path.join(platformDir, targetArch))}`);
  }
}

function verifyPackedNativePayload(nodeModules, targetPlatform, targetArch) {
  const esbuildPackage = targetEsbuildPackage(targetPlatform, targetArch);
  const sqlitePackage = targetSqliteVecPackage(targetPlatform, targetArch);
  const canvasPackage = targetCanvasPackage(targetPlatform, targetArch);
  const tokenizersPackage = targetTokenizersPackage(targetPlatform, targetArch);
  const lock = readPackageLock();
  const verified = [];

  requireOnlyPackages(path.join(nodeModules, '@esbuild'), /^.+$/, [esbuildPackage]);
  requireOnlyPackages(nodeModules, /^sqlite-vec-(darwin|linux|windows)-/i, [sqlitePackage]);
  requireOnlyPackages(path.join(nodeModules, '@napi-rs'), /^canvas-/i, [canvasPackage]);
  requireOnlyPackages(path.join(nodeModules, '@anush008'), /^tokenizers-/i, [tokenizersPackage]);

  if (targetPlatform !== 'darwin' && fs.existsSync(path.join(nodeModules, 'fsevents'))) {
    throw new Error('[native-deps-gate] fsevents must not be included in non-macOS packages');
  }

  if (targetPlatform === 'darwin') {
    requiredFile(
      `${esbuildPackage} binary`,
      path.join(packageDir(nodeModules, `@esbuild/${esbuildPackage}`), 'bin', 'esbuild'),
    );
    requiredFile(
      `${sqlitePackage} binary`,
      path.join(packageDir(nodeModules, sqlitePackage), 'vec0.dylib'),
    );
    requiredFile(
      `${canvasPackage} binary`,
      path.join(packageDir(nodeModules, `@napi-rs/${canvasPackage}`), `skia.darwin-${targetArch}.node`),
    );
    requiredFile(
      `${tokenizersPackage} binary`,
      path.join(packageDir(nodeModules, `@anush008/${tokenizersPackage}`), 'tokenizers.darwin-universal.node'),
    );
  } else if (targetPlatform === 'win32') {
    requiredFile(
      `${esbuildPackage} binary`,
      path.join(packageDir(nodeModules, `@esbuild/${esbuildPackage}`), 'esbuild.exe'),
    );
    requiredFile(
      `${sqlitePackage} binary`,
      path.join(packageDir(nodeModules, sqlitePackage), 'vec0.dll'),
    );
    requiredFile(
      `${canvasPackage} binary`,
      path.join(packageDir(nodeModules, `@napi-rs/${canvasPackage}`), 'skia.win32-x64-msvc.node'),
    );
    requiredFile(
      `${tokenizersPackage} binary`,
      path.join(packageDir(nodeModules, `@anush008/${tokenizersPackage}`), 'tokenizers.win32-x64-msvc.node'),
    );
  }

  requiredFile(
    'better-sqlite3 Electron native binding',
    path.join(nodeModules, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  );

  verifyPackageVersion(nodeModules, lock, `@esbuild/${esbuildPackage}`, verified);
  verifyPackageVersion(nodeModules, lock, sqlitePackage, verified);
  verifyPackageVersion(nodeModules, lock, `@napi-rs/${canvasPackage}`, verified);
  verifyPackageVersion(nodeModules, lock, `@anush008/${tokenizersPackage}`, verified);
  verifyPackageVersion(nodeModules, lock, 'better-sqlite3', verified);
  for (const pkgDir of [
    path.join(nodeModules, 'onnxruntime-node'),
    path.join(nodeModules, 'fastembed', 'node_modules', 'onnxruntime-node'),
  ]) {
    verifyOnnxRuntimePackage(pkgDir, targetPlatform, targetArch, verified);
  }
  verifyExistingPackageVersion(
    path.join(nodeModules, 'onnxruntime-node'),
    lock,
    'node_modules/onnxruntime-node',
    verified,
  );
  verifyExistingPackageVersion(
    path.join(nodeModules, 'fastembed', 'node_modules', 'onnxruntime-node'),
    lock,
    'node_modules/fastembed/node_modules/onnxruntime-node',
    verified,
  );

  return verified.filter(Boolean);
}

function appNodeModules(context, appPath) {
  if (context.electronPlatformName === 'darwin') {
    return path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules');
  }
  return path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules');
}

function appResourcesDir(context, appPath) {
  if (context.electronPlatformName === 'darwin') {
    return path.join(appPath, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

function readJsonFile(label, file) {
  requiredFile(label, file);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`[native-deps-gate] invalid ${label}: ${file}: ${err.message}`);
  }
}

function packageLockPath() {
  return path.join(__dirname, '..', 'package-lock.json');
}

function packageLockEntryPath(packageName) {
  return `node_modules/${packageName}`;
}

function readPackageLock() {
  return readJsonFile('package lock', packageLockPath());
}

function lockPackageVersion(lock, packageName, lockPath = packageLockEntryPath(packageName)) {
  const version = lock.packages?.[lockPath]?.version;
  if (!version) {
    throw new Error(`[native-deps-gate] package-lock.json missing ${lockPath}`);
  }
  return version;
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  return index >= 0 ? lockPath.slice(index + marker.length) : lockPath;
}

function lockPackageVersionByName(lock, packageName) {
  const versions = new Set();
  for (const [lockPath, entry] of Object.entries(lock.packages || {})) {
    if (packageNameFromLockPath(lockPath) === packageName && entry?.version) {
      versions.add(String(entry.version));
    }
  }

  if (versions.size === 0) {
    throw new Error(`[native-deps-gate] package-lock.json missing package ${packageName}`);
  }
  if (versions.size > 1) {
    throw new Error(`[native-deps-gate] package-lock.json has multiple versions for ${packageName}: ${[...versions].join(', ')}`);
  }
  return [...versions][0];
}

function lockPackageVersionForPathOrName(lock, packageName, lockPath) {
  const directVersion = lock.packages?.[lockPath]?.version;
  if (directVersion) return String(directVersion);
  return lockPackageVersionByName(lock, packageName);
}

function packageJsonPath(nodeModules, packageName) {
  return path.join(nodeModules, ...packageName.split('/'), 'package.json');
}

function verifyPackageVersion(nodeModules, lock, packageName, verified, lockPath = packageLockEntryPath(packageName)) {
  const pkg = readJsonFile(`${packageName} package.json`, packageJsonPath(nodeModules, packageName));
  const expected = lockPackageVersion(lock, packageName, lockPath);
  if (String(pkg.version || '') !== String(expected)) {
    throw new Error(`[native-deps-gate] ${packageName} version mismatch: packaged=${pkg.version || '(missing)'} lock=${expected}`);
  }
  verified.push(`${packageName}@${expected}`);
}

function verifyExistingPackageVersion(packageDir, lock, lockPath, verified) {
  if (!fs.existsSync(packageDir) || !fs.statSync(packageDir).isDirectory()) return;
  const pkg = readJsonFile(`${lockPath} package.json`, path.join(packageDir, 'package.json'));
  const packageName = pkg.name || packageNameFromLockPath(lockPath);
  const expected = lockPackageVersionForPathOrName(lock, packageName, lockPath);
  if (String(pkg.version || '') !== String(expected)) {
    throw new Error(`[native-deps-gate] ${lockPath} version mismatch: packaged=${pkg.version || '(missing)'} lock=${expected}`);
  }
  verified.push(`${lockPath}@${expected}`);
}

function verifyPackedRuntimePayload(context, appPath, targetPlatform, targetArch) {
  const runtimeRoot = path.join(appResourcesDir(context, appPath), 'runtime');
  // npm/npx companion verification (my node-runtime hardening) is preserved by
  // verifyRuntimeRoot → verifyRuntimeDir → runtimeCompanionFiles (runtime-gate.cjs),
  // which the remote extracted; it also keeps marker/pip-shim/arch/dir-allowlist checks.
  return verifyRuntimeRoot(runtimeRoot, targetPlatform, targetArch);
}

function prunePackedNativePayload(context, appPath, targetPlatform, targetArch) {
  const nodeModules = appNodeModules(context, appPath);
  if (!fs.existsSync(nodeModules)) return [];
  const packages = [
    path.join(nodeModules, 'onnxruntime-node'),
    path.join(nodeModules, 'fastembed', 'node_modules', 'onnxruntime-node'),
  ];

  pruneEsbuildPackage(nodeModules, targetPlatform, targetArch);
  pruneSqliteVecPackages(nodeModules, targetPlatform, targetArch);
  pruneCanvasPackages(nodeModules, targetPlatform, targetArch);
  pruneTokenizersPackages(nodeModules, targetPlatform, targetArch);
  if (targetPlatform !== 'darwin') {
    removeIfExists(path.join(nodeModules, 'fsevents'));
  }

  for (const pkgDir of packages) {
    pruneOnnxRuntimePackage(pkgDir, targetPlatform, targetArch);
  }

  return verifyPackedNativePayload(nodeModules, targetPlatform, targetArch);
}

function writeNativeGateMarker(context, targetPlatform, targetArch, verified) {
  const marker = {
    status: 'passed',
    phase: 'post-package/pre-sign',
    platform: targetPlatform,
    arch: targetArch,
    verified,
    checkedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(context.appOutDir, '.orkas-native-deps-verified.json'),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function publishEntries(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return [value];
  return [];
}

function genericPublishUrl(context) {
  const publish = context?.packager?.config?.publish;
  for (const item of publishEntries(publish)) {
    if (!item || typeof item !== 'object') continue;
    if (item.provider === 'generic' && typeof item.url === 'string' && item.url.trim()) {
      return ensureTrailingSlash(item.url.trim());
    }
  }

  const envUrl = String(process.env.DEV_FEED_URL || process.env.PRODUCT_FEED_URL || '').trim();
  if (envUrl) return ensureTrailingSlash(envUrl);
  return '';
}

function updaterCacheDirName(context) {
  const fromBuilder = context?.packager?.appInfo?.updaterCacheDirName;
  if (typeof fromBuilder === 'string' && fromBuilder.trim()) return fromBuilder.trim();
  return 'orkas-updater';
}

function writeMacAppUpdateConfig(context, appPath) {
  if (context.electronPlatformName !== 'darwin') return;
  const resourcesDir = path.join(appPath, 'Contents', 'Resources');
  const configFile = path.join(resourcesDir, 'app-update.yml');

  if (process.argv.includes('--prepackaged')) {
    if (!fs.existsSync(configFile)) {
      console.warn(`[app-update-config] missing in prepackaged app; not mutating signed bundle: ${configFile}`);
    }
    return;
  }

  const url = genericPublishUrl(context);
  if (!url) {
    console.warn('[app-update-config] no generic publish URL; app-update.yml was not written');
    return;
  }

  fs.mkdirSync(resourcesDir, { recursive: true });
  const body = [
    'provider: generic',
    `url: ${JSON.stringify(url)}`,
    `updaterCacheDirName: ${updaterCacheDirName(context)}`,
    '',
  ].join('\n');
  fs.writeFileSync(configFile, body, 'utf8');
  console.log(`[app-update-config] wrote ${configFile}`);
}

module.exports = async function afterPack(context) {
  const targetPlatform = context.electronPlatformName;
  const targetArch = ARCH_NAMES[context.arch] || process.arch;
  const appName = context.packager.appInfo.productFilename;
  const appPath = targetPlatform === 'darwin'
    ? path.join(context.appOutDir, `${appName}.app`)
    : context.appOutDir;

  writeMacAppUpdateConfig(context, appPath);

  console.log('==== Native dependency gate: post-package/pre-sign ====');
  console.log(`[native-deps-gate] target=${targetPlatform}/${targetArch}`);
  const verified = prunePackedNativePayload(context, appPath, targetPlatform, targetArch);
  verified.push(...verifyPackedRuntimePayload(context, appPath, targetPlatform, targetArch));
  writeNativeGateMarker(context, targetPlatform, targetArch, verified);
  console.log(`[native-deps-gate] verified: ${verified.join(', ')}`);
  console.log('[native-deps-gate] result=passed; signing may continue');

  if (targetPlatform !== 'darwin') return;


  if (process.env.ORKAS_FORCE_ADHOC_CODESIGN !== '1' && (process.env.CSC_LINK || process.env.CSC_NAME)) {
    console.log('[codesign-adhoc] formal signing env detected; skipping ad-hoc signing');
    return;
  }

  console.log(`[codesign-adhoc] signing ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  // 校验签名(失败时直接 throw 中断 build,避免发出未签的包)
  execSync(`codesign --verify --deep "${appPath}"`, { stdio: 'inherit' });
};
