import { composerAccessorSource } from './composer-test-source';
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { performance } from 'node:perf_hooks';

const autoSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/auto.js'),
  'utf8',
);
function createHarness(
  invokeImpl: (channel: string, payload?: unknown) => Promise<unknown>,
  refreshImpl: () => Promise<void> = async () => {},
): { context: vm.Context } {
  const elements: Record<string, Record<string, unknown>> = {
    'auto-submit-btn': { disabled: false },
    'auto-task-input': { value: 'Run the daily summary' },
    'auto-title-input': { value: 'Daily summary' },
    'auto-enabled-input': { checked: true },
    'auto-date-input': { value: '2026-08-06' },
    'auto-hourly-interval-input': { value: '6' },
    'auto-end-date-input': { value: '2026-12-31' },
    'auto-end-count-input': { value: '4' },
  };
  const document = {
    readyState: 'loading',
    addEventListener: vi.fn(),
    getElementById: vi.fn((id: string) => elements[id] || null),
  };
  const window = {
    orkas: { invoke: vi.fn(invokeImpl) },
    addEventListener: vi.fn(),
  } as Record<string, unknown>;
  const context = vm.createContext({
    window,
    document,
    performance,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    t: (key: string) => key,
    uiAlert: vi.fn(async () => {}),
    Promise,
    Date,
    Math,
    Set,
    Array,
    String,
    Number,
    Object,
    RegExp,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(composerAccessorSource, context);
  vm.runInContext(autoSource, context, { filename: 'auto.js' });
  context.__refreshImpl = refreshImpl;
  vm.runInContext(`
    _autoFreqSel = { getValue: () => 'daily' };
    _autoEndSel = { getValue: () => 'none' };
    _autoHourSel = { getValue: () => '9' };
    _autoMinuteSel = { getValue: () => '30' };
    _autoWeekdaySel = { getValue: () => '1' };
    _autoMonthlyDaySel = { getValue: () => '1' };
    _autoCurrentRecipient = { kind: 'commander' };
    _autoCurrentAttachments = [];
    _autoEditingTaskId = null;
    _autoCurrentTaskId = '';
    _autoOnSaved = null;
    _hideAutoDialog = () => {};
    _autoResetForm = () => {};
    loadAutoList = (...args) => __refreshImpl(...args);
  `, context);
  return { context };
}

describe('Automation create IPC contract', () => {
  it('retains the first position after a repeated attachment finishes before its original upload', async () => {
    const invoke = vi.fn(async () => ({ task: { id: 'at_order' } }));
    const { context } = createHarness(invoke);
    vm.runInContext(`
      _autoCurrentTaskId = 'at_order';
      _autoSetAttachmentItems([
        { tempId: 'first', name: 'z-first.txt', status: 'uploading' },
        { tempId: 'middle', name: 'a-middle.txt', status: 'ready' },
        { tempId: 'last', name: 'duplicate.txt', status: 'uploading' },
      ]);
      _autoReplaceAttachmentByTempId('last', { name: 'z-first.txt', status: 'ready' });
      _autoReplaceAttachmentByTempId('first', { name: 'z-first.txt', status: 'ready' });
    `, context);
    await context._autoSubmitForm();
    expect(invoke).toHaveBeenCalledWith('autoTasks.create', expect.objectContaining({ attachments: ['z-first.txt', 'a-middle.txt'] }));
  });

  it('appends new selections after an existing automation attachment list', async () => {
    const invoke = vi.fn(async (channel: string, input: any) => channel.endsWith('upload')
      ? { name: input.name } : { task: { id: 'at_order' } });
    const { context } = createHarness(invoke);
    context._arrayBufferToBase64 = () => 'YQ==';
    vm.runInContext(`
      _autoCurrentTaskId = 'at_order';
      _autoEditingTaskId = 'at_order';
      _autoCurrentAttachments = ['z-old.txt', 'a-old.txt'].map(name => ({ name, status: 'ready' }));
    `, context);
    await context._autoUploadFiles([{ name: 'm-new.txt', size: 1, arrayBuffer: async () => new Uint8Array([2]).buffer }], 'paste');
    await context._autoSubmitForm();
    expect(invoke).toHaveBeenCalledWith('autoTasks.update', expect.objectContaining({
      updates: expect.objectContaining({ attachments: ['z-old.txt', 'a-old.txt', 'm-new.txt'] }),
    }));
  });

  it('saves consecutive additions in user order despite reversed file-read completion', async () => {
    const invoke = vi.fn(async (channel: string, input: any) => channel.endsWith('upload')
      ? { name: input.name } : { task: { id: 'at_order' } });
    const { context } = createHarness(invoke);
    context._arrayBufferToBase64 = () => 'YQ==';
    vm.runInContext("_autoCurrentTaskId = 'at_order'", context);
    let release!: () => void;
    const first = { name: 'z-first.txt', size: 1, arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => {
      release = () => resolve(new Uint8Array([1]).buffer);
    }) };
    const pending = context._autoUploadFiles([first], 'paste');
    await Promise.resolve();
    await context._autoUploadFiles([{ name: 'a-second.txt', size: 1, arrayBuffer: async () => new Uint8Array([2]).buffer }], 'paste');
    release();
    await pending;
    expect(vm.runInContext('_autoCurrentAttachments.map(item => item.name)', context)).toEqual(['z-first.txt', 'a-second.txt']);
    await context._autoSubmitForm();
    expect(invoke).toHaveBeenCalledWith('autoTasks.create', expect.objectContaining({ attachments: ['z-first.txt', 'a-second.txt'] }));
  });


  it('submits hourly cadence and a scheduled-run cutoff through the canonical create IPC', async () => {
    const invoke = vi.fn(async () => ({ task: { id: 'at_hourly' } }));
    const harness = createHarness(invoke);
    vm.runInContext(`
      _autoFreqSel = { getValue: () => 'hourly' };
      _autoEndSel = { getValue: () => 'count' };
    `, harness.context);

    await vm.runInContext('_autoSubmitForm()', harness.context);

    expect(invoke).toHaveBeenCalledWith('autoTasks.create', expect.objectContaining({
      schedule: { type: 'hourly', interval_hours: 6 },
      end_condition: { type: 'count', max_runs: 4 },
    }));
  });

});
