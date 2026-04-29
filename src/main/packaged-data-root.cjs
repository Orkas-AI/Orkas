/**
 * Packaged 模式下 data 根目录的平台相关解析(CommonJS)。
 *
 * 返回"容器目录"(不含 `/data` 尾段),调用方自行拼接 `/data` 与
 * `/userWorkSpace`(后者由 `paths.ts::DEFAULT_USER_WORKSPACE` 按
 * `WS_ROOT/../userWorkSpace` 的 sibling 约定自动得出)。
 *
 * - macOS / Linux:`~/.orkas`
 * - Windows:优先字母最小的非系统固定盘(DriveType=3,即 DRIVE_FIXED,
 *   排除可移动盘与网络盘),无非系统固定盘时回落系统盘。
 *   如任一固定盘上已存在 `<drive>:\.orkas\data`,优先保留该盘,避免
 *   后插新盘导致数据"迁移"错位。
 *
 * **CJS 而非 TS 是必须的**:`bootstrap.cjs` 必须在 tsx 注册前完成 WS_ROOT
 * env 设置(否则 TypeScript 的 import 提升会让 paths.ts 在 env 设置前
 * 就快照了空值,WS_ROOT 落到 .app 包内)。bootstrap.cjs 不能 require .ts。
 *
 * 仅 `app.isPackaged` 分支调用;dev 仍走 `PC/data`。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function resolvePackagedContainer() {
  if (process.platform === 'win32') return resolveWindowsContainer();
  return path.join(os.homedir(), '.orkas');
}

function resolveWindowsContainer() {
  const systemDrive = normalizeDrive(process.env.SystemDrive || 'C:');
  const fixed = listFixedDrivesWin();
  const nonSystem = fixed.filter((d) => d !== systemDrive).sort();

  // 1) 已有历史安装 → 原地保留(非系统盘优先,系统盘其次)
  for (const d of nonSystem) {
    if (hasExistingInstall(d)) return containerFor(d);
  }
  if (hasExistingInstall(systemDrive)) return containerFor(systemDrive);

  // 2) 新装:字母最小的非系统固定盘;单盘回落系统盘
  if (nonSystem.length > 0) return containerFor(nonSystem[0]);
  return containerFor(systemDrive);
}

function containerFor(drive) {
  return path.join(drive + '\\', '.orkas');
}

function hasExistingInstall(drive) {
  try {
    return fs.existsSync(path.join(drive + '\\', '.orkas', 'data'));
  } catch {
    return false;
  }
}

function normalizeDrive(s) {
  const m = String(s).toUpperCase().match(/^([A-Z]:)/);
  return m ? m[1] : 'C:';
}

function listFixedDrivesWin() {
  // 首选 PowerShell 的 Win32_LogicalDisk(Win7+ 自带);DriveType=3 = DRIVE_FIXED。
  // 失败时宁可回落到"只用系统盘",也不用 fsutil 列全盘 —— 后者无法区分固定 / 可移动 /
  // 网络盘,用户明确要求排除后两者。
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID",
      ],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    const drives = out
      .split(/\r?\n/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]:$/.test(s));
    if (drives.length > 0) return drives;
  } catch {
    /* fall through */
  }
  return [normalizeDrive(process.env.SystemDrive || 'C:')];
}

module.exports = { resolvePackagedContainer };
