#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  BUILTIN_MANIFEST_NAME,
  createBuiltinManifest,
} = require('../bin/builtin-resource-gate.cjs');

const pcRoot = path.resolve(__dirname, '..');
const builtinRoot = path.join(pcRoot, 'resources', 'builtin');
const manifestFile = path.join(builtinRoot, BUILTIN_MANIFEST_NAME);
const manifest = createBuiltinManifest(builtinRoot, { allowIgnoredJunk: true });
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, 'utf8') : '';
  if (current !== serialized) {
    console.error('[builtin-manifest] stale; run npm run builtin:manifest and commit resources/builtin/_manifest.json');
    process.exitCode = 1;
  } else {
    console.log(`[builtin-manifest] current: ${manifest.files.length} files ${manifest.content_tree_sha256}`);
  }
} else {
  fs.writeFileSync(manifestFile, serialized, 'utf8');
  console.log(`[builtin-manifest] wrote ${manifest.files.length} files ${manifest.content_tree_sha256}`);
}
