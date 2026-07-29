import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadSettingsSandbox(): any {
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/settings.js'), 'utf8');
  const sandbox: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    t: (key: string) => key === 'settings.entries.model_unavailable'
      ? 'Select an available model'
      : key === 'settings.entries.credential_missing'
        ? 'Add the account again'
      : key,
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
    },
    window: {
      addEventListener: vi.fn(),
      orkas: { invoke: vi.fn() },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
  };
  vm.runInNewContext(source, sandbox, { filename: 'settings.js' });
  return sandbox;
}

describe('settings model whitelist', () => {
  it('does not inject an unavailable saved model into the current options', () => {
    const sandbox = loadSettingsSandbox();
    const state = sandbox._settingsEntryModelState({
      model: 'retired-model',
      modelName: 'Retired model',
      modelAvailable: false,
    }, [
      { id: 'current-model', name: 'Current model' },
    ]);

    expect(Array.from(state.options, (option: any) => option.value)).toEqual(['current-model']);
    expect(state.value).toBe('');
    expect(state.placeholder).toBe('Select an available model');
  });

  it('prioritizes a missing credential remediation over changing the model', () => {
    const sandbox = loadSettingsSandbox();

    expect(sandbox._settingsEntryProblem({
      profileAvailable: false,
      modelAvailable: false,
    })).toBe('Add the account again');
    expect(sandbox._settingsEntryProblem({
      profileAvailable: true,
      modelAvailable: false,
    })).toBe('Select an available model');
    expect(sandbox._settingsEntryProblem({
      profileAvailable: true,
      modelAvailable: true,
    })).toBe('');
  });
});
