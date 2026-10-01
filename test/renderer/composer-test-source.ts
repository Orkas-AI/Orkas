import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const source = readFileSync(path.join(__dirname, '../../src/renderer/modules/composer-input.js'), 'utf8');
const parsed = ts.createSourceFile('composer-input.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
// Exercise the actual boundary API with the small native-input doubles used by
// existing routing/draft tests. Editor transactions and DOM have separate owning
// model/Electron cases; no reimplementation of the accessor behavior lives here.
const names = new Set(['_composerElement', '_composerApi', 'composerText', 'composerSetText',
  'composerHasText', 'composerIncludes', 'composerSelection', 'composerSetSelection', 'composerChangeEvent', 'composerNotify',
  'composerSnapshot', 'composerBindOwner', 'composerSetDisabled', 'composerPlaceholder', 'composerSetPlaceholder']);
export const composerAccessorSource = 'var _composerNavigationEpoch; _composerNavigationEpoch ??= 0;\n' + parsed.statements.filter(node =>
  ts.isFunctionDeclaration(node) && names.has(node.name?.text || '')).map(node => node.getText(parsed)).join('\n');

// Send ownership tests include the real persistence boundary: a visible edit
// registers its immutable snapshot before navigation reuses the shared input.
export const composerDraftSource = readFileSync(path.join(__dirname, '../../src/renderer/modules/queue-draft.js'), 'utf8');
