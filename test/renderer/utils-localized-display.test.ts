import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require('../../src/renderer/modules/utils.js');
const { normalizeDisplayText, pickDesc } = utils as {
  normalizeDisplayText: (value: unknown) => string;
  pickDesc: (spec: Record<string, unknown>, lang: string) => string;
};

describe('renderer utils — localized display text', () => {
  it('normalizes escaped quotes before rendering descriptions', () => {
    expect(normalizeDisplayText(String.raw`适合\"创建 skill\" 和 \'编辑 skill\'`))
      .toBe('适合"创建 skill" 和 \'编辑 skill\'');
  });

  it('applies quote normalization while picking localized descriptions', () => {
    const spec = {
      description_zh: '适合\\"创建 agent\\"',
      description_en: 'For: \\"create an agent\\"',
    };

    expect(pickDesc(spec, 'zh')).toBe('适合"创建 agent"');
    expect(pickDesc(spec, 'en')).toBe('For: "create an agent"');
  });
});
