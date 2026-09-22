/** Additive review evidence from the same settled DOM as the page image.
 * Character advance bounds are candidates, not pixel masks or design intent.
 * Keep the script self-contained: it executes in the sandboxed preview window.
 */
export interface TextCollisionAudit {
  status: 'checked' | 'partial' | 'not_assessed';
  method: 'non_whitespace_character_bounds';
  coordinate_space: 'image_css_px';
  assessed_text_elements: number;
  skipped: Record<string, number>;
  limitations: string[];
  warnings: Array<{
    type: 'text_collision_candidate';
    severity: 'warning';
    paths: [string, string];
    bounds: { x: number; y: number; width: number; height: number };
  }>;
}

export function unassessedTextCollision(reason: string): TextCollisionAudit {
  return {
    status: 'not_assessed', method: 'non_whitespace_character_bounds', coordinate_space: 'image_css_px',
    assessed_text_elements: 0, skipped: { [reason]: 1 },
    limitations: ['Glyph bounds are not ink masks; intentional overlap is not inferred.', 'Text inside images and charts is not assessed.'],
    warnings: [],
  };
}

export const PPTX_TEXT_COLLISION_SCRIPT = String.raw`(() => {
  const result = {
    status: 'checked', method: 'non_whitespace_character_bounds', coordinate_space: 'image_css_px',
    assessed_text_elements: 0, skipped: {},
    limitations: ['Glyph bounds are not ink masks; intentional overlap is not inferred.', 'Text inside images and charts is not assessed.'],
    warnings: []
  };
  const skip = reason => { result.skipped[reason] = (result.skipped[reason] || 0) + 1; result.status = 'partial'; };
  const slide = Array.from(document.querySelectorAll('.slide')).find(e => e.offsetParent !== null && !e.closest('.thumb'));
  if (!slide) { skip('slide_layout_unavailable'); result.status = 'not_assessed'; return result; }
  const started = performance.now();
  const rects = [], owners = new Map(), styles = new Map();
  const style = e => { if (!styles.has(e)) styles.set(e, getComputedStyle(e)); return styles.get(e); };
  const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  const intersect = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
  let node, nodes = 0, characters = 0;
  while ((node = walker.nextNode())) {
    if (++nodes > 20000 || characters >= 8192 || performance.now() - started > 150) { skip('collection_budget'); break; }
    if (!node.textContent.trim()) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest('script,style')) continue;
    const owner = parent.closest('.shape[data-path]');
    let clip = viewport, reason = '', hidden = false, depth = 0;
    for (let e = parent; e; e = e.parentElement) {
      if (++depth > 64) { reason = 'ancestry_budget'; break; }
      const s = style(e);
      if (s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0) { hidden = true; break; }
      if (s.transform !== 'none') {
        const m = new DOMMatrixReadOnly(s.transform);
        if (!m.is2D || Math.abs(m.b) > 0.0001 || Math.abs(m.c) > 0.0001 || m.a <= 0 || m.d <= 0) reason = 'rotated_or_skewed_text';
      }
      if (s.writingMode !== 'horizontal-tb' || s.textShadow !== 'none' || s.filter !== 'none' || s.clipPath !== 'none' || Number.parseFloat(s.webkitTextStrokeWidth) > 0) reason = 'unsupported_text_effect';
      const b = e.getBoundingClientRect();
      if (s.overflowX !== 'visible') clip = { ...clip, left: Math.max(clip.left, b.left), right: Math.min(clip.right, b.right) };
      if (s.overflowY !== 'visible') clip = { ...clip, top: Math.max(clip.top, b.top), bottom: Math.min(clip.bottom, b.bottom) };
      if (e === slide) break;
    }
    if (hidden) continue;
    if (!owner || !parent.closest('.shape-text')) reason = 'unsupported_text_container';
    if (reason) { skip(reason); continue; }
    // Zero-alpha text has no painted glyphs. Other alpha/effects remain candidates.
    const color = style(parent).webkitTextFillColor || style(parent).color;
    if (color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color)) continue;
    const ownerPath = owner.getAttribute('data-path');
    if (!ownerPath || ownerPath.length > 256) { skip('element_identity_unavailable'); continue; }
    if (!owners.has(owner)) owners.set(owner, { index: owners.size, path: ownerPath });
    const identity = owners.get(owner);
    const range = document.createRange();
    let offset = 0;
    for (const character of node.textContent) {
      if (++characters > 8192 || performance.now() - started > 150) { skip('collection_budget'); break; }
      const end = offset + character.length;
      if (!/\s/u.test(character)) {
        range.setStart(node, offset); range.setEnd(node, end);
        for (const raw of range.getClientRects()) {
          const b = intersect(raw, clip);
          if (b.right > b.left && b.bottom > b.top) rects.push({ ...b, owner: identity });
          if (rects.length >= 8192) break;
        }
      }
      offset = end;
      if (rects.length >= 8192) { skip('collection_budget'); break; }
    }
    if (rects.length >= 8192) break;
  }
  result.assessed_text_elements = owners.size;
  // A sweep avoids comparing every character with every other character on a page.
  rects.sort((a, b) => a.left - b.left);
  const pairs = new Set();
  let comparisons = 0, stopped = false;
  for (let i = 0; i < rects.length && !stopped; i++) {
    const a = rects[i];
    for (let j = i + 1; j < rects.length && rects[j].left < a.right; j++) {
      if (++comparisons > 100000 || performance.now() - started > 200) { skip('comparison_budget'); stopped = true; break; }
      const b = rects[j];
      if (a.owner.index === b.owner.index) continue;
      const key = [a.owner.index, b.owner.index].sort((x, y) => x - y).join(':');
      if (pairs.has(key)) continue;
      const overlap = intersect(a, b);
      // Subpixel contact is insufficient evidence of a visible collision.
      if (overlap.right - overlap.left <= 1 || overlap.bottom - overlap.top <= 1) continue;
      pairs.add(key);
      const round = v => Math.round(v * 10) / 10;
      result.warnings.push({ type: 'text_collision_candidate', severity: 'warning', paths: [a.owner.path, b.owner.path],
        bounds: { x: round(overlap.left), y: round(overlap.top), width: round(overlap.right - overlap.left), height: round(overlap.bottom - overlap.top) } });
      if (result.warnings.length >= 16) { skip('finding_budget'); stopped = true; break; }
    }
  }
  if (!owners.size && result.status === 'partial') result.status = 'not_assessed';
  return result;
})()`;
