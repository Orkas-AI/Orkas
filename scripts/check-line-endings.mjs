#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const textExts = new Set([
  '.bat',
  '.cjs',
  '.cmd',
  '.conf',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.ps1',
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
const GIT_DISCOVERY_TIMEOUT_MS = 30_000;

export function isTextFile(name) {
  return textNames.has(name) || textExts.has(path.extname(name).toLowerCase());
}

export function classifyLineEndings(bytes) {
  let bareCr = 0;
  let bareLf = 0;
  let crlf = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 13) {
      if (bytes[index + 1] === 10) {
        crlf += 1;
        index += 1;
      } else {
        bareCr += 1;
      }
    } else if (bytes[index] === 10) {
      bareLf += 1;
    }
  }
  const styles = [bareCr, bareLf, crlf].filter((count) => count > 0).length;
  return {
    bareCr,
    bareLf,
    crlf,
    invalid: bareCr > 0 || styles > 1,
  };
}

export function listRepositoryTextFiles(root = defaultRoot, {
  fileSystem = fs,
  spawn = spawnSync,
} = {}) {
  const result = spawn(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_DISCOVERY_TIMEOUT_MS,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ls-files failed with exit ${result.status}`);
  }

  const entries = Buffer.from(result.stdout || Buffer.alloc(0))
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'en'));
  const prefix = `${path.resolve(root)}${path.sep}`;
  const files = [];
  for (const relative of entries) {
    if (!isTextFile(path.basename(relative))) continue;
    const file = path.resolve(root, relative);
    if (!file.startsWith(prefix)) continue;
    let stat;
    try {
      stat = fileSystem.lstatSync(file);
    } catch {
      continue;
    }
    // Do not follow a repository symlink into a user or system path.
    if (stat.isFile()) files.push(file);
  }
  return files;
}

export function scanLineEndingFile(file, { fileSystem = fs } = {}) {
  const result = classifyLineEndings(fileSystem.readFileSync(file));
  return result.invalid ? { file, ...result } : null;
}

function diagnosticPath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

export function checkRepositoryLineEndings({
  fileSystem = fs,
  print = console.log,
  printError = console.error,
  root = defaultRoot,
  spawn = spawnSync,
} = {}) {
  let files;
  try {
    files = listRepositoryTextFiles(root, { fileSystem, spawn });
  } catch (err) {
    printError(`Line-ending file discovery failed: ${err.message}`);
    return { code: 2, files: 0, invalid: [] };
  }

  const invalid = [];
  for (const file of files) {
    const result = scanLineEndingFile(file, { fileSystem });
    if (result) invalid.push(result);
  }
  if (invalid.length) {
    printError('Invalid or mixed line endings found:');
    for (const item of invalid) {
      printError(
        `- ${diagnosticPath(root, item.file)} `
        + `(CRLF=${item.crlf}, LF=${item.bareLf}, bare-CR=${item.bareCr})`,
      );
    }
    return { code: 1, files: files.length, invalid };
  }

  print(`Line endings valid in ${files.length} repository text files.`);
  return { code: 0, files: files.length, invalid };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = checkRepositoryLineEndings().code;
}
