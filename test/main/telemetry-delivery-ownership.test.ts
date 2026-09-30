import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { createRendererChannel } from '../../src/main/util/renderer-channel';
import { describe, expect, it } from 'vitest';

const mainSource = fs.readFileSync(path.join(__dirname, '../../src/main/index.ts'), 'utf8');

function functionSource(name: string): string {
  const start = mainSource.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = mainSource.indexOf('\nfunction ', start + 1);
  return mainSource.slice(start, next < 0 ? mainSource.length : next);
}

describe('Main task-terminal UI delivery', () => {
  it('delivers task terminals through subframe loads and replays them after a main-document reload', () => {
    const delivered: unknown[] = [];
    const webContents = new EventEmitter();
    const win = Object.assign(new EventEmitter(), { webContents });
    const context = vm.createContext({
      createRendererChannel,
      users: { hasActiveUser: () => true, getActiveUserId: () => 'owner-a' },
      ipc: { broadcastToRenderer: (channel: string, payload: unknown) => { delivered.push({ channel, payload }); return true; } },
      win,
    });
    const lifecycleStart = mainSource.indexOf('  win.webContents.on(', mainSource.indexOf('  win.loadFile('));
    const lifecycleEnd = mainSource.indexOf('\n  // Block HTML', lifecycleStart);
    expect(lifecycleStart).toBeGreaterThan(0);
    expect(lifecycleEnd).toBeGreaterThan(lifecycleStart);
    const source = [
      'let mainRendererReady = false;',
      mainSource.slice(mainSource.indexOf('const rendererChannels:'), mainSource.indexOf('function emitTaskTerminalToRenderer(')),
      mainSource.slice(lifecycleStart, lifecycleEnd),
    ].join('\n');
    vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    const terminal = (id: string) => vm.runInContext(
      `taskTerminalUi.emit({ conversation_id: '${id}', status: 'completed' }, 'owner-a')`, context,
    );
    webContents.emit('did-finish-load');
    // An iframe finishes without reloading the main document. Neither that
    // load nor an in-page navigation may silence later background replies.
    webContents.emit('did-start-loading');
    webContents.emit('did-start-navigation', {}, 'about:srcdoc', false, false);
    webContents.emit('did-frame-finish-load', {}, false);
    webContents.emit('did-stop-loading');
    terminal('after-preview');
    webContents.emit('did-start-navigation', {}, 'file:///index.html#task', true, true);
    terminal('after-anchor');
    expect(delivered).toEqual([
      { channel: 'conversation:task_terminal', payload: { conversation_id: 'after-preview', status: 'completed' } },
      { channel: 'conversation:task_terminal', payload: { conversation_id: 'after-anchor', status: 'completed' } },
    ]);

    webContents.emit('did-start-navigation', {}, 'file:///index.html', false, true);
    webContents.emit('did-start-loading');
    terminal('during-reload');
    expect(delivered).toHaveLength(2);
    webContents.emit('did-finish-load');
    expect(delivered).toHaveLength(3);
    expect(delivered[2]).toEqual({
      channel: 'conversation:task_terminal', payload: { conversation_id: 'during-reload', status: 'completed' },
    });
  });

  it('keeps the content-free terminal UI projection on its local user-owned channel', () => {
    const emit = functionSource('emitTaskTerminalToRenderer');
    expect(emit).toContain('const { user_id: ownerUserId, ...terminal } = event;');
    expect(emit).toContain("taskTerminalUi.emit({ type: 'terminal', ...terminal }, ownerUserId)");
    expect(mainSource).toContain(
      'const stopTaskTerminalUi = subscribeTaskTerminals(emitTaskTerminalToRenderer);',
    );
  });
});
