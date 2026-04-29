// Electron entry shim: register tsx so the main process can
// `require('./src/main')` and resolve to src/main/index.ts (Node folder →
// index.ts rule + tsx/cjs transpilation). Keeps __dirname semantics identical
// to running plain JS — no compile step in dev.
//
// 两件事必须在 tsx 注册前完成:
//   1. Hooks:`tsx/cjs` 处理 src/main/**/*.ts 的同步 require;`tsx/esm/api`
//      处理动态 `import()`(尤其 `import('#core-agent')`)。
//   2. **packaged 模式 WS_ROOT env 重定向**:必须在任何 TS 加载前完成 ——
//      TypeScript 把 `import * as paths from './paths'` 提升到所有非 import
//      语句之前,index.ts 内"先 set env 再 import paths"的写法在编译后会被
//      打乱顺序,paths.ts 在 env 还没设置时就快照了空值,WS_ROOT 落到
//      .app 包内。CJS 的 require 没有提升问题,所以这层必须在 .cjs 里做。
'use strict';

(function pinPackagedWorkspaceRoot() {
  const { app } = require('electron');
  if (!app.isPackaged || process.env.ORKAS_WORKSPACE_ROOT) return;
  const path = require('path');
  const fs = require('fs');
  const { resolvePackagedContainer } = require('./src/main/packaged-data-root.cjs');
  const ws = path.join(resolvePackagedContainer(), 'data');
  fs.mkdirSync(ws, { recursive: true });
  process.env.ORKAS_WORKSPACE_ROOT = ws;
})();

require('tsx/cjs');
require('tsx/esm/api').register();

require('./src/main');
