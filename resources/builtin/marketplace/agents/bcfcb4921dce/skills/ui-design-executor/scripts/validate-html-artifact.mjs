#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const rootArg = process.argv[2];
if (!rootArg) {
  console.error('Usage: validate-html-artifact.mjs <artifact-directory>');
  process.exit(2);
}

const root = path.resolve(rootArg);
const errors = [];
const warnings = [];
const checks = {};

function fail(check, message) {
  checks[check] = false;
  errors.push(`${check}: ${message}`);
}

function pass(check) {
  if (checks[check] !== false) checks[check] = true;
}

function warn(check, message) {
  warnings.push(`${check}: ${message}`);
}

function filesBelow(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name.endsWith('.zip')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesBelow(abs, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function isSafeRelative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) return false;
  const parts = value.replaceAll('\\', '/').split('/');
  return !parts.includes('..') && !parts.includes('');
}

function countTags(html, tag, closing = false) {
  const slash = closing ? '\\/' : '';
  return [...html.matchAll(new RegExp(`<${slash}${tag}\\b`, 'gi'))].length;
}

function checkHtml(entryPath, html) {
  if (!/^\s*<!doctype\s+html\b/i.test(html)) fail('html-doctype', 'missing HTML doctype');
  else pass('html-doctype');

  for (const tag of ['html', 'head', 'body', 'script', 'style']) {
    const opens = countTags(html, tag);
    const closes = countTags(html, tag, true);
    if (opens !== closes) fail('html-critical-tags', `<${tag}> count ${opens} does not match closing count ${closes}`);
  }
  pass('html-critical-tags');

  const staticText = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (staticText.length < 24) fail('html-static-shell', 'less than 24 characters of meaningful static first-render text');
  else pass('html-static-shell');

  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let scriptIndex = 0;
  for (const match of html.matchAll(scriptRe)) {
    const attrs = match[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    scriptIndex += 1;
    if (/\btype\s*=\s*["']module["']/i.test(attrs)) {
      warn('inline-script-syntax', `inline module script ${scriptIndex} needs a module-aware runtime check`);
      continue;
    }
    try {
      new vm.Script(match[2], { filename: `${entryPath}#inline-${scriptIndex}` });
    } catch (error) {
      fail('inline-script-syntax', error instanceof Error ? error.message : String(error));
    }
  }
  pass('inline-script-syntax');

  const generatedHandler = /(?:innerHTML|insertAdjacentHTML)\s*(?:=|\()[\s\S]{0,1200}\bon(?:click|change|input|submit)\s*=/i;
  if (generatedHandler.test(html)) fail('runtime-event-wiring', 'generated markup contains an inline event handler');
  else pass('runtime-event-wiring');

  const localRefs = new Set();
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    localRefs.add(match[1].trim());
  }
  for (const match of html.matchAll(/\burl\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    localRefs.add(match[1].trim());
  }
  for (const ref of localRefs) {
    if (!ref || ref.startsWith('#') || ref.startsWith('data:') || ref.startsWith('blob:')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) continue;
    const localPath = ref.split(/[?#]/, 1)[0];
    if (!isSafeRelative(localPath)) {
      fail('local-references', `unsafe or root-relative reference: ${localPath}`);
      continue;
    }
    const resolved = path.resolve(path.dirname(entryPath), localPath);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      fail('local-references', `reference escapes artifact directory: ${localPath}`);
    } else if (!fs.existsSync(resolved)) {
      fail('local-references', `missing local reference: ${localPath}`);
    }
  }
  pass('local-references');
}

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  fail('artifact-directory', `not a directory: ${root}`);
} else {
  pass('artifact-directory');
}

let manifest = null;
const manifestPath = path.join(root, 'artifact.json');
if (!fs.existsSync(manifestPath)) {
  fail('manifest-json', 'artifact.json is missing');
} else {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    pass('manifest-json');
  } catch (error) {
    fail('manifest-json', error instanceof Error ? error.message : String(error));
  }
}

if (manifest) {
  const contractValid =
    manifest.schema_version === 1 &&
    typeof manifest.artifact_id === 'string' &&
    /^[a-z0-9][a-z0-9._-]*$/i.test(manifest.artifact_id) &&
    typeof manifest.format === 'string' && manifest.format.length > 0 &&
    Number.isInteger(manifest.revision) && manifest.revision >= 1;
  if (!contractValid) {
    fail('manifest-contract', 'schema_version=1, a stable artifact_id, format, and positive integer revision are required');
  } else {
    pass('manifest-contract');
  }

  if (!isSafeRelative(manifest.entry)) fail('manifest-entry', 'entry must be a safe relative path');
  else if (!fs.existsSync(path.join(root, manifest.entry))) fail('manifest-entry', `entry does not exist: ${manifest.entry}`);
  else pass('manifest-entry');

  const listed = Array.isArray(manifest.files) ? manifest.files : [];
  if (!listed.length || listed.some((item) => !isSafeRelative(item))) {
    fail('manifest-files', 'files must be a non-empty list of safe relative paths');
  } else {
    const sortedListed = [...listed].sort();
    const actual = filesBelow(root);
    if (JSON.stringify(listed) !== JSON.stringify(sortedListed)) fail('manifest-files', 'files must be sorted');
    if (!listed.includes('artifact.json')) fail('manifest-files', 'files must include artifact.json');
    if (JSON.stringify(sortedListed) !== JSON.stringify(actual)) {
      fail('manifest-files', `inventory mismatch; listed=${JSON.stringify(sortedListed)} actual=${JSON.stringify(actual)}`);
    }
    pass('manifest-files');
  }

  if (typeof manifest.entry === 'string' && manifest.entry.toLowerCase().endsWith('.html')) {
    const entryPath = path.join(root, manifest.entry);
    if (fs.existsSync(entryPath)) checkHtml(entryPath, fs.readFileSync(entryPath, 'utf8'));
  }
}

const result = {
  ok: errors.length === 0,
  root,
  checks,
  errors,
  warnings,
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;
