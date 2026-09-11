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
