import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require('../../src/renderer/modules/utils.js');
const { _aiSelectNextZIndex, _aiSelectNormalizeOptions } = utils as {
  _aiSelectNextZIndex: (values: unknown[], fallback?: number) => number;
  _aiSelectNormalizeOptions: (options: unknown) => Array<Record<string, unknown>>;
};

describe('AiSelect popover layering', () => {
  it('stays at the base layer when no ancestor has a z-index', () => {
    expect(_aiSelectNextZIndex(['auto', '', undefined])).toBe(14000);
  });

  it('stays above the shared dialog overlay by default', () => {
    expect(_aiSelectNextZIndex(['auto', '13000', '100'])).toBe(14000);
  });

  it('raises above future overlay layers higher than the base layer', () => {
    expect(_aiSelectNextZIndex(['auto', '15000', '100'])).toBe(15001);
  });

  it('turns malformed option payloads into a safe empty list', () => {
    expect(_aiSelectNormalizeOptions(null)).toEqual([]);
    expect(_aiSelectNormalizeOptions('not-an-array')).toEqual([]);
    expect(_aiSelectNormalizeOptions([null, 3, {}, { value: 7, label: 'bad' }])).toEqual([]);
  });

  it('keeps the first unique string value and normalizes visible copy', () => {
    expect(_aiSelectNormalizeOptions([
      { value: 'a', label: 42, hint: null, iconName: 'sparkles' },
      { value: 'a', label: 'duplicate' },
      { value: 'b', disabled: true },
    ])).toEqual([
      { value: 'a', label: '42', hint: '', iconName: 'sparkles' },
      { value: 'b', label: 'b', hint: '', iconName: '', disabled: true },
    ]);
  });
});
