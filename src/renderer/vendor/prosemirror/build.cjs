// Offline browser artifact only; this does not bundle the application renderer.
// Run npm ci --ignore-scripts in this directory, then node build.cjs.
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('../../../../node_modules/esbuild');
// prosemirror-view 1.42.5 treats a selection at document start within 200ms
// of focus as a browser reset. Home immediately after closing our picker is a
// real keyboard selection, and must not be restored to the pre-Home position.
// Keep the upstream recovery only until the first post-focus key event. Fail
// the build if the pinned upstream implementation changes, rather than silently
// carrying an ineffective patch into an upgrade.
const viewSource = fs.readFileSync(path.join(__dirname, 'node_modules/prosemirror-view/dist/index.js'), 'utf8');
const focusGuard = 'if (from < 0 && newSel && view.input.lastFocus > Date.now() - 200 &&';
if (viewSource.split(focusGuard).length !== 2) throw new Error('Review ProseMirror focus recovery patch');
const patchedView = path.join(__dirname, '.view-focus-build.js');
fs.writeFileSync(patchedView, viewSource.replace(focusGuard,
  focusGuard + '\n            view.input.lastKeyCodeTime < view.input.lastFocus &&'));
try {
  buildSync({ entryPoints: [path.join(__dirname, 'entry.js')], bundle: true,
    alias: { 'prosemirror-view': patchedView },
    format: 'iife', globalName: 'OrkasEditor', platform: 'browser', target: 'chrome140',
    minify: true, legalComments: 'eof', outfile: path.join(__dirname, 'prosemirror.min.js') });
} finally { fs.unlinkSync(patchedView); }
const lock = require('./package-lock.json');
let licenses = '';
for (const name of Object.keys(lock.packages).filter(name => name.startsWith('node_modules/')).sort()) {
  const root = path.join(__dirname, name);
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  licenses += `\n=== ${meta.name}@${meta.version} (${meta.license}) ===\n`;
  const file = fs.readdirSync(root).find(name => /^license(?:\.\w+)?$/i.test(name));
  if (!file) throw new Error(`Missing license: ${meta.name}`);
  licenses += fs.readFileSync(path.join(root, file), 'utf8') + '\n';
}
fs.writeFileSync(path.join(__dirname, 'LICENSES.txt'), licenses.trim() + '\n');
