// Presentation only: exact amounts stay strings; inferential numbers are
// explicitly approximate. Keep raw results alongside the reusable table.
export function percentage(proportion) {
  const value = proportion * 100;
  const rounded = value.toFixed(4);
  // Do not turn a near-boundary probability/level into certainty for display.
  if (Math.abs(value) < 100 && Math.abs(Number(rounded)) === 100) return String(value);
  return value !== 0 && Number(rounded) === 0
    ? value.toExponential(3)
    : rounded.replace(/\.?0+$/u, '') || '0';
}

export function table(headers, rows) {
  const cell = value => String(value).replace(/[\r\n]+/gu, ' ').replace(/[\\`|\[\]*_<>]/gu, '\\$&');
  const line = row => `| ${row.map(cell).join(' | ')} |`;
  const visible = rows.slice(0, 20);
  return [line(headers), line(headers.map(() => '---')), ...visible.map(line),
    ...(rows.length > visible.length ? [`Showing ${visible.length} of ${rows.length} rows; the JSON arrays contain the complete results.`] : []),
  ].join('\n');
}
