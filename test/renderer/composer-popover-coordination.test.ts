import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const modulesRoot = path.join(__dirname, '../../src/renderer/modules');
const modelSource = fs.readFileSync(path.join(modulesRoot, 'composer-model-picker.js'), 'utf8');
const agentsSource = fs.readFileSync(path.join(modulesRoot, 'agents.js'), 'utf8');
const workspaceSource = fs.readFileSync(path.join(modulesRoot, 'user-workspace.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');

function extractFunction(source: string, name: string): string {
  const markers = [`function ${name}`, `async function ${name}`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (start === undefined) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function peerCloseResult(activeKind: 'model' | 'recipient' | 'workspace') {
  const helper = extractFunction(modelSource, '_closeOtherComposerPopovers');
  return vm.runInNewContext(`
    const closed = { model: 0, recipient: 0, workspace: 0 };
    function _closeComposerModelMenu() { closed.model += 1; }
    function _closeAgentPicker() { closed.recipient += 1; }
    const workspaceMenu = {
      _closeWorkspaceMenu() { closed.workspace += 1; },
      remove() { throw new Error('owned closer must be preferred'); },
    };
    const document = {
      getElementById(id) { return id === 'workspace-menu' ? workspaceMenu : null; },
    };
    ${helper}
    _closeOtherComposerPopovers(${JSON.stringify(activeKind)});
    closed;
  `);
}

function closeRecipientPicker(preserveAtKey: boolean) {
  const setOpen = extractFunction(agentsSource, '_setAgentPickerAnchorOpen');
  const closeStart = agentsSource.indexOf('function _closeAgentPicker');
  const closeEnd = agentsSource.indexOf('\nfunction _renderAgentPickerList', closeStart);
  const close = agentsSource.slice(closeStart, closeEnd);
  return vm.runInNewContext(`
    const classes = new Set();
    const attributes = {};
    const anchor = {
      classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      },
      setAttribute(name, value) { attributes[name] = value; },
    };
    const picker = { dataset: { anchorId: 'chat-recipient-chip' }, style: { display: 'flex' } };
    const document = {
      getElementById(id) {
        if (id === 'agent-picker') return picker;
        if (id === 'chat-recipient-chip') return anchor;
        return null;
      },
    };
    let _atKeyMark = { inputId: 'chat-input', posAfter: 1 };
    ${setOpen}
    ${close}
    _setAgentPickerAnchorOpen(anchor, true);
    const opened = { selected: classes.has('is-open'), expanded: attributes['aria-expanded'] };
    _closeAgentPicker({ preserveAtKey: ${JSON.stringify(preserveAtKey)} });
    ({
      opened,
      selected: classes.has('is-open'),
      expanded: attributes['aria-expanded'],
      display: picker.style.display,
      mark: _atKeyMark,
    });
  `);
}

describe('composer popover coordination', () => {
  it('closes recipient and workspace panels before opening the model panel', () => {
    expect(peerCloseResult('model')).toEqual({ model: 0, recipient: 1, workspace: 1 });
  });

  it('closes model and workspace panels before opening the recipient panel', () => {
    expect(peerCloseResult('recipient')).toEqual({ model: 1, recipient: 0, workspace: 1 });
  });

  it('closes model and recipient panels before opening the workspace panel', () => {
    expect(peerCloseResult('workspace')).toEqual({ model: 1, recipient: 1, workspace: 0 });
  });

  it('keeps the recipient anchor selected exactly while its picker is open', () => {
    expect(closeRecipientPicker(false)).toEqual({
      opened: { selected: true, expanded: 'true' },
      selected: false,
      expanded: 'false',
      display: 'none',
      mark: null,
    });
    expect(agentsSource).toContain('_setAgentPickerAnchorOpen(anchorBtn, true)');
    expect(styleSource).toMatch(/\.chat-recipient-chip\.is-open\s*\{/);
  });

  it('preserves a typed @ only for the selection path that consumes it next', () => {
    expect(closeRecipientPicker(true).mark).toEqual({ inputId: 'chat-input', posAfter: 1 });
    expect(agentsSource).toContain('_closeAgentPicker({ preserveAtKey: true })');
  });

  it('wires every picker opener into the same exclusivity boundary', () => {
    const modelOpen = modelSource.slice(
      modelSource.indexOf('async function _toggleComposerModelMenu'),
      modelSource.indexOf("document.addEventListener('DOMContentLoaded'"),
    );
    const agentOpen = agentsSource.slice(
      agentsSource.indexOf('async function _openAgentPicker'),
      agentsSource.indexOf('\nfunction _setAgentPickerAnchorOpen'),
    );
    const workspaceOpen = workspaceSource.slice(
      workspaceSource.indexOf('function _showWorkspaceDropdown'),
      workspaceSource.indexOf('\nfunction _createMenuItem'),
    );
    expect(modelOpen).toContain("_closeOtherComposerPopovers('model')");
    expect(agentOpen).toContain("_closeOtherComposerPopovers('recipient')");
    expect(workspaceOpen).toContain("_closeOtherComposerPopovers('workspace')");
  });
});
