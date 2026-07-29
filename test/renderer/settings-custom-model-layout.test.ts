import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('custom model dialog layout', () => {
  it('renders the compatibility hint as a subtitle inside the modal title', () => {
    const settingsSource = readFileSync(
      resolve(__dirname, '../../src/renderer/modules/settings.js'),
      'utf8',
    );
    const styleSource = readFileSync(
      resolve(__dirname, '../../src/renderer/style.css'),
      'utf8',
    );

    expect(settingsSource).toMatch(
      /title\.innerHTML\s*=\s*`[\s\S]*class="form-hint custom-model-intro"[\s\S]*`;\s*body\.innerHTML/,
    );
    expect(styleSource).toMatch(
      /\.modal-title\s*>\s*\.custom-model-intro\s*\{[\s\S]*margin:\s*4px 0 0;[\s\S]*font-size:\s*12px;/,
    );
  });
});
