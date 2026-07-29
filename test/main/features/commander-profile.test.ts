import { describe, expect, it } from 'vitest';

import { getProfile } from '../../../src/main/features/commander_profile';

const SUPPORTED_UI_LANGS = ['zh', 'en', 'ja', 'pt'] as const;

describe('Commander display profile', () => {
  it('provides complete user-facing content for every supported UI language', () => {
    const profile = getProfile();
    expect(profile.id).toBe('commander');

    for (const lang of SUPPORTED_UI_LANGS) {
      expect(profile.name[lang]?.trim(), `${lang} name`).toBeTruthy();
      expect(profile.description[lang]?.trim(), `${lang} description`).toBeTruthy();
      expect(profile.workflow[lang]?.trim(), `${lang} workflow`).toBeTruthy();
      expect(profile.knowhow[lang], `${lang} know-how`).toHaveLength(4);
      expect(profile.standards[lang], `${lang} standards`).toHaveLength(4);
      expect(profile.knowhow[lang]?.every((item) => item.trim().length > 0)).toBe(true);
      expect(profile.standards[lang]?.every((item) => item.trim().length > 0)).toBe(true);
    }
  });
});
