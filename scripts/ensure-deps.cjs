#!/usr/bin/env node
// 启动前依赖一致性检查：比较 package.json + package-lock.json 的 SHA256 与
// node_modules/.orkas-deps-hash 里上次安装的哈希，不一致就自动 npm install。
// 由 run.sh / run.cmd 调用，单点跨平台。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PC_DIR = path.resolve(__dirname, '..');
const PKG = path.join(PC_DIR, 'package.json');
const LOCK = path.join(PC_DIR, 'package-lock.json');
const NODE_MODULES = path.join(PC_DIR, 'node_modules');
const STAMP = path.join(NODE_MODULES, '.orkas-deps-hash');

function missingDeclaredDependencyPackages(options = {}) {
  const packageFile = options.packageFile || PKG;
  const nodeModulesDir = options.nodeModulesDir || NODE_MODULES;
  const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const names = new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.devDependencies || {}),
  ]);
  const missing = [];
  for (const name of [...names].sort()) {
    const manifest = path.join(nodeModulesDir, ...name.split('/'), 'package.json');
    try {
      const installed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (!installed || typeof installed.version !== 'string' || !installed.version.trim()) {
        missing.push(name);
      }
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

function summarizePackages(packages) {
  const visible = packages.slice(0, 5).join(', ');
  return packages.length > 5 ? `${visible}, +${packages.length - 5} more` : visible;
}

function dependencyInstallReason({ nodeModulesExists, stored, current, missingPackages }) {
  if (!nodeModulesExists) return 'node_modules_missing';
  if (stored !== current) return 'fingerprint_changed';
  if (missingPackages.length > 0) return 'packages_incomplete';
  return '';
}

// 指纹只覆盖真正影响 npm install 结果的字段，避免改 scripts.stop / build /
// name 这类无关字段也触发重装。
function depFingerprint() {
  const h = crypto.createHash('sha256');
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  } catch (err) {
    h.update('<pkg-parse-error>\0' + err.message);
    return h.digest('hex');
  }
  const subset = {};
  for (const k of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'overrides',
    'resolutions',
    'workspaces',
  ]) {
    if (pkg[k] !== undefined) subset[k] = pkg[k];
  }
  // install 钩子改了会改 node_modules 内容
  if (pkg.scripts) {
    const hooks = {};
    for (const s of ['preinstall', 'install', 'postinstall']) {
      if (pkg.scripts[s] !== undefined) hooks[s] = pkg.scripts[s];
    }
    if (Object.keys(hooks).length) subset.__installHooks = hooks;
  }
  h.update(JSON.stringify(subset));
  h.update('\0');
  if (fs.existsSync(LOCK)) {
    h.update(fs.readFileSync(LOCK));
  } else {
    h.update('<missing-lock>');
  }
  return h.digest('hex');
}

function readStamp() {
  try {
    return fs.readFileSync(STAMP, 'utf8').trim();
  } catch {
    return '';
  }
}

function writeStamp(hash) {
  fs.writeFileSync(STAMP, hash + '\n', 'utf8');
}

function npmInstallInvocation() {
  let packageManager = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
    packageManager = String(pkg.packageManager || '').trim();
  } catch {
    packageManager = '';
  }

  if (/^npm@\d/.test(packageManager)) {
    const corepackCmd = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
    const corepackProbe = spawnSync(corepackCmd, ['--version'], {
      cwd: PC_DIR,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    if (!corepackProbe.error) {
      return {
        cmd: corepackCmd,
        args: ['npm', 'install'],
        shell: process.platform === 'win32',
        label: `corepack npm install (${packageManager})`,
      };
    }
    console.warn(`[Orkas] corepack unavailable (${corepackProbe.error.message}); falling back to npm install.`);
    return {
      cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['install'],
      shell: process.platform === 'win32',
      label: `npm install (fallback for ${packageManager})`,
    };
  }

  return {
    cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['install'],
    shell: process.platform === 'win32',
    label: 'npm install',
  };
}

function runNpmInstall() {
  const invocation = npmInstallInvocation();
  console.log(`[Orkas] Installing dependencies with ${invocation.label}...`);
  const res = spawnSync(invocation.cmd, invocation.args, {
    cwd: PC_DIR,
    stdio: 'inherit',
    shell: invocation.shell,
  });
  if (res.error) {
    console.error(`[Orkas] ${invocation.label} failed to start:`, res.error.message);
    process.exit(1);
  }
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

// KB embedding 模型（bge-small-zh-v1.5，95MB）随 postinstall 下到
// `PC/resources/embedding-model/`，gitignored。即使 package.json/lockfile
// 没变、但模型文件被误删（或 clone 后还没跑过 postinstall），这里补跑一次。
// 脚本本身幂等 —— 文件齐全时立即返回。
const MODEL_DIR = path.join(PC_DIR, 'resources', 'embedding-model', 'fast-bge-small-zh-v1.5');
const MODEL_REQUIRED = ['config.json', 'tokenizer.json', 'model_optimized.onnx'];

function modelReady() {
  if (!fs.existsSync(MODEL_DIR)) return false;
  return MODEL_REQUIRED.every((f) => fs.existsSync(path.join(MODEL_DIR, f)));
}

function runModelFetch() {
  const res = spawnSync(process.execPath, [path.join(PC_DIR, 'scripts', 'fetch-embedding-model.mjs')], {
    cwd: PC_DIR,
    stdio: 'inherit',
    shell: false,
  });
  if (res.error) {
    console.error('[Orkas] 模型下载启动失败：', res.error.message);
    process.exit(1);
  }
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

const ELECTRON_DIR = path.join(NODE_MODULES, 'electron');
const ELECTRON_INSTALL = path.join(ELECTRON_DIR, 'install.js');
const ELECTRON_PATH_TXT = path.join(ELECTRON_DIR, 'path.txt');

function electronExpectedVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8'));
    return String(pkg.version || '').trim();
  } catch {
    return '';
  }
}

function electronBinaryPath() {
  try {
    const rel = fs.readFileSync(ELECTRON_PATH_TXT, 'utf8').trim();
    if (!rel) return '';
    return path.join(ELECTRON_DIR, 'dist', rel);
  } catch {
    return '';
  }
}

function electronPlatformPath() {
  switch (process.platform) {
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'win32':
      return 'electron.exe';
    default:
      return 'electron';
  }
}

function electronDarwinAppRoot(bin) {
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}Electron`;
  if (!bin.endsWith(marker)) return '';
  return bin.slice(0, -marker.length);
}

function electronDistReady(distDir, relPath, expected) {
  const bin = path.join(distDir, relPath);
  if (!bin || !fs.existsSync(bin)) return false;

  try {
    const actual = fs.readFileSync(path.join(distDir, 'version'), 'utf8').trim().replace(/^v/, '');
    if (actual !== expected) return false;
  } catch {
    return false;
  }

  if (process.platform === 'darwin') {
    const appRoot = electronDarwinAppRoot(bin);
    if (!appRoot) return false;
    const framework = path.join(
      appRoot,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Electron Framework',
    );
    if (!fs.existsSync(framework)) return false;
  }

  return true;
}

function electronReady() {
  const expected = electronExpectedVersion();
  if (!expected) return false;
  try {
    const rel = fs.readFileSync(ELECTRON_PATH_TXT, 'utf8').trim();
    if (!rel) return false;
    return electronDistReady(path.join(ELECTRON_DIR, 'dist'), rel, expected);
  } catch {
    return false;
  }
}

function runElectronInstall(reason) {
  if (!fs.existsSync(ELECTRON_INSTALL)) {
    console.error('[Orkas] Electron package is incomplete: node_modules/electron/install.js is missing.');
    console.error('[Orkas] Run `npm install` in PC/ or remove PC/node_modules and start again.');
    process.exit(1);
  }

  console.log(`[Orkas] Electron binary is not ready (${reason}); repairing Electron install...`);
  const res = spawnSync(process.execPath, [ELECTRON_INSTALL], {
    cwd: PC_DIR,
    stdio: 'inherit',
    shell: false,
  });
  if (res.error) {
    console.error('[Orkas] Electron install script failed to start:', res.error.message);
    process.exit(1);
  }
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function findFileByName(root, name) {
  if (!root || !fs.existsSync(root)) return '';
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === name) return candidate;
    }
  }
  return '';
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function repairWindowsElectronFromCache() {
  if (process.platform !== 'win32') return false;

  const version = electronExpectedVersion();
  const archiveName = `electron-v${version}-win32-${process.arch}.zip`;
  let expectedSha = '';
  try {
    const checksums = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'checksums.json'), 'utf8'));
    expectedSha = String(checksums[archiveName] || '').toLowerCase();
  } catch {
    return false;
  }
  if (!version || !expectedSha) return false;

  const cacheRoot = process.env.electron_config_cache
    || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron', 'Cache'));
  const archive = findFileByName(cacheRoot, archiveName);
  if (!archive) return false;

  const actualSha = sha256File(archive);
  if (actualSha !== expectedSha) {
    console.warn(`[Orkas] Ignoring Electron cache with a checksum mismatch: ${archiveName}`);
    return false;
  }

  const distDir = path.join(ELECTRON_DIR, 'dist');
  console.log('[Orkas] Electron npm extraction was incomplete; repairing from the verified download cache...');
  fs.rmSync(distDir, { recursive: true, force: true });
  const command = `Expand-Archive -LiteralPath ${powershellQuote(archive)} -DestinationPath ${powershellQuote(distDir)} -Force`;
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', command,
  ], {
    cwd: PC_DIR,
    stdio: 'inherit',
    shell: false,
    timeout: 10 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    console.warn('[Orkas] Verified Electron cache extraction failed:', result.error?.message || `exit ${result.status}`);
    return false;
  }
  fs.writeFileSync(ELECTRON_PATH_TXT, 'electron.exe', 'utf8');
  return electronReady();
}

function ensureElectronReady(reason = 'missing binary') {
  if (electronReady()) return;

  runElectronInstall(reason);
  if (electronReady()) return;
  if (repairWindowsElectronFromCache()) return;

  const bin = electronBinaryPath() || '<missing path.txt>';
  console.error('[Orkas] Electron is still incomplete after repair.');
  console.error(`[Orkas] Expected Electron binary: ${bin}`);
  console.error('[Orkas] Check network access to the Electron download host, then rerun Orkas.');
  process.exit(1);
}

// macOS dev 模式下 Dock tooltip + Cmd-Tab + 菜单栏左上角的应用名，全部
// 来自 `Electron.app/Contents/Info.plist` 的 CFBundleName / CFBundleDisplayName。
// `app.setName()` 只改菜单栏第一项，**改不了 Dock**。
//
// 单独改 plist 不够：macOS Launch Services 对 bundle identifier
// `com.github.Electron` 有持久缓存，即使 `lsregister -f` 也常常拒绝刷新。
// 唯一可靠方案是把 .app 目录本身重命名（让 macOS 当成新 app 重新登记），
// 同时同步更新 `electron/path.txt`（npm electron launcher 就是靠它定位
// 二进制的）。重命名 + 改 plist + ad-hoc 重签 + lsregister + killall Dock
// 一套打下来才算数。
//
// 幂等：node_modules/electron/dist/Orkas.app 已存在就跳过。npm install
// 会重新落地 Electron.app（覆盖 Orkas.app 的话也无所谓，下次启动重新走
// 这套流程）。
function patchElectronAppName() {
  if (process.platform !== 'darwin') return;
  const distDir = path.join(NODE_MODULES, 'electron', 'dist');
  const oldApp = path.join(distDir, 'Electron.app');
  const newApp = path.join(distDir, 'Orkas.app');
  const pathTxt = path.join(NODE_MODULES, 'electron', 'path.txt');
  if (!fs.existsSync(distDir)) return;

  // 已经 patched 过：直接返回。检查 Orkas.app 存在 + path.txt 已更新。
  if (fs.existsSync(newApp) && !fs.existsSync(oldApp)) {
    let pathTxtContent = '';
    try { pathTxtContent = fs.readFileSync(pathTxt, 'utf8').trim(); } catch { /* */ }
    if (pathTxtContent.startsWith('Orkas.app/')) return;
  }

  // 重命名 Electron.app → Orkas.app（如果两者都在，先把旧的删掉避免混淆）。
  if (fs.existsSync(oldApp)) {
    if (fs.existsSync(newApp)) fs.rmSync(newApp, { recursive: true, force: true });
    try { fs.renameSync(oldApp, newApp); }
    catch (err) {
      console.warn('[Orkas] 重命名 Electron.app 失败（' + err.message + '）：可能有进程仍在占用，跳过此次 patch');
      return;
    }
  } else if (!fs.existsSync(newApp)) {
    return; // 既没有旧也没有新，电子组件可能损坏，留给上层 npm install 处理
  }

  // 改 plist 三键。
  const plistPath = path.join(newApp, 'Contents', 'Info.plist');
  for (const [key, val] of [
    ['CFBundleName', 'Orkas'],
    ['CFBundleDisplayName', 'Orkas'],
  ]) {
    const r = spawnSync('plutil', ['-replace', key, '-string', val, plistPath], { stdio: 'pipe' });
    if (r.status !== 0) {
      console.warn('[Orkas] plutil -replace ' + key + ' 失败：', (r.stderr || '').toString().trim());
    }
  }

  // 改完 plist 后旧签名失效，必须 ad-hoc 重签。
  const cs = spawnSync('codesign', ['--force', '--deep', '--sign', '-', newApp], { stdio: 'pipe' });
  if (cs.status !== 0) {
    console.warn('[Orkas] Orkas.app ad-hoc 重签失败（手动修复：codesign --force --deep --sign - "' + newApp + '"）：', (cs.stderr || '').toString().trim());
  }

  // electron npm launcher 通过 path.txt 定位二进制；指向新名字。
  try { fs.writeFileSync(pathTxt, 'Orkas.app/Contents/MacOS/Electron'); }
  catch (err) {
    console.warn('[Orkas] 更新 electron/path.txt 失败（' + err.message + '）：electron CLI 可能找不到二进制');
  }

  // Launch Services：注销旧路径 + 注册新路径。重启 Dock 丢掉运行实例缓存。
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
  spawnSync(lsregister, ['-u', oldApp], { stdio: 'pipe' });
  spawnSync(lsregister, ['-f', newApp], { stdio: 'pipe' });
  spawnSync('killall', ['Dock'], { stdio: 'pipe' });
  console.log('[Orkas] Dock 名称已改为 Orkas（重命名 Electron.app → Orkas.app；下次启动生效）');
}

function main() {
  if (!fs.existsSync(PKG)) {
    console.error('[Orkas] 找不到 package.json：', PKG);
    process.exit(1);
  }

  const current = depFingerprint();
  const stored = readStamp();
  const nodeModulesExists = fs.existsSync(NODE_MODULES);
  const missingPackages = nodeModulesExists ? missingDeclaredDependencyPackages() : [];
  const installReason = dependencyInstallReason({
    nodeModulesExists,
    stored,
    current,
    missingPackages,
  });

  if (!installReason) {
    // 依赖已同步；但模型文件可能被误删，单独校验一次。
    if (!modelReady()) {
      console.log('[Orkas] 知识库 embedding 模型缺失，补下载（约 90MB）...');
      runModelFetch();
    }
    ensureElectronReady('dependency stamp is current but Electron files are incomplete');
    patchElectronAppName();
    ensureElectronReady('Electron app-name patch left Electron files incomplete');
    return;
  }

  if (installReason === 'node_modules_missing') {
    console.log('[Orkas] 首次运行：安装依赖 + 下载嵌入模型（约 5～10 分钟）...');
  } else if (installReason === 'packages_incomplete') {
    console.log(`[Orkas] Installed npm packages are incomplete (${summarizePackages(missingPackages)}); repairing...`);
  } else {
    console.log('[Orkas] 依赖与 package.json / lockfile 不一致，执行 npm install...');
  }

  runNpmInstall();
  const missingAfterInstall = missingDeclaredDependencyPackages();
  if (missingAfterInstall.length > 0) {
    console.error(`[Orkas] npm install completed but required packages are still incomplete: ${summarizePackages(missingAfterInstall)}`);
    process.exit(1);
  }
  ensureElectronReady('npm install finished without a complete Electron binary');

  // 双保险：npm install 的 postinstall 已跑 fetch-embedding-model，若因 npm
  // 的 postinstall 被 --ignore-scripts / CI 配置跳过，这里再兜底补一次。
  if (!modelReady()) {
    console.log('[Orkas] 嵌入模型尚未就绪，补下载...');
    runModelFetch();
  }

  // npm install 重新落地的 Electron 会带回 "Electron" 字样的 Info.plist —
  // 必须紧接着再 patch 一遍，否则 Dock 又会显示 Electron。
  patchElectronAppName();
  ensureElectronReady('Electron app-name patch left Electron files incomplete');

  // 安装后重新算一次（postinstall 钩子不会改 package.json/lockfile，但保险起见）
  const finalHash = depFingerprint();
  try {
    writeStamp(finalHash);
  } catch (err) {
    console.warn('[Orkas] 警告：写入依赖 stamp 失败（不影响启动）：', err.message);
  }
}

if (require.main === module) main();

module.exports = {
  dependencyInstallReason,
  missingDeclaredDependencyPackages,
};
