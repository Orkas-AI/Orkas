#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const pcRoot = path.resolve(__dirname, '..');
const builtinRoot = path.join(pcRoot, 'resources', 'builtin');
const stagedCheck = process.argv.includes('--check-staged');
if (process.argv.includes('--staged') || stagedCheck) {
  const repository = pcRoot, relative = 'resources/builtin/';
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-builtin-index-'));
  const git = (args, input) => execFileSync('git', args, { cwd: repository, input, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    // Validator code and its avatar data must come from the same index as the
    // resources. A concurrent working validator may require an unpublished app.
    const files = git(['ls-files', '-z', '--', relative,
      'bin/builtin-resource-gate.cjs', 'src/main/data/avatars.json']);
    // Materialize only index entries; never move, stage or overwrite concurrent
    // working-tree files. This is a temporary data snapshot, not a Git worktree.
    git(['checkout-index', `--prefix=${temporary.replace(/\\/g, '/')}/`, '--stdin', '-z'], files);
    const { BUILTIN_MANIFEST_NAME, createBuiltinManifest } = require(path.join(temporary, 'bin/builtin-resource-gate.cjs'));
    const stagedRoot = path.join(temporary, relative);
    const serialized = `${JSON.stringify(createBuiltinManifest(stagedRoot, { allowIgnoredJunk: !stagedCheck, allowDevelopmentFiles: true }), null, 2)}\n`;
    if (stagedCheck || process.argv.includes('--check')) {
      const current = git(['show', `:${relative}${BUILTIN_MANIFEST_NAME}`]).toString('utf8');
      if (current !== serialized) throw new Error('stale staged manifest');
      console.log('[builtin-manifest] staged snapshot verified');
    } else {
      const oid = git(['hash-object', '-w', '--stdin'], serialized).toString('utf8').trim();
      git(['update-index', '--cacheinfo', `100644,${oid},${relative}${BUILTIN_MANIFEST_NAME}`]);
      console.log('[builtin-manifest] staged snapshot refreshed');
    }
  } catch {
    console.error('[builtin-manifest] staged snapshot validation failed; check staged source and manifest');
    process.exitCode = 1;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
} else {
  const { BUILTIN_MANIFEST_NAME, createBuiltinManifest } = require('../bin/builtin-resource-gate.cjs');
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
}
