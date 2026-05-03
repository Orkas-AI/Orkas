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

function runNpmInstall() {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const res = spawnSync(npmCmd, ['install'], {
    cwd: PC_DIR,
    stdio: 'inherit',
    shell: true,
  });
  if (res.error) {
    console.error('[Orkas] npm install 启动失败：', res.error.message);
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

// In macOS dev mode the Dock tooltip + Cmd-Tab name + menu bar header
// all come from `Electron.app/Contents/Info.plist` (`CFBundleName` /
// `CFBundleDisplayName`). `app.setName()` only changes the first menu
// bar item -- it does NOT change the Dock.
//
// Editing the plist alone is not enough: macOS Launch Services keeps a
// persistent cache keyed by bundle id `com.github.Electron`, and even
// `lsregister -f` often refuses to refresh. The only reliable approach
// is to rename the .app directory itself (so macOS treats it as a new
// app and re-registers), and update `electron/path.txt` alongside (the
// npm electron launcher reads that to locate the binary). Rename +
// plist edit + ad-hoc resign + lsregister + killall Dock are all
// required for the change to stick.
//
// Idempotent: skip when node_modules/electron/dist/Orkas.app already
// exists. `npm install` re-lands Electron.app (overwriting Orkas.app
// is fine -- the next launch redoes the patch).
function patchElectronAppName() {
  if (process.platform !== 'darwin') return;
  const distDir = path.join(NODE_MODULES, 'electron', 'dist');
  const oldApp = path.join(distDir, 'Electron.app');
  const newApp = path.join(distDir, 'Orkas.app');
  const pathTxt = path.join(NODE_MODULES, 'electron', 'path.txt');
  if (!fs.existsSync(distDir)) return;

  // Already patched: bail out. Verify Orkas.app exists + path.txt is updated.
  if (fs.existsSync(newApp) && !fs.existsSync(oldApp)) {
    let pathTxtContent = '';
    try { pathTxtContent = fs.readFileSync(pathTxt, 'utf8').trim(); } catch { /* */ }
    if (pathTxtContent.startsWith('Orkas.app/')) return;
  }

  // Rename Electron.app -> Orkas.app. If both exist, drop the new one first so the rename does not collide.
  if (fs.existsSync(oldApp)) {
    if (fs.existsSync(newApp)) fs.rmSync(newApp, { recursive: true, force: true });
    try { fs.renameSync(oldApp, newApp); }
    catch (err) {
      console.warn('[Orkas] rename Electron.app failed (' + err.message + '): a process may still be holding it; skipping this patch pass');
      return;
    }
  } else if (!fs.existsSync(newApp)) {
    return; // Neither old nor new -- Electron install is broken; leave it for npm install to handle.
  }

  // Set the plist keys.
  const plistPath = path.join(newApp, 'Contents', 'Info.plist');
  for (const [key, val] of [
    ['CFBundleName', 'Orkas'],
    ['CFBundleDisplayName', 'Orkas'],
  ]) {
    const r = spawnSync('plutil', ['-replace', key, '-string', val, plistPath], { stdio: 'pipe' });
    if (r.status !== 0) {
      console.warn('[Orkas] plutil -replace ' + key + ' failed:', (r.stderr || '').toString().trim());
    }
  }

  // Editing the plist invalidates the existing signature; ad-hoc resign.
  const cs = spawnSync('codesign', ['--force', '--deep', '--sign', '-', newApp], { stdio: 'pipe' });
  if (cs.status !== 0) {
    console.warn('[Orkas] Orkas.app ad-hoc resign failed (manual fix: codesign --force --deep --sign - "' + newApp + '"):', (cs.stderr || '').toString().trim());
  }

  // The electron npm launcher uses path.txt to locate the binary; point it at the new name.
  try { fs.writeFileSync(pathTxt, 'Orkas.app/Contents/MacOS/Electron'); }
  catch (err) {
    console.warn('[Orkas] update electron/path.txt failed (' + err.message + '): the electron CLI may fail to find the binary');
  }

  // Launch Services: unregister the old path + register the new one. Restart Dock to drop any running-instance cache.
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
  spawnSync(lsregister, ['-u', oldApp], { stdio: 'pipe' });
  spawnSync(lsregister, ['-f', newApp], { stdio: 'pipe' });
  spawnSync('killall', ['Dock'], { stdio: 'pipe' });
  console.log('[Orkas] Dock name set to Orkas (renamed Electron.app -> Orkas.app; effective next launch)');
}

function main() {
  if (!fs.existsSync(PKG)) {
    console.error('[Orkas] 找不到 package.json：', PKG);
    process.exit(1);
  }

  const current = depFingerprint();
  const stored = readStamp();
  const nodeModulesExists = fs.existsSync(NODE_MODULES);

  if (nodeModulesExists && stored === current) {
    // 依赖已同步；但模型文件可能被误删，单独校验一次。
    if (!modelReady()) {
      console.log('[Orkas] 知识库 embedding 模型缺失，补下载（约 90MB）...');
      runModelFetch();
    }
    patchElectronAppName();
    return;
  }

  if (!nodeModulesExists) {
    console.log('[Orkas] 首次运行：安装依赖 + 下载嵌入模型（约 5～10 分钟）...');
  } else {
    console.log('[Orkas] 依赖与 package.json / lockfile 不一致，执行 npm install...');
  }

  runNpmInstall();

  // 双保险：npm install 的 postinstall 已跑 fetch-embedding-model，若因 npm
  // 的 postinstall 被 --ignore-scripts / CI 配置跳过，这里再兜底补一次。
  if (!modelReady()) {
    console.log('[Orkas] 嵌入模型尚未就绪，补下载...');
    runModelFetch();
  }

  // 安装后重新算一次（postinstall 钩子不会改 package.json/lockfile，但保险起见）
  const finalHash = depFingerprint();
  try {
    writeStamp(finalHash);
  } catch (err) {
    console.warn('[Orkas] 警告：写入依赖 stamp 失败（不影响启动）：', err.message);
  }
  // npm install re-lands an Electron with the upstream "Electron"
  // Info.plist; re-patch immediately or the Dock reverts.
  patchElectronAppName();
}

main();
