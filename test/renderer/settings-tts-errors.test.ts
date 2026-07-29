import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/settings.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadFailureMapper() {
  const messages: Record<string, string> = {
    'settings.storage_full': 'Free up disk space, then try again.',
    'settings.tts.add_failed': 'Could not add the speech provider.',
  };
  const context: any = {
    t: (key: string) => messages[key] || key,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('_settingsTtsAddFailure'), context);
  return context;
}

describe('TTS settings failure display', () => {
  it('maps storage exhaustion to an actionable localized message', () => {
    const context = loadFailureMapper();
    expect(context._settingsTtsAddFailure({
      code: 'ENOSPC',
      error: 'ENOSPC at /Users/test/private/auth-profiles.json',
    })).toEqual({
      message: 'Free up disk space, then try again.',
      errorCode: 'ENOSPC',
      errorType: 'storage',
    });
  });

  it('does not expose arbitrary IPC or exception details in the add-provider flow', () => {
    const context = loadFailureMapper();
    const raw = 'write failed at /Users/test/private with api_key=secret';
    const result = context._settingsTtsAddFailure({ error: raw });
    const addFlow = source.slice(
      source.indexOf('async function _settingsClickAddTts()'),
      source.indexOf('\nfunction _settingsRenderTtsEntries()', source.indexOf('async function _settingsClickAddTts()')),
    );

    expect(result.message).toBe('Could not add the speech provider.');
    expect(JSON.stringify(result)).not.toContain('/Users/test/private');
    expect(JSON.stringify(result)).not.toContain('api_key=secret');
    expect(addFlow).not.toContain('res.error');
    expect(addFlow).not.toContain('err.message');
  });
});
