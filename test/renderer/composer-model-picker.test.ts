import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const rendererRoot = path.join(process.cwd(), 'src', 'renderer');

describe('open-source composer model picker', () => {
  it('loads on every composer after dropdown placement support', () => {
    const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
    const placement = html.indexOf('./modules/dropdown-placement.js');
    const picker = html.indexOf('./modules/composer-model-picker.js');

    expect(placement).toBeGreaterThan(0);
    expect(picker).toBeGreaterThan(placement);
  });

  it('uses only locally configured entries and never exposes managed credits', () => {
    const source = fs.readFileSync(
      path.join(rendererRoot, 'modules', 'composer-model-picker.js'),
      'utf8',
    );

    expect(source).toContain("window.orkas.invoke('auth.listComposerEntries')");
    expect(source).toContain("entry.profileType !== 'managed'");
    expect(source).toContain("window.orkas.invoke('auth.selectEntry'");
    expect(source).not.toContain('getSubscription');
    expect(source).not.toContain('credits_remaining');
    expect(source).not.toContain('group_official');
  });
});
