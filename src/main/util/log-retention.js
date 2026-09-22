"use strict";
const fs = require('node:fs');
const path = require('node:path');
function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
// Synchronous by design: production calls this only in the log worker.
function sweepLogDirectory(directory, retainDays, totalMaxBytes, now = new Date()) {
  const today = dateKey(now);
  const cutoff = now.getTime() - retainDays * 86400000;
  const files = [], removed = [], reason = {};
  let names;
  try { names = fs.readdirSync(directory); } catch (_) { return { removed, reason }; }
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}.*\.log$/.test(name)) continue;
    const full = path.join(directory, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      if (name.slice(0, 10) < today && new Date(`${name.slice(0, 10)}T00:00:00`).getTime() < cutoff) {
        try { fs.unlinkSync(full); removed.push(name); reason[name] = 'age'; continue; } catch (_) {}
      }
      files.push({ name, full, size: stat.size, mtime: stat.mtimeMs });
    } catch (_) { /* A locked file can be retried at the next boot. */ }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0);
  files.sort((a, b) => a.name.slice(0, 10).localeCompare(b.name.slice(0, 10)) || a.mtime - b.mtime);
  for (const file of files) {
    if (total <= totalMaxBytes) break;
    if (file.name === `${today}.log`) continue;
    try { fs.unlinkSync(file.full); total -= file.size; removed.push(file.name); reason[file.name] = 'size'; } catch (_) {}
  }
  return { removed, reason };
}
module.exports = { dateKey, sweepLogDirectory };
