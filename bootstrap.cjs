// Electron entry shim: register tsx so the main process can
// `require('./src/main')` and resolve to src/main/index.ts (Node folder →
// index.ts rule + tsx/cjs transpilation). Keeps __dirname semantics identical
// to running plain JS — no compile step.
//
// 两件事必须在 tsx 注册前完成:
//   1. **WS_ROOT env 注入**:require('./src/main/install-data-root.cjs') 的
//      模块加载副作用解析容器目录、跑一次性 source-run → container 迁移、
//      mkdir、写入 process.env.ORKAS_WORKSPACE_ROOT。**必须在 tsx 加载任何
//      .ts 前完成** —— paths.ts 把 ORKAS_WORKSPACE_ROOT 在 import 时
//      snapshot 成 WS_ROOT,任何先加载 paths.ts 的路径都会读到空。CJS require
//      没有 hoist 问题,这层在 .cjs 里做最稳。
//   2. Hooks:`tsx/cjs` 处理 src/main/**/*.ts 的同步 require;`tsx/esm/api`
//      处理动态 `import()`(尤其 `import('#core-agent')`)。
//
// dev (源码运行) 和 packaged 走同一条路径 —— 无 isPackaged 分叉,容器解析、
// 迁移、env 注入对两种入口形态行为完全一致。
'use strict';

require('./src/main/install-data-root.cjs');
const fs = require('node:fs');
const path = require('node:path');

function configurePackagedEsbuildBinary() {
  if (!process.versions.electron || !process.resourcesPath || process.env.ESBUILD_BINARY_PATH) {
    return;
  }

  const platformPackages = {
    'darwin:arm64': ['@esbuild', 'darwin-arm64', 'bin', 'esbuild'],
    'darwin:x64': ['@esbuild', 'darwin-x64', 'bin', 'esbuild'],
    'linux:arm64': ['@esbuild', 'linux-arm64', 'bin', 'esbuild'],
    'linux:x64': ['@esbuild', 'linux-x64', 'bin', 'esbuild'],
    'win32:arm64': ['@esbuild', 'win32-arm64', 'esbuild.exe'],
    'win32:ia32': ['@esbuild', 'win32-ia32', 'esbuild.exe'],
    'win32:x64': ['@esbuild', 'win32-x64', 'esbuild.exe'],
  };
  const parts = platformPackages[`${process.platform}:${process.arch}`];
  if (!parts) return;

  const bin = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    ...parts,
  );
  if (fs.existsSync(bin)) {
    process.env.ESBUILD_BINARY_PATH = bin;
  }
}

configurePackagedEsbuildBinary();

require('tsx/cjs');
require('tsx/esm/api').register();

require('./src/main');
