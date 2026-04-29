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
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[codesign-adhoc] signing ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  // 校验签名(失败时直接 throw 中断 build,避免发出未签的包)
  execSync(`codesign --verify --deep "${appPath}"`, { stdio: 'inherit' });
};
