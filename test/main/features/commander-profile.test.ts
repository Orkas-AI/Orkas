import { describe, expect, it } from 'vitest';

import { getProfile } from '../../../src/main/features/commander_profile';
import { SUPPORTED_LANGS } from '../../../src/main/i18n';

describe('Commander display profile', () => {
  it('provides complete user-facing content for every supported UI language', () => {
    const profile = getProfile();
    expect(profile.id).toBe('commander');

    for (const lang of SUPPORTED_LANGS) {
      expect(profile.name[lang]?.trim(), `${lang} name`).toBeTruthy();
      expect(profile.description[lang]?.trim(), `${lang} description`).toBeTruthy();
      expect(profile.workflow[lang]?.trim(), `${lang} workflow`).toBeTruthy();
      expect(profile.description[lang], `${lang} single-paragraph introduction`).not.toMatch(/[\r\n]/);
      expect(profile.knowhow[lang], `${lang} know-how`).toHaveLength(6);
      expect(profile.standards[lang], `${lang} standards`).toHaveLength(6);
      expect(profile.knowhow[lang]?.every((item) => item.trim().length > 0)).toBe(true);
      expect(profile.standards[lang]?.every((item) => item.trim().length > 0)).toBe(true);
    }
  });

  it('opens with the requested all-round assistant identity', () => {
    expect(getProfile().description.zh.startsWith('我是你的全能 AI 助手。')).toBe(true);
  });
});
