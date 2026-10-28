const { readdirSync, openSync, readSync, closeSync } = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
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
      let descriptor;
      try {
        const header = `\n===== ${path.relative(root, fullPath)} =====\n`;
        const available = MAX_LOG_BYTES - totalBytes - Buffer.byteLength(header);
        if (available <= 0) return;
        descriptor = openSync(fullPath, 'r');
        const buffer = Buffer.alloc(available);
        let length = 0;
        while (length < available) {
          const read = readSync(descriptor, buffer, length, available - length, null);
          if (!read) break;
          length += read;
        }
        // Keep complete UTF-8 characters. Invalid source bytes can expand to
        // replacement characters, so bound the encoded output as well.
        const body = new StringDecoder('utf8').write(buffer.subarray(0, length));
        const encoded = Buffer.from(body, 'utf8');
        const slice = new StringDecoder('utf8').write(encoded.subarray(0, available));
        const chunk = header + slice;
        chunks.push(chunk);
        totalBytes += Buffer.byteLength(chunk);
      } catch {
        // A log may be rotated while Electron is shutting down.
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
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
