/**
 * electron-builder afterPack hook —— 在 macOS 包最终生成前,对整个 .app
 * bundle 跑 ad-hoc codesign。**Why**:没有 Apple Developer ID 时,
 * electron-builder 会跳过签名,产出的 .app 从 dmg 拷出来后被 macOS
 * Gatekeeper(13+)直接判"已损坏",连"无法验证开发者"对话框都跳过。
 * Ad-hoc 签名让 bundle 至少有一个完整的签名结构,Gatekeeper 退化成
 * "未验证开发者",用户右键 → 打开一次就放行。
 *
 * 仅 darwin 平台生效;其它 platform no-op。Windows / Linux 出包不受影响。
 */
'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function pruneOnnxRuntimePackage(pkgDir, targetArch) {
  const binDir = path.join(pkgDir, 'bin');
  if (!fs.existsSync(binDir)) return;

  const keepArch = targetArch === 'arm64' || targetArch === 'x64' ? targetArch : null;
  for (const napiDirName of listDirs(binDir)) {
    const napiDir = path.join(binDir, napiDirName);
    for (const platformDirName of listDirs(napiDir)) {
      if (platformDirName !== 'darwin') {
        removeIfExists(path.join(napiDir, platformDirName));
      }
    }

    if (!keepArch) continue;
    const darwinDir = path.join(napiDir, 'darwin');
    for (const archDirName of listDirs(darwinDir)) {
      if (archDirName !== keepArch) {
        removeIfExists(path.join(darwinDir, archDirName));
      }
    }
  }
}

function prunePackedNativePayload(appPath, targetArch) {
  const nodeModules = path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules');
  const packages = [
    path.join(nodeModules, 'onnxruntime-node'),
    path.join(nodeModules, 'fastembed', 'node_modules', 'onnxruntime-node'),
  ];

  for (const pkgDir of packages) {
    pruneOnnxRuntimePackage(pkgDir, targetArch);
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const targetArch = ARCH_NAMES[context.arch] || process.arch;

  prunePackedNativePayload(appPath, targetArch);

  if (process.env.ORKAS_FORCE_ADHOC_CODESIGN !== '1' && (process.env.CSC_LINK || process.env.CSC_NAME)) {
    console.log('[codesign-adhoc] formal signing env detected; skipping ad-hoc signing');
    return;
  }

  console.log(`[codesign-adhoc] signing ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  // 校验签名(失败时直接 throw 中断 build,避免发出未签的包)
  execSync(`codesign --verify --deep "${appPath}"`, { stdio: 'inherit' });
};
