// Test-only module boundary observation, installed before the normal app boot.
// Keep Electron's package entry, paths and boot sequence unchanged.
const Module = require('node:module');
const path = require('node:path');
const target = path.resolve(__dirname, '../../../src/main/features/html_preview.ts');
const load = Module._load;
let installing = false;
Module._load = function (request, parent, isMain) {
  const result = load.apply(this, arguments);
  if (!installing && !globalThis.__previewRecovery
      && /(?:^|[/\\])html_preview(?:\.ts)?$/.test(request)
      && Module._resolveFilename(request, parent) === target) {
    installing = true;
    try {
      globalThis.__previewRecovery = require('./preview-recovery-main.ts').observePreviewRecovery();
    } finally {
      installing = false;
    }
    return require.cache[target].exports;
  }
  return result;
};
