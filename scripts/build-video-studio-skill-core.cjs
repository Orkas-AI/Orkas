#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const pcDir = path.resolve(__dirname, '..');
const agentSkillsDir = path.join(
  pcDir,
  'resources',
  'builtin',
  'marketplace',
  'agents',
  '79df9cc89f5f',
  'skills',
);
const scriptCoreSrcDir = path.join(agentSkillsDir, '_shared', 'scripts', 'src');
const loggerShim = path.join(scriptCoreSrcDir, 'logger-shim.ts');

const outputs = [
  {
    entry: path.join(scriptCoreSrcDir, 'video_edit.ts'),
    outfile: path.join(agentSkillsDir, 'stage-edit', 'scripts', 'lib', 'video_edit_core.cjs'),
  },
  {
    entry: path.join(scriptCoreSrcDir, 'video_analyze.ts'),
    outfile: path.join(agentSkillsDir, 'stage-edit', 'scripts', 'lib', 'video_analyze_core.cjs'),
  },
  {
    entry: path.join(scriptCoreSrcDir, 'video_edl.ts'),
    outfile: path.join(agentSkillsDir, 'stage-plan', 'scripts', 'lib', 'video_edl_core.cjs'),
  },
  {
    entry: path.join(scriptCoreSrcDir, 'video_decide.ts'),
    outfile: path.join(agentSkillsDir, 'stage-plan', 'scripts', 'lib', 'video_decide_core.cjs'),
  },
  {
    entry: path.join(scriptCoreSrcDir, 'video_render.ts'),
    outfile: path.join(agentSkillsDir, 'stage-compose', 'scripts', 'lib', 'video_render_core.cjs'),
  },
];

const aliasMainLogger = {
  name: 'alias-main-logger-for-video-scripts',
  setup(build) {
    build.onResolve({ filter: /^(?:\.\.\/)+logger(?:\.js)?$/ }, () => ({ path: loggerShim }));
  },
};

const bannedRuntimeDeps = [
  'src/main/features',
  'src/main/util/uniquify',
  'electron-log',
  'node_modules/electron',
  'require("electron")',
  "require('electron')",
];

async function buildOne(item) {
  fs.mkdirSync(path.dirname(item.outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [item.entry],
    outfile: item.outfile,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    legalComments: 'none',
    minifyWhitespace: true,
    sourcemap: false,
    plugins: [aliasMainLogger],
    logLevel: 'silent',
  });

  const text = fs.readFileSync(item.outfile, 'utf8');
  const banned = bannedRuntimeDeps.find((needle) => text.includes(needle));
  if (banned) {
    throw new Error(`${path.relative(pcDir, item.outfile)} still contains forbidden runtime dependency: ${banned}`);
  }
}

(async () => {
  for (const item of outputs) {
    await buildOne(item);
    console.log(`built ${path.relative(pcDir, item.outfile)}`);
  }
})().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
