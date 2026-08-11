import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');

describe('platform resource removal copy', () => {
  it('uses uninstall for platform agents and delete for custom agents', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'modules/agents.js'), 'utf8');

    expect(source).toContain(
      "_isAgentPlatformSource(a?.source) ? t('agents.uninstall') : t('agents.delete')",
    );
    expect(source).toContain(
      "_isAgentPlatformSource(agent.source) ? t('agents.uninstall') : t('agents.delete')",
    );
    expect(source).toContain(
      "isMarketplace ? 'agents.uninstall_confirm' : 'agents.delete_confirm'",
    );
  });

  it('uses uninstall for platform skills and delete for custom skills', () => {
    const source = fs.readFileSync(path.join(rendererRoot, 'modules/skills.js'), 'utf8');

    expect(source).toContain(
      "_isSkillPlatformSource(source) ? t('skills.uninstall') : t('skills.delete')",
    );
    expect(source).toContain(
      "isMarketplace ? 'skills.uninstall_confirm' : 'skills.delete_confirm'",
    );
  });

  it('ships separate delete and uninstall labels in every renderer locale', () => {
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const table = JSON.parse(
        fs.readFileSync(path.join(rendererRoot, `locales/${locale}.json`), 'utf8'),
      );

      expect(table['agents.delete']).toBeTruthy();
      expect(table['agents.uninstall']).toBeTruthy();
      expect(table['agents.delete']).not.toBe(table['agents.uninstall']);
      expect(table['skills.delete']).toBeTruthy();
      expect(table['skills.uninstall']).toBeTruthy();
      expect(table['skills.delete']).not.toBe(table['skills.uninstall']);
    }
  });
});
