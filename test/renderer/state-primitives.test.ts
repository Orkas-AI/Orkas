import { composerAccessorSource } from './composer-test-source';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/state.js'), 'utf8');

function extractFunction(name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

describe('shared Renderer state primitives', () => {
  it('ignores unsupported model destinations and rechecks the active account after lazy settings loading',async()=>{
    let release:any;const setView=vi.fn(),activate=vi.fn(),models=vi.fn(),load=vi.fn(()=>new Promise(resolve=>{release=resolve;}));
    const sandbox:any={currentUserId:'a',window:{loadRendererFeature:load,activateSettingsTab:activate},setView,_settingsActivateModelTab:models};vm.createContext(sandbox);vm.runInContext('async '+extractFunction('_openBuiltinModelSettings'),sandbox);
    for(const payload of [null,{user_id:'b',kind:'image'},{user_id:'a',kind:'chat'},{user_id:'a',kind:'image/../account'}])await sandbox._openBuiltinModelSettings(payload);
    expect(load).not.toHaveBeenCalled();const pending=sandbox._openBuiltinModelSettings({user_id:'a',kind:'image'});sandbox.currentUserId='b';release();await pending;expect(setView).not.toHaveBeenCalled();expect(activate).not.toHaveBeenCalled();expect(models).not.toHaveBeenCalled();
  });
  it('inserts a newline at the current selection for Ctrl/Cmd+Enter', () => {
    const dispatched = vi.fn();
    const sandbox: any = { Event };
    vm.createContext(sandbox);
  vm.runInContext(composerAccessorSource, sandbox);
    vm.runInContext([
      extractFunction('_insertComposerNewline'),
      extractFunction('_handleModifiedComposerEnter'),
    ].join('\n'), sandbox);
    const input = {
      value: 'abc',
      selectionStart: 1,
      selectionEnd: 2,
      dispatchEvent: dispatched,
    };
    const preventDefault = vi.fn();

    expect(sandbox._handleModifiedComposerEnter({
      key: 'Enter',
      ctrlKey: true,
      metaKey: false,
      currentTarget: input,
      preventDefault,
    })).toBe(true);
    expect(input.value).toBe('a\nc');
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(dispatched).toHaveBeenCalledOnce();
    expect(dispatched.mock.calls[0][0]).toMatchObject({ type: 'input', bubbles: true });
  });

  it('recognizes only unmodified Enter as the send gesture', () => {
    const sandbox: any = {};
    vm.createContext(sandbox);
  vm.runInContext(composerAccessorSource, sandbox);
    vm.runInContext(extractFunction('_isPlainComposerEnter'), sandbox);

    expect(sandbox._isPlainComposerEnter({
      key: 'Enter',
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    })).toBe(true);
    for (const modifier of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey']) {
      expect(sandbox._isPlainComposerEnter({
        key: 'Enter',
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        [modifier]: true,
      })).toBe(false);
    }
    expect(sandbox._isPlainComposerEnter({ key: 'a' })).toBe(false);
  });

  it('keeps group activity scoped to a non-empty conversation id', () => {
    const notifyBusy = vi.fn();
    const sandbox = { groupBusyConvs: new Map(), window: { VideoCanvas: { notifyBusy } } };
    vm.createContext(sandbox);
    const busyRevision = source.match(/^let _groupBusyRevision\s*=[^;\n]+;/m)?.[0];
    if (!busyRevision) throw new Error('Missing Renderer busy revision state');
    vm.runInContext([
      busyRevision,
      extractFunction('isGroupConversationBusy'),
      extractFunction('setGroupConversationBusy'),
    ].join('\n'), sandbox);

    vm.runInContext("setGroupConversationBusy('', true)", sandbox);
    expect(notifyBusy).not.toHaveBeenCalled();
    vm.runInContext("setGroupConversationBusy('conversation-a', true)", sandbox);
    expect(vm.runInContext('groupBusyConvs.size', sandbox)).toBe(1);
    expect(vm.runInContext("isGroupConversationBusy('conversation-a')", sandbox)).toBe(true);
    vm.runInContext("setGroupConversationBusy('conversation-a', false)", sandbox);
    expect(vm.runInContext("isGroupConversationBusy('conversation-a')", sandbox)).toBe(false);
    expect(notifyBusy.mock.calls).toEqual([['conversation-a', true], ['conversation-a', false]]);
  });
});
