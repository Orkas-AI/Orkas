import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildInspectScript } from '../../../src/main/features/video_studio';
import type { Issue } from '../../../src/main/features/video_studio_qa';

type Box = { left: number; top: number; width: number; height: number };
type Layer = { style?: Record<string, string>; box?: Box };
const canvas = { left: 0, top: 0, width: 1920, height: 1080 };
const label = { left: 200, top: 200, width: 120, height: 40 };

// DOM geometry and computed styles are controlled inputs, not a contrast oracle.
// Execute the production browser probe; fixed reference ratios below come from
// the W3C source-over and relative-luminance equations. Real Chromium is checked
// separately so browser/layout behavior is not claimed from these fixtures.
function inspect(layers: Layer[], canvasRoot?: Layer, foreignBackground?: string): Issue[] {
  const bodyIndex = canvasRoot ? 1 : 0;
  if (canvasRoot) layers = [canvasRoot, ...layers];
  const elements: any[] = [];
  let parent: any = null;
  for (const [index, layer] of layers.entries()) {
    const box = layer.box ?? (index === layers.length - 1 ? label : canvas);
    const rect = { ...box, right: box.left + box.width, bottom: box.top + box.height };
    const el: any = {
      id: `layer-${index}`, tagName: index < bodyIndex ? 'HTML' : index === bodyIndex ? 'BODY' : 'SPAN', nodeType: 1,
      parentElement: parent, children: [], childNodes: [],
      style: { display: 'block', visibility: 'visible', opacity: '1', color: 'rgb(255, 255, 255)',
        backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', backgroundClip: 'border-box',
        mixBlendMode: 'normal', filter: 'none', backdropFilter: 'none', maskImage: 'none',
        fontSize: '27px', overflow: 'visible', ...layer.style },
      getBoundingClientRect: () => rect,
      getClientRects: () => [rect],
      closest: () => null,
      getAttribute: () => null,
      contains(other: any) { for (let cur = other; cur; cur = cur.parentElement) if (cur === this) return true; return false; },
      scrollWidth: box.width, clientWidth: box.width, scrollHeight: box.height, clientHeight: box.height,
    };
    if (parent) parent.children.push(el);
    elements.push(el);
    parent = el;
  }
  parent.childNodes.push({ nodeType: 3, textContent: 'Readable label' });
  elements[bodyIndex].querySelectorAll = () => elements.slice(bodyIndex + 1);
  const stack = [...elements].reverse();
  if (foreignBackground) stack.splice(1, 0, { style: { backgroundColor: foreignBackground, backgroundImage: 'none' } });
  return runInNewContext(buildInspectScript({ width: 1920, height: 1080 } as any, 0), {
    document: { body: elements[bodyIndex], documentElement: canvasRoot ? elements[0] : null,
      elementsFromPoint: () => stack },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 }, getComputedStyle: (el: any) => el.style,
  }).filter((issue: Issue) => issue.code === 'LOW_CONTRAST');
}

describe('paint-aware video text contrast', () => {
  it('uses an opaque text plate instead of a small light decoration behind it', () => {
    expect(inspect([
      { style: { backgroundColor: 'rgb(10, 11, 13)' } },
      { style: { backgroundColor: 'rgba(243, 240, 233, 0.22)' }, box: { ...label, width: 1, height: 12 } },
      { style: { color: 'rgb(237, 239, 243)', backgroundColor: 'rgb(20, 23, 28)' } },
    ])).toEqual([]);
  });

  it.each([
    { name: 'opaque own plate', layers: [
      { style: { backgroundColor: 'rgb(0, 0, 0)' } },
      { style: { color: 'rgb(238, 238, 238)', backgroundColor: 'rgb(255, 255, 255)' } },
    ], ratio: 1.16 },
    { name: 'transparent foreground', layers: [
      { style: { backgroundColor: 'rgb(255, 255, 255)' } },
      { style: { color: 'rgba(0, 0, 0, 0.1)' } },
    ], ratio: 1.25 },
    { name: 'group opacity after its own background', layers: [
      { style: { backgroundColor: 'rgb(255, 255, 255)' } },
      { style: { opacity: '0.1', backgroundColor: 'rgb(0, 0, 0)' } },
    ], ratio: 1.25 },
    { name: 'ancestor group opacity', layers: [
      { style: { backgroundColor: 'rgb(255, 255, 255)' } },
      { style: { opacity: '0.1' } },
      { style: { backgroundColor: 'rgb(0, 0, 0)' } },
    ], ratio: 1.25 },
  ])('still detects real low contrast: $name', ({ layers, ratio }) => {
    const issues = inspect(layers);
    expect(issues).toHaveLength(1);
    expect(issues[0].evidence?.contrast_ratio).toBeCloseTo(ratio, 2);
  });

  it('composites translucent ancestor paint over its actual opaque backing', () => {
    expect(inspect([
      { style: { backgroundColor: 'rgb(0, 0, 0)' } },
      { style: { backgroundColor: 'rgba(255, 255, 255, 0.2)' } },
      { style: { color: 'rgb(255, 255, 255)' } },
    ])).toEqual([]);
  });

  it.each([
    { name: 'outside parent paint', box: { left: 0, top: 0, width: 20, height: 20 } },
    { name: 'partially covered text', box: { ...label, width: 10 } },
  ])('does not treat $name as a uniform text background', ({ box }) => {
    expect(inspect([
      { style: { backgroundColor: 'rgb(0, 0, 0)' } },
      { style: { backgroundColor: 'rgb(255, 255, 255)' }, box },
      {},
    ])).toEqual([]);
  });

  it.each([
    { backgroundImage: 'linear-gradient(black, white)', backgroundColor: 'rgb(255, 255, 255)' },
    { backgroundImage: 'url(local-image.png)', backgroundColor: 'rgb(255, 255, 255)' },
    { backgroundColor: 'color(display-p3 1 1 1)' },
    { backgroundColor: 'rgb(255, 255, 255)', filter: 'invert(1)' },
  ])('does not invent a solid background for unsupported paint (%j)', style => {
    expect(inspect([{ style }, {}])).toEqual([]);
  });

  it('does not guess a black canvas when all observed backgrounds are transparent', () => {
    expect(inspect([{}, { style: { color: 'rgb(0, 0, 0)' } }])).toEqual([]);
  });

  it('uses the body background propagated to the canvas outside a zero-height body', () => {
    const issues = inspect([
      { style: { backgroundColor: 'rgb(255, 255, 255)' }, box: { ...canvas, height: 0 } },
      { style: { color: 'rgb(238, 238, 238)' } },
    ], {});
    expect(issues).toHaveLength(1);
    expect(issues[0].evidence?.contrast_ratio).toBeCloseTo(1.16, 2);
  });

  it('paints the propagated body background outside the body opacity group', () => {
    const issues = inspect([
      { style: { backgroundColor: 'rgb(255, 255, 255)', opacity: '0.1' } },
      { style: { backgroundColor: 'rgb(0, 0, 0)' } },
    ], {});
    expect(issues).toHaveLength(1);
    expect(issues[0].evidence?.contrast_ratio).toBeCloseTo(1.25, 2);
  });

  it('can evaluate an opaque plate even above an image background', () => {
    const issues = inspect([
      { style: { backgroundImage: 'url(local-image.png)' } },
      { style: { color: 'rgb(238, 238, 238)', backgroundColor: 'rgb(255, 255, 255)' } },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].evidence?.contrast_ratio).toBeCloseTo(1.16, 2);
  });

  it('does not mistake an ancestor colour for a separate painted backdrop', () => {
    expect(inspect([
      { style: { backgroundColor: 'rgb(255, 255, 255)' } }, {},
    ], undefined, 'rgb(0, 0, 0)')).toEqual([]);
  });

  it('does not let a hidden backdrop suppress real low contrast on an opaque plate', () => {
    expect(inspect([
      { style: { backgroundColor: 'rgb(0, 0, 0)' } },
      { style: { backgroundColor: 'rgb(255, 255, 255)', color: 'rgb(238, 238, 238)' } },
    ], undefined, 'rgb(0, 0, 0)')).toHaveLength(1);
  });

  it.each([{ channel: 118, low: false }, { channel: 119, low: true }])
  ('preserves the existing 4.5 threshold at gray $channel', ({ channel, low }) => {
    expect(inspect([
      { style: { backgroundColor: 'rgb(255, 255, 255)' } },
      { style: { color: `rgb(${channel}, ${channel}, ${channel})` } },
    ])).toHaveLength(low ? 1 : 0);
  });
});
