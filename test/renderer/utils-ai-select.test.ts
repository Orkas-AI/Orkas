import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require('../../src/renderer/modules/utils.js');
const { _aiSelectNextZIndex } = utils as {
  _aiSelectNextZIndex: (values: unknown[], fallback?: number) => number;
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

});
