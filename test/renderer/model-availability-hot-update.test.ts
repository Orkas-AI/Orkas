import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('open-source model availability wiring', () => {
  it('does not subscribe picker, settings, or guard to Orkas-managed model availability', () => {
    const root = resolve(__dirname, '../../src/renderer/modules');
    for (const name of ['composer-model-picker.js', 'settings.js', 'model-guard.js']) {
      const source = readFileSync(resolve(root, name), 'utf8');
      expect(source).not.toContain(['model', ['orkas', 'llm'].join('_'), 'availability'].join('.'));
      expect(source).not.toContain(['orkas', 'llm'].join('-'));
    }
  });
});
