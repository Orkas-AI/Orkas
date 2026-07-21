import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const auto = require('../../src/renderer/modules/auto.js') as {
  _autoDisplayDeviceName: (name: string) => string;
  _autoIsTaskOnCurrentDevice: (task: { device_id?: string }, device: { id: string }) => boolean;
  _autoCanTransferTaskToCurrentDevice: (task: { device_id?: string }, device: { id: string } | null) => boolean;
  _autoRunDeviceOptions: (
    task: { device_id?: string; device_name?: string },
    device: { id: string },
    translate: (key: string) => string,
  ) => Array<{ value: string; label: string }>;
};

const rendererRoot = path.resolve(__dirname, '../../src/renderer');

describe('auto device display name', () => {
  it('strips the mDNS .local suffix from hostnames', () => {
    expect(auto._autoDisplayDeviceName('claw2deMac-mini.local')).toBe('claw2deMac-mini');
    expect(auto._autoDisplayDeviceName('Desk.LOCAL.')).toBe('Desk');
  });

  it('leaves non-mDNS identifiers unchanged', () => {
    expect(auto._autoDisplayDeviceName('aa:bb:cc:dd:ee:ff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(auto._autoDisplayDeviceName('workstation.localdomain')).toBe('workstation.localdomain');
  });

  it('offers a transfer only for tasks assigned to another device', () => {
    const current = { id: 'aa:bb:cc:dd:ee:ff' };
    expect(auto._autoIsTaskOnCurrentDevice({ device_id: current.id }, current)).toBe(true);
    expect(auto._autoCanTransferTaskToCurrentDevice({ device_id: current.id }, current)).toBe(false);
    expect(auto._autoCanTransferTaskToCurrentDevice({ device_id: '11:22:33:44:55:66' }, current)).toBe(true);
  });

  it('keeps legacy unstamped tasks local and hides transfer without device context', () => {
    const current = { id: 'aa:bb:cc:dd:ee:ff' };
    expect(auto._autoIsTaskOnCurrentDevice({}, current)).toBe(true);
    expect(auto._autoCanTransferTaskToCurrentDevice({}, current)).toBe(false);
    expect(auto._autoCanTransferTaskToCurrentDevice({ device_id: '11:22:33:44:55:66' }, null)).toBe(false);
    expect(auto._autoCanTransferTaskToCurrentDevice({ device_id: '11:22:33:44:55:66' }, { id: '' })).toBe(false);
  });

  it('offers the assigned hostname and this device for a remote task', () => {
    const current = { id: 'aa:bb:cc:dd:ee:ff' };
    const options = auto._autoRunDeviceOptions(
      { device_id: '11:22:33:44:55:66', device_name: 'Remote-Mac.local' },
      current,
      () => 'This device',
    );
    expect(options).toEqual([
      { value: 'assigned', label: 'Remote-Mac' },
      { value: 'current', label: 'This device' },
    ]);
    expect(auto._autoRunDeviceOptions({ device_id: current.id }, current, () => 'This device')).toEqual([]);
    expect(auto._autoRunDeviceOptions(
      { device_id: '11:22:33:44:55:66' },
      { id: '' },
      () => 'This device',
    )).toEqual([]);
  });

  it('places the shared device selector below Project and removes the dialog note', () => {
    const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
    const zh = JSON.parse(fs.readFileSync(path.join(rendererRoot, 'locales/zh.json'), 'utf8'));
    const projectIndex = html.indexOf('id="auto-row-project"');
    const runIndex = html.indexOf('id="auto-row-run-device"');
    const titleIndex = html.indexOf('id="auto-title-input"');
    expect(projectIndex).toBeGreaterThan(0);
    expect(runIndex).toBeGreaterThan(projectIndex);
    expect(titleIndex).toBeGreaterThan(runIndex);
    expect(html).toContain('id="auto-run-device-select"');
    expect(html).not.toContain('id="auto-run-current-device-input"');
    expect(html).not.toContain('id="auto-task-dialog-sync-note"');
    expect(zh['auto.run_label']).toBe('运行');
    expect(zh['auto.sync_note_create']).toBeUndefined();
  });
});
