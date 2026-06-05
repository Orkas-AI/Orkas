export const NAME_DISPLAY_MAX_UNITS = 60;

function graphemes(text: string): string[] {
  try {
    const Segmenter = (Intl as any).Segmenter;
    if (Segmenter) {
      const seg = new Segmenter(undefined, { granularity: 'grapheme' });
      return Array.from(seg.segment(text), (part: any) => part.segment);
    }
  } catch { /* fall through */ }
  return Array.from(text);
}

function codePointWidth(cp: number | undefined): number {
  if (!Number.isFinite(cp)) return 1;
  const n = cp as number;
  if ((n >= 0x0300 && n <= 0x036f) || (n >= 0xfe00 && n <= 0xfe0f)) return 0;
  if (
    (n >= 0x1100 && n <= 0x11ff)
    || (n >= 0x2e80 && n <= 0xa4cf)
    || (n >= 0xac00 && n <= 0xd7af)
    || (n >= 0xf900 && n <= 0xfaff)
    || (n >= 0xfe10 && n <= 0xfe6f)
    || (n >= 0xff00 && n <= 0xffef)
    || (n >= 0x1f300 && n <= 0x1faff)
  ) return 2;
  return 1;
}

export function nameDisplayWidth(text: string): number {
  let total = 0;
  for (const cluster of graphemes(String(text || ''))) {
    let w = 0;
    for (const ch of Array.from(cluster)) {
      w = Math.max(w, codePointWidth(ch.codePointAt(0)));
    }
    total += w || 1;
  }
  return total;
}

export function limitNameDisplayText(text: string, maxUnits = NAME_DISPLAY_MAX_UNITS): string {
  let total = 0;
  let out = '';
  for (const cluster of graphemes(String(text || ''))) {
    let w = 0;
    for (const ch of Array.from(cluster)) {
      w = Math.max(w, codePointWidth(ch.codePointAt(0)));
    }
    w = w || 1;
    if (total + w > maxUnits) break;
    out += cluster;
    total += w;
  }
  return out;
}
