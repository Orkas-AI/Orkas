import { describe, expect, it } from 'vitest';

import { lintCompositionCraft, formatCraftFindings } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_craft_lint';

const codes = (html: string, opts?: { canvasHeight?: number }) =>
  lintCompositionCraft(html, opts).map((f) => f.code);

describe('lintCompositionCraft — font legibility floor', () => {
  it('flags an explicit px font-size below the 1080p floor', () => {
    const html = '<div data-height="1080" style="font-size: 24px">hi</div>';
    expect(codes(html)).toContain('FONT_TOO_SMALL');
  });

  it('does not flag font sizes at or above the floor', () => {
    const html = '<div data-height="1080"><h1 style="font-size:96px">T</h1><p style="font-size: 40px">b</p></div>';
    expect(codes(html)).not.toContain('FONT_TOO_SMALL');
  });

  it('scales the floor to the canvas height (smaller canvas → smaller floor)', () => {
    // 540-tall canvas → floor = round(40 * 540/1080) = 20px.
    const ok = '<div data-height="540" style="font-size: 24px">ok</div>';
    expect(codes(ok)).not.toContain('FONT_TOO_SMALL');
    const bad = '<div data-height="540" style="font-size: 16px">small</div>';
    expect(codes(bad)).toContain('FONT_TOO_SMALL');
  });

  it('defaults the floor to 1080p when data-height is absent', () => {
    expect(codes('<div style="font-size: 30px">x</div>')).toContain('FONT_TOO_SMALL');
  });

  it('ignores non-px units (em / rem / vw / % / clamp) — not a hard pixel commitment', () => {
    const html = `<div data-height="1080">
      <span style="font-size: 1.2em">a</span>
      <span style="font-size: 2rem">b</span>
      <span style="font-size: 3vw">c</span>
      <span style="font-size: 90%">d</span>
      <span style="font-size: clamp(20px, 4vw, 60px)">e</span>
    </div>`;
    // clamp() embeds a literal 20px but is a responsive expression, not a fixed
    // commitment; the bare `px` regex requires `:<num>px` directly after the colon.
    expect(codes(html)).not.toContain('FONT_TOO_SMALL');
  });

  it('reports the actual small sizes in the message, deduped and sorted', () => {
    const html = '<div data-height="1080"><a style="font-size:30px">x</a><b style="font-size:18px">y</b><i style="font-size:30px">z</i></div>';
    const f = lintCompositionCraft(html).find((x) => x.code === 'FONT_TOO_SMALL')!;
    expect(f.message).toContain('18px');
    expect(f.message).toContain('30px');
    // 30px appears twice in the source but once in the message.
    expect(f.message.match(/30px/g)!.length).toBe(1);
  });
});

describe('lintCompositionCraft — palette size', () => {
  it('flags a composition with many distinct chromatic colors', () => {
    const palette = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ff8800', '#8800ff', '#0088ff'];
    const html = palette.map((c) => `<div style="color:${c}">x</div>`).join('');
    expect(codes(html)).toContain('PALETTE_LARGE');
  });

  it('does not flag neutrals — black, white, grays, transparent are not part of the budget', () => {
    const neutrals = ['#000', '#fff', '#333333', '#cccccc', 'rgb(20,20,20)', 'rgba(0,0,0,0)', 'transparent', 'hsl(0, 0%, 40%)'];
    const html = neutrals.map((c) => `<div style="color:${c}">x</div>`).join('');
    expect(codes(html)).not.toContain('PALETTE_LARGE');
  });

  it('does not flag a small, disciplined palette', () => {
    const html = '<div style="background:#102a43"><h1 style="color:#f0f4f8">t</h1><span style="color:#ffb000">accent</span></div>';
    expect(codes(html)).not.toContain('PALETTE_LARGE');
  });

  it('counts a 3-digit hex and its 6-digit form as the same color', () => {
    // #f00 and #ff0000 are the same red; with only one other color this stays small.
    const html = '<div style="color:#f00"></div><div style="color:#ff0000"></div><div style="color:#0a84ff"></div>';
    expect(codes(html)).not.toContain('PALETTE_LARGE');
  });
});

describe('formatCraftFindings', () => {
  it('returns empty string when there are no findings', () => {
    expect(formatCraftFindings([])).toBe('');
    expect(formatCraftFindings(lintCompositionCraft(''))).toBe('');
  });

  it('renders a labeled block with one line per finding', () => {
    const text = formatCraftFindings(lintCompositionCraft('<div style="font-size:12px">x</div>'));
    expect(text).toContain('[craft]');
    expect(text).toContain('FONT_TOO_SMALL');
  });

  it('labels only small text as blocking when strict craft mode is active', () => {
    const text = formatCraftFindings(lintCompositionCraft('<div style="font-size:12px">x</div>'), { strict: true });
    expect(text).toContain('FONT_TOO_SMALL blocks under --strict-craft');
    expect(text).toContain('PALETTE_LARGE is advisory');
  });

  it('keeps palette-size findings advisory even in strict craft mode', () => {
    const palette = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ff8800', '#8800ff', '#0088ff'];
    const html = palette.map((c) => `<div style="color:${c}">x</div>`).join('');
    const text = formatCraftFindings(lintCompositionCraft(html), { strict: true });
    expect(text).toContain('PALETTE_LARGE');
    expect(text).toContain('PALETTE_LARGE is advisory');
  });
});
