// ─── Shared dropdown vertical placement ───────────────────────────────────
// Standard anchored dropdowns open below their trigger. They only flip above
// when the full dropdown does not fit below and the upper side has more room.
// If neither side fits, callers constrain the dropdown to `availableHeight`.

function _dropdownVerticalPlacement(
  anchorRect,
  contentHeight,
  viewportHeight,
  options = {},
) {
  const edge = Number.isFinite(options.edge) ? Math.max(0, options.edge) : 8;
  const gap = Number.isFinite(options.gap) ? Math.max(0, options.gap) : 4;
  const aboveReferenceTop = Number.isFinite(options.aboveReferenceTop)
    ? options.aboveReferenceTop
    : anchorRect.top;
  const spaceAbove = Math.max(0, aboveReferenceTop - gap - edge);
  const spaceBelow = Math.max(0, viewportHeight - anchorRect.bottom - gap - edge);
  const fullHeight = Math.max(0, Number(contentHeight) || 0);
  const openAbove = fullHeight > spaceBelow && spaceAbove > spaceBelow;
  const availableHeight = openAbove ? spaceAbove : spaceBelow;
  const visibleHeight = Math.min(fullHeight, availableHeight);
  const top = openAbove
    ? Math.max(edge, aboveReferenceTop - gap - visibleHeight)
    : anchorRect.bottom + gap;

  return {
    openAbove,
    availableHeight,
    visibleHeight,
    spaceAbove,
    spaceBelow,
    top,
  };
}

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = { _dropdownVerticalPlacement };
}
