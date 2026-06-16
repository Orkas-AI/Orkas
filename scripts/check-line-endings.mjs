#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const skipDirs = new Set([
  '.git',
  '.cache',
  'build',
  'data',
  'dist',
  'node_modules',
  'out',
  'venv',
  'workspace',
  'userWorkSpace',
]);
const textExts = new Set([
  '.cjs',
  '.conf',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.ts',
  '.tsx',
  '.txt',
  '.yml',
  '.yaml',
]);
const textNames = new Set([
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
]);

function isTextFile(name) {
  return textNames.has(name) || textExts.has(path.extname(name).toLowerCase());
}

function shouldSkipDir(name) {
  return skipDirs.has(name);
}

function shouldSkipPath(dir) {
  const rel = path.relative(root, dir).split(path.sep).join('/');
  return rel === 'PC/product/package';
}

function scanFile(file) {
  const bytes = fs.readFileSync(file);
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 10) continue;
    lf += 1;
    if (i > 0 && bytes[i - 1] === 13) crlf += 1;
  }
  if (lf === 0) return null;
  const bareLf = lf - crlf;
  if (crlf > 0 && bareLf > 0) {
    return { file, crlf, bareLf };
  }
  return null;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const next = path.join(dir, entry.name);
      if (!shouldSkipDir(entry.name) && !shouldSkipPath(next)) walk(next, out);
      continue;
    }
    if (!entry.isFile() || !isTextFile(entry.name)) continue;
    const result = scanFile(path.join(dir, entry.name));
    if (result) out.push(result);
  }
}

const mixed = [];
walk(root, mixed);

if (mixed.length) {
  console.error('Mixed line endings found:');
  for (const item of mixed) {
    console.error(`- ${path.relative(root, item.file)} (CRLF=${item.crlf}, LF=${item.bareLf})`);
  }
  process.exit(1);
}

console.log('No mixed line endings found.');
