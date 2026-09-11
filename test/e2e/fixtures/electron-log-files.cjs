const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function collectLogFiles(root) {
  const chunks = [];
  let totalBytes = 0;

  const visit = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (totalBytes >= MAX_LOG_BYTES) return;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
      try {
        const body = readFileSync(fullPath, 'utf8');
        const available = MAX_LOG_BYTES - totalBytes;
        const slice = body.slice(0, available);
        chunks.push(`\n===== ${path.relative(root, fullPath)} =====\n${slice}`);
        totalBytes += Buffer.byteLength(slice);
      } catch {
        // A log may be rotated while Electron is shutting down.
      }
    }
  };

  // Chromium LevelDB uses binary .log files outside these diagnostic roots.
  // Scanning the whole workspace can consume the budget before app logs.
  visit(path.join(root, 'workspace', 'logs'));
  visit(path.join(root, 'electron-user-data', 'logs'));
  return chunks.join('');
}

module.exports = { collectLogFiles };
