import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');

function loadStatusHint() {
  const source = fs.readFileSync(path.join(rendererRoot, 'modules/local-agents.js'), 'utf8');
  const calls: Array<{ key: string; vars?: Record<string, unknown> }> = [];
  const windowObject: Record<string, unknown> = {};
  const context = vm.createContext({
    window: windowObject,
    createLogger: () => ({ warn() {} }),
    t: (key: string, vars?: Record<string, unknown>) => {
      calls.push({ key, vars });
      return key;
    },
  });
  vm.runInContext(source, context, { filename: 'local-agents.js' });
  return {
    hint: windowObject.getLocalCliUnavailableHint as (entry: Record<string, unknown> | undefined) => string,
    calls,
  };
}

describe('external-agent unavailable status copy', () => {
  it('keeps registry failure reasons distinct', () => {
    const { hint, calls } = loadStatusHint();

    expect(hint({ error: 'not_found' })).toBe('agent.cli_not_found');
    expect(hint({ error: 'version_unknown' })).toBe('agent.cli_version_unknown');
    expect(hint({ error: 'version_too_old', version: '0.9.0' })).toBe('agent.cli_version_too_old');
    expect(calls.at(-1)).toEqual({
      key: 'agent.cli_version_too_old',
      vars: { version: '0.9.0' },
    });
  });

  it('ships the three recovery messages in every renderer locale', () => {
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const table = JSON.parse(fs.readFileSync(path.join(rendererRoot, `locales/${locale}.json`), 'utf8'));
      expect(table['agent.cli_not_found']).toBeTruthy();
      expect(table['agent.cli_version_unknown']).toBeTruthy();
      expect(table['agent.cli_version_too_old']).toContain('{version}');
    }
  });
});
