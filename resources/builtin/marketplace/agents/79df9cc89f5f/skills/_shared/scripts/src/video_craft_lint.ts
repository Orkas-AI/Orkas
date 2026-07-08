/**
 * video_craft_lint — pure, static craft checks over a HyperFrames composition's
 * index.html. Operationalizes the two deterministically-checkable thresholds
 * from the video-craft skill (legible font size, restrained palette) so the
 * agent gets concrete warnings alongside the structural/visual QA, instead of
 * relying on the model to remember the numbers while it authors HTML.
 *
 * Advisory only — these never block a render; they feed the pre-render review.
 * Layout-dependent craft (text safe zones, overflow) is intentionally left to
 * the headless `inspect` pass, which actually lays the composition out; a static
 * scan can't know rendered geometry.
 */

export interface CraftFinding {
  /** Advisory severity — informs the review, never blocks. */
  level: 'warn';
  code: 'FONT_TOO_SMALL' | 'PALETTE_LARGE';
  message: string;
}

/** video-craft §4: at 1080p, body text "never below ~40 px". Scales with canvas. */
const FONT_FLOOR_AT_1080 = 40;
/** Distinct chromatic colors across the whole file above which we nudge the
 *  author to re-check per-scene palette (video-craft §4: ≤ 3–5 on screen). High
 *  enough that a normal multi-scene composition doesn't trip it. */
const PALETTE_SOFT_MAX = 8;

/** Legibility floor scales the 1080p number to the real canvas height. Read it
 *  from the root `data-height`; fall back to 1080 when absent/unparseable. */
function readCanvasHeight(html: string, override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  const m = html.match(/data-height\s*=\s*["']?(\d{2,5})/i);
  const h = m ? Number(m[1]) : NaN;
  return Number.isFinite(h) && h > 0 ? h : 1080;
}

function fontFloor(height: number): number {
  return Math.max(1, Math.round((FONT_FLOOR_AT_1080 * height) / 1080));
}

/** Explicit px font-sizes below the floor. Only `px` is judged — em/rem/vw/%/
 *  clamp() are not a hard pixel commitment and are skipped on purpose. */
function smallFontSizesPx(html: string, floor: number): number[] {
  const out = new Set<number>();
  const re = /font-size\s*:\s*([\d.]+)px\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const px = Number(m[1]);
    if (Number.isFinite(px) && px > 0 && px < floor) out.add(px);
  }
  return [...out].sort((a, b) => a - b);
}

/** Expand a hex body (no '#', lowercased, len 3/4/6/8) to 6 rrggbb digits. */
function expandHex(h: string): string {
  if (h.length === 3) return h.split('').map((c) => c + c).join('');
  if (h.length === 4) return h.slice(0, 3).split('').map((c) => c + c).join('');
  return h.slice(0, 6); // 6 or 8 (drop alpha)
}

/** Pure grays (incl. black/white) aren't part of the "≤3–5 colors" budget. */
function isNeutralHex6(h: string): boolean {
  return h.slice(0, 2) === h.slice(2, 4) && h.slice(2, 4) === h.slice(4, 6);
}

/** Whitespace-stripped lowercased rgb()/rgba()/hsl()/hsla()/transparent → is it
 *  a structural neutral (gray, or fully transparent) rather than a real color? */
function isNeutralColorFn(s: string): boolean {
  if (s.includes('transparent')) return true;
  const rgb = s.match(/^rgba?\((\d+),(\d+),(\d+)/);
  if (rgb) return rgb[1] === rgb[2] && rgb[2] === rgb[3];
  const hsl = s.match(/^hsla?\(\d+(?:deg)?,(\d+(?:\.\d+)?)%/);
  if (hsl) return Number(hsl[1]) === 0; // 0% saturation = gray
  return false;
}

/** Distinct chromatic colors used anywhere in the composition. */
function chromaticColors(html: string): Set<string> {
  const colors = new Set<string>();
  const hexRe = /#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = hexRe.exec(html)) !== null) {
    const six = expandHex(m[1].toLowerCase());
    if (!isNeutralHex6(six)) colors.add(`#${six}`);
  }
  const fnRe = /\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/gi;
  while ((m = fnRe.exec(html)) !== null) {
    const key = m[0].toLowerCase().replace(/\s+/g, '');
    if (!isNeutralColorFn(key)) colors.add(key);
  }
  return colors;
}

/**
 * Static craft lint of a composition's index.html. Returns advisory findings;
 * an empty array means nothing tripped (it does NOT mean the composition is
 * good — only that these two mechanical thresholds passed).
 */
export function lintCompositionCraft(html: string, opts?: { canvasHeight?: number }): CraftFinding[] {
  const findings: CraftFinding[] = [];
  if (!html) return findings;

  const height = readCanvasHeight(html, opts?.canvasHeight);
  const floor = fontFloor(height);
  const small = smallFontSizesPx(html, floor);
  if (small.length) {
    const shown = small.slice(0, 6).map((n) => `${n}px`).join(', ');
    const more = small.length > 6 ? `, +${small.length - 6} more` : '';
    findings.push({
      level: 'warn',
      code: 'FONT_TOO_SMALL',
      message:
        `Font sizes below the legibility floor (~${floor}px for a ${height}px-tall canvas): ${shown}${more}. `
        + `Raise body text to ≥ the floor and titles well above it, or it won't read at phone size.`,
    });
  }

  const colors = chromaticColors(html);
  if (colors.size > PALETTE_SOFT_MAX) {
    findings.push({
      level: 'warn',
      code: 'PALETTE_LARGE',
      message:
        `${colors.size} distinct chromatic colors in the composition — aim for ≤ 3–5 on screen at once. `
        + `Re-check each scene: background least-saturated, one accent that reads first.`,
    });
  }

  return findings;
}

/** Render findings as a short text block to append to the QA findings the model
 *  reads. Empty string when there are none (so callers can concatenate freely). */
export function formatCraftFindings(findings: CraftFinding[], opts?: { strict?: boolean }): string {
  if (!findings.length) return '';
  return [
    opts?.strict
      ? '[craft] static threshold checks (FONT_TOO_SMALL blocks under --strict-craft; PALETTE_LARGE is advisory):'
      : '[craft] static threshold checks (advisory, from the video-craft skill):',
    ...findings.map((f) => `  - ${f.code}: ${f.message}`),
  ].join('\n');
}
