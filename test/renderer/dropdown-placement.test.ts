import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { _dropdownVerticalPlacement } = require('../../src/renderer/modules/dropdown-placement.js') as {
  _dropdownVerticalPlacement: (
    anchorRect: { top: number; bottom: number },
    contentHeight: number,
    viewportHeight: number,
    options?: { edge?: number; gap?: number; aboveReferenceTop?: number },
  ) => {
    openAbove: boolean;
    availableHeight: number;
    top: number;
  };
};

describe('shared dropdown vertical placement', () => {
  it('opens below when the dropdown fits there, even if there is more room above', () => {
    const placement = _dropdownVerticalPlacement(
      { top: 500, bottom: 530 },
      120,
      800,
      { edge: 8, gap: 4 },
    );

    expect(placement.openAbove).toBe(false);
    expect(placement.top).toBe(534);
  });

  it('flips above when the dropdown does not fit below', () => {
    const placement = _dropdownVerticalPlacement(
      { top: 680, bottom: 710 },
      180,
      800,
      { edge: 8, gap: 4 },
    );

    expect(placement.openAbove).toBe(true);
    expect(placement.top).toBe(496);
  });

  it('uses the roomier side and reports a constrained height when neither side fits', () => {
    const placement = _dropdownVerticalPlacement(
      { top: 150, bottom: 180 },
      320,
      240,
      { edge: 8, gap: 4 },
    );

    expect(placement.openAbove).toBe(true);
    expect(placement.availableHeight).toBe(138);
    expect(placement.top).toBe(8);
  });
});
