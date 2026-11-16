// How the video canvas lays out and reads its cards, tested on the view model. The panel's
// DOM behaviour is covered with the real renderer in test/e2e/video_canvas_e2e_panel.spec.ts.

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  acceptsInput,
  acceptsResponse,
  agentUpdateMessage,
  dropIndex,
  edgesOf,
  fitView,
  inputCandidates,
  inputRole,
  jobKey,
  layoutCards,
  linkPath,
  mergeComposerInstruction,
  moveInOrder,
  newShotSpot,
  pastedUrl,
  placedByPage,
  productionCards,
  relatedTo,
  shotHeading,
  takeChanged,
  takeInputs,
  takeRefs,
  takeUse,
  versionMaterials,
  versionToShow,
  videoState,
  zoomAround,
} = require('../../src/renderer/modules/video-canvas.js');

const asset = (id: string) => ({ key: `asset:${id}`, id, kind: 'image', label: id, media_path: `/${id}.png` });
const shot = (id: string, uses: string[] = []) => ({ key: `shot:${id}`, shot: id, label: id, results: [], uses });
const video = (id: string, uses: string[] = [], extra: Record<string, unknown> = {}) => ({
  key: `video:${id}`,
  id,
  label: id,
  scenes: [],
  versions: [],
  uses,
  ...extra,
});
const production = (overrides: Record<string, unknown> = {}) => ({
  dir: 'ad',
  layout: {},
  assets: [],
  shots: [],
  videos: [],
  ...overrides,
});

describe('video canvas › async conversation ownership', () => {
  it('rejects a late response after navigation switches conversations', () => {
    expect(acceptsResponse('conversation-b', 'conversation-a')).toBe(false);
  });

  it('accepts only a response for the still-active conversation', () => {
    expect(acceptsResponse('conversation-a', 'conversation-a')).toBe(true);
    expect(acceptsResponse('', '')).toBe(false);
  });
});

describe('video canvas › where cards go', () => {
  it('stacks footage, shots and videos in three columns, in that order', () => {
    const { positions, columns } = layoutCards(production({
      assets: [asset('a'), asset('b')],
      shots: [shot('s')],
      videos: [video('v')],
    }), { 'asset:a': { width: 180, height: 100 }, 'asset:b': { width: 180, height: 100 } });

    expect(columns.map((column: { column: string }) => column.column)).toEqual(['asset', 'shot', 'video']);
    expect(positions['asset:a']).toEqual({ x: 0, y: 0 });
    expect(positions['asset:b']).toEqual({ x: 0, y: 116 });
    expect(positions['shot:s'].x).toBeGreaterThan(160);
    expect(positions['video:v'].x).toBeGreaterThan(positions['shot:s'].x + 200);
  });

  it('gives an empty column no room', () => {
    const { positions, columns } = layoutCards(production({ videos: [video('v')] }), {});
    expect(columns).toEqual([{ column: 'video', x: 0 }]);
    expect(positions['video:v']).toEqual({ x: 0, y: 0 });
  });

  it('keeps a card where the user put it, and closes the gap it left', () => {
    const { positions } = layoutCards(production({
      assets: [asset('a'), asset('b')],
      layout: { 'asset:a': { x: 500, y: -40 } },
    }), { 'asset:a': { width: 180, height: 100 }, 'asset:b': { width: 180, height: 100 } });

    expect(positions['asset:a']).toEqual({ x: 500, y: -40 });
    expect(positions['asset:b']).toEqual({ x: 0, y: 0 });
  });

  it('makes room for a card that grew, such as a video with a scene open', () => {
    const small = layoutCards(production({ videos: [video('a'), video('b')] }), { 'video:a': { width: 400, height: 300 } });
    const large = layoutCards(production({ videos: [video('a'), video('b')] }), { 'video:a': { width: 400, height: 700 } });
    expect(large.positions['video:b'].y - small.positions['video:b'].y).toBe(400);
  });

  it('has no cards for no production', () => {
    expect(productionCards(null)).toEqual([]);
  });
});

describe('video canvas › the lines', () => {
  const shared = production({
    assets: [asset('photo'), asset('unused')],
    shots: [shot('pour', ['asset:photo']), shot('other', ['asset:photo'])],
    videos: [video('a', ['shot:pour', 'asset:photo']), video('b', ['shot:other'])],
  });

  it('computes who uses whom, and ignores what is not on the canvas', () => {
    const edges = edgesOf(production({
      assets: [asset('photo')],
      shots: [shot('pour', ['asset:photo', 'asset:gone', 'shot:pour'])],
    }));
    expect(edges).toEqual([{ from: 'asset:photo', to: 'shot:pour' }]);
  });

  it('follows a video all the way back to its footage', () => {
    const { cards } = relatedTo('video:a', edgesOf(shared));
    expect([...cards].sort()).toEqual(['asset:photo', 'shot:pour', 'video:a']);
  });

  it('follows footage forward to everything made from it', () => {
    const { cards, edges } = relatedTo('asset:photo', edgesOf(shared));
    expect([...cards].sort()).toEqual(['asset:photo', 'shot:other', 'shot:pour', 'video:a', 'video:b']);
    expect(edges).toHaveLength(5);
  });

  it('does not light up a neighbor\'s other uses', () => {
    const { cards, edges } = relatedTo('shot:pour', edgesOf(shared));
    expect(cards.has('shot:other')).toBe(false);
    expect(cards.has('video:b')).toBe(false);
    // The photo's line straight to video a is not on the way through this shot's card.
    expect(edges).toEqual([
      { from: 'asset:photo', to: 'shot:pour' },
      { from: 'shot:pour', to: 'video:a' },
    ]);
  });

  it('knows before a file is picked that a page places a picture, so it is not swapped', () => {
    const placed = production({ assets: [asset('site'), asset('photo')], videos: [video('a', ['asset:site'], { placed_by_page: ['site'] }), video('b')] });
    expect(placedByPage(placed, 'site')).toBe(true);
    expect(placedByPage(placed, 'photo')).toBe(false);
    // A canvas read before the field existed swaps as before.
    expect(placedByPage(production({ videos: [video('a', ['asset:site'])] }), 'site')).toBe(false);
    expect(placedByPage(null, 'site')).toBe(false);
  });

  it('has nothing to draw for a card nothing touches', () => {
    const { cards, edges } = relatedTo('asset:unused', edgesOf(shared));
    expect([...cards]).toEqual(['asset:unused']);
    expect(edges).toEqual([]);
  });

  it('finishes cyclic shot references without losing their shared input or lighting an unrelated branch', () => {
    const cyclic = production({
      assets: [asset('photo')],
      shots: [shot('a', ['asset:photo', 'shot:b']), shot('b', ['shot:a']), shot('neighbor', ['asset:photo'])],
      videos: [video('main', ['shot:b']), video('other', ['shot:neighbor'])],
    });
    const { cards, edges } = relatedTo('shot:a', edgesOf(cyclic));
    expect([...cards].sort()).toEqual(['asset:photo', 'shot:a', 'shot:b', 'video:main']);
    expect(edges).toHaveLength(4);
    expect(edges.some((edge: { from: string; to: string }) => edge.to === 'shot:neighbor' || edge.to === 'video:other')).toBe(false);
  });
});

// Decided on 2026-11-09: the product is a card among the footage. It lists what the videos show
// apart from what none of them does, and says how many of the videos are behind a change.
describe('video canvas › the product card', () => {
  const fact = (id: string, source = 'page') => ({ id, text: id, source, used_by: 0 });
  const product = (facts: unknown[], uses: string[] = []) => ({ key: 'product', label: 'Desk lamp', facts, uses });
  const quoting = (id: string, factIds: string[]) => video(id, ['product'], {
    scenes: [{ id: 's', texts: factIds.map((factId) => ({ slot: factId, value: factId, fact_id: factId })) }],
  });
  const keys = (cards: Array<{ key: string }>) => cards.map((card) => card.key);

  it('comes first among the footage', () => {
    const cards = productionCards(production({ product: product([fact('price')]), assets: [asset('photo')], videos: [video('v')] }));
    expect(cards.map((card: { key: string; column: string }) => [card.key, card.column])).toEqual([
      ['product', 'asset'],
      ['asset:photo', 'asset'],
      ['video:v', 'video'],
    ]);
  });

  it('is not shown without a product, or for one with nothing to list', () => {
    expect(keys(productionCards(production({ assets: [asset('photo')] })))).toEqual(['asset:photo']);
    expect(keys(productionCards(production({ product: product([]), assets: [asset('photo')] })))).toEqual(['asset:photo']);
  });

  it('is wider than footage, so the next column starts after it', () => {
    const { positions } = layoutCards(
      production({ product: product([fact('price')]), assets: [asset('photo')], shots: [shot('s')] }),
      { product: { width: 240, height: 300 } },
    );
    expect(positions.product).toEqual({ x: 0, y: 0 });
    expect(positions['asset:photo']).toEqual({ x: 0, y: 316 });
    expect(positions['shot:s'].x).toBeGreaterThan(240);
    const without = layoutCards(production({ assets: [asset('photo')], shots: [shot('s')] }), {});
    expect(without.positions['shot:s'].x).toBeLessThan(positions['shot:s'].x);
  });

  it('draws lines from its pictures and to the videos that quote it', () => {
    const shown = production({
      product: product([fact('price')], ['asset:photo', 'asset:gone']),
      assets: [asset('photo'), asset('other')],
      videos: [quoting('a', ['price']), video('b', ['asset:other'])],
    });
    const edges = edgesOf(shown);
    expect(edges).toContainEqual({ from: 'asset:photo', to: 'product' });
    expect(edges).toContainEqual({ from: 'product', to: 'video:a' });
    expect(edges.some((edge: { from: string; to: string }) => edge.to === 'product' && edge.from === 'asset:gone')).toBe(false);
    expect([...relatedTo('product', edges).cards].sort()).toEqual(['asset:photo', 'product', 'video:a']);
    // With nothing to list there is no card, and no line to one.
    const hidden = edgesOf(production({ product: product([], ['asset:photo']), assets: [asset('photo')], videos: [quoting('a', [])] }));
    expect(hidden.some((edge: { from: string; to: string }) => edge.from === 'product' || edge.to === 'product')).toBe(false);
  });

});

describe('video canvas › the view', () => {
  it('shows everything at full size when it fits', () => {
    const view = fitView([{ x: 0, y: 0, width: 200, height: 100 }], { width: 1000, height: 800 });
    expect(view.zoom).toBe(1);
    expect(view.x).toBe(400);
  });

  it('starts from the top, because a card grows downward when a scene opens', () => {
    const view = fitView([{ x: 0, y: 200, width: 200, height: 100 }], { width: 1000, height: 800 });
    expect(view.y + 200 * view.zoom).toBeLessThan(100);
  });

  it('shrinks to fit, and keeps everything inside the viewport', () => {
    const rects = [{ x: -100, y: -50, width: 600, height: 400 }, { x: 700, y: 300, width: 800, height: 1400 }];
    const viewport = { width: 800, height: 600 };
    const view = fitView(rects, viewport);
    expect(view.zoom).toBeLessThan(1);
    expect(view.x + -100 * view.zoom).toBeGreaterThanOrEqual(0);
    expect(view.x + 1500 * view.zoom).toBeLessThanOrEqual(viewport.width);
    expect(view.y + -50 * view.zoom).toBeGreaterThanOrEqual(0);
    expect(view.y + 1700 * view.zoom).toBeLessThanOrEqual(viewport.height);
  });

  it('never shrinks past what can be read back', () => {
    const view = fitView([{ x: 0, y: 0, width: 100000, height: 100 }], { width: 400, height: 400 });
    expect(view.zoom).toBe(0.25);
  });

  it('has a starting view for an empty canvas', () => {
    expect(fitView([], { width: 400, height: 400 }).zoom).toBe(1);
  });

  it('keeps the point under the cursor still while zooming', () => {
    const before = { x: 30, y: -20, zoom: 0.8 };
    const after = zoomAround(before, 1.3, 200, 150);
    const world = (view: typeof before, screen: number, offset: number) => (screen - offset) / view.zoom;
    expect(world(after, 200, after.x)).toBeCloseTo(world(before, 200, before.x), 6);
    expect(world(after, 150, after.y)).toBeCloseTo(world(before, 150, before.y), 6);
  });

  it('stops zooming at the limits', () => {
    expect(zoomAround({ x: 0, y: 0, zoom: 1 }, 100, 0, 0).zoom).toBe(2);
    expect(zoomAround({ x: 0, y: 0, zoom: 1 }, 0.01, 0, 0).zoom).toBe(0.25);
  });
});

describe('video canvas › moving scenes', () => {
  it('moves a scene one place either way', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveInOrder(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  it('has nowhere to go past either end, or for a scene that is not there', () => {
    expect(moveInOrder(['a', 'b'], 'a', -1)).toBeNull();
    expect(moveInOrder(['a', 'b'], 'b', 1)).toBeNull();
    expect(moveInOrder(['a', 'b'], 'z', 1)).toBeNull();
  });

  const row = (top: number, ...lefts: number[]) => lefts.map((left) => ({ left, width: 60, top, bottom: top + 50 }));

  it('finds where a dragged chip lands along a row', () => {
    const rects = row(0, 0, 70, 140);
    expect(dropIndex(rects, 10, 20)).toBe(0);
    expect(dropIndex(rects, 40, 20)).toBe(1);
    expect(dropIndex(rects, 300, 20)).toBe(3);
  });

  it('finds where it lands when the chips wrap', () => {
    const rects = [...row(0, 0, 70), ...row(60, 0, 70)];
    // Past the end of the first row, still in its height, is the start of the next.
    expect(dropIndex(rects, 300, 20)).toBe(2);
    expect(dropIndex(rects, 40, 80)).toBe(3);
    expect(dropIndex(rects, 300, 80)).toBe(4);
    expect(dropIndex(rects, 10, -30)).toBe(0);
  });
});

describe('video canvas › a pasted link', () => {
  it.each([
    'https://shop.example.com/item/42',
    'http://example.com',
    '  https://example.com/a?b=c#d  \n',
    'HTTPS://EXAMPLE.COM/x',
  ])('takes %j as a product link', (text) => {
    expect(pastedUrl(text)).toBe(text.trim());
  });

  it.each([
    '',
    'example.com',
    'look at https://example.com/item',
    'https://example.com/item and more',
    'https://a.example\nhttps://b.example',
    'ftp://example.com/file',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://',
  ])('does not take %j as one', (text) => {
    expect(pastedUrl(text)).toBe('');
  });
});

describe('video canvas › a video\'s state', () => {
  const versions = [{ id: 'v1' }, { id: 'v2' }];

  it('plays the newest version, or the one the user picked while it exists', () => {
    expect(versionToShow(versions, undefined)).toEqual({ id: 'v2' });
    expect(versionToShow(versions, 'v1')).toEqual({ id: 'v1' });
    expect(versionToShow(versions, 'gone')).toEqual({ id: 'v2' });
    expect(versionToShow([], undefined)).toBeNull();
  });

  it.each([
    ['a video with nothing to do', video('v', [], { versions }), null, 'ready'],
    // Decided 2026-11-11: a card does not say a video is behind its changes; Update is always there.
    ['product info changed since it went out', video('v', [], { versions, product_changes: [{ before: '$29', after: '$19' }] }), null, 'ready'],
    ['product info changed during a render', video('v', [], { versions, product_changes: [{ before: 'a', after: 'b' }] }), { status: 'running' }, 'updating'],
    ['a video never rendered, though the product changed', video('v', [], { product_changes: [{ before: 'a', after: 'b' }] }), null, 'not_rendered'],
    ['a timeline never rendered', video('v'), null, 'not_rendered'],
    ['a render under way', video('v', [], { versions }), { status: 'running' }, 'updating'],
    ['a render that failed', video('v', [], { versions }), { status: 'failed' }, 'failed'],
    ['a file from ffmpeg alone', { ...video('', [], { versions }), id: '' }, null, 'ready'],
  ])('reads %s', (_label, card, job, state) => {
    expect(videoState(card, job)).toBe(state);
  });

  it('keeps one job per video and kind, and per shot for a new take', () => {
    const render = { dir: 'ad', video_id: 'v', kind: 'render' };
    expect(jobKey(render)).toBe(jobKey({ ...render, phase: 'queue' }));
    expect(jobKey(render)).not.toBe(jobKey({ ...render, dir: 'other' }));
    const take = { dir: 'ad', kind: 'redo', shot: 'shot:a' };
    expect(jobKey(take)).toBe(jobKey({ ...take, phase: 'generate' }));
    expect(jobKey(take)).not.toBe(jobKey({ ...take, shot: 'shot:b' }));
    expect(jobKey(take)).not.toBe(jobKey(render));
  });
});

describe('video canvas › a shot\'s panel', () => {
  // Selecting a shot shows how its take was made and offers to use another take (decided
  // 2026-11-09).
  const take = (id: string, extra: Record<string, unknown> = {}) => ({ asset_id: id, refs: [], used_in: 0, ...extra });
  const pour = (results: unknown[]) => ({ ...shot('pour'), results });

  it('shows what a take was made from, among the cards on the canvas, in the order it was asked', () => {
    const canvas = production({ assets: [asset('photo'), asset('logo')], shots: [shot('bg')] });
    const made = take('pour-1', { refs: [
      { card: 'shot:bg', role: 'first_frame' },
      { card: 'asset:gone', role: 'reference' },
      { card: 'asset:photo', role: 'reference' },
    ] });
    expect(takeRefs(canvas, made).map((ref: { card: { key: string }; role: string }) => [ref.card.key, ref.role]))
      .toEqual([['shot:bg', 'first_frame'], ['asset:photo', 'reference']]);
    expect(takeRefs(canvas, take('plain'))).toEqual([]);
  });

  it('offers to use a take while a video shows another take of the shot', () => {
    const card = pour([take('pour-1'), take('pour-2', { used_in: 2 })]);
    expect(takeUse(card, 0)).toEqual({ inUse: false, canUse: true });
    expect(takeUse(card, 1)).toEqual({ inUse: true, canUse: false });
    expect(takeUse(pour([take('only')]), 0)).toEqual({ inUse: false, canUse: false });
    expect(takeUse(pour([take('a', { used_in: 1 }), take('b', { used_in: 1 })]), 0)).toEqual({ inUse: true, canUse: true });
    expect(takeUse(pour([take('a')]), 3)).toEqual({ inUse: false, canUse: false });
  });

  // 2026-11-12: with nothing changed, Generate made the same request again.
  it('offers Generate only once the words, footage, way, a setting or the service differ from the take', () => {
    const made = take('pour-2', {
      kind: 'video',
      prompt: 'rain at the stop',
      refs: [{ card: 'asset:photo', role: 'reference' }],
      params: { ratio: '16:9', resolution: '480p', duration: 4, audio: true },
    });
    const same = { prompt: 'rain at the stop', choice: 'h3', current: 'h3' };
    expect(takeChanged(made, same)).toBe(false);
    // Spaces around the words, a field not drawn yet, and footage added then taken out change nothing.
    expect(takeChanged(made, { ...same, prompt: '  rain at the stop\n' })).toBe(false);
    expect(takeChanged(made, { ...same, prompt: undefined })).toBe(false);
    expect(takeChanged(made, { ...same, inputs: { added: [] } })).toBe(false);
    // Settings and the way picked as they were change nothing either.
    expect(takeChanged(made, { ...same, settings: { resolution: '480p', audio: true } })).toBe(false);
    expect(takeChanged(made, { ...same, inputs: { method: 'references', added: [] } })).toBe(false);
    expect(takeChanged(made, { ...same, prompt: 'rain at the stop, closer' })).toBe(true);
    expect(takeChanged(made, { ...same, prompt: '' })).toBe(true);
    expect(takeChanged(made, { ...same, inputs: { added: ['logo'] } })).toBe(true);
    expect(takeChanged(made, { ...same, inputs: { method: 'frames', added: [] } })).toBe(true);
    expect(takeChanged(made, { ...same, settings: { resolution: '720p' } })).toBe(true);
    expect(takeChanged(made, { ...same, settings: { audio: false } })).toBe(true);
    expect(takeChanged(made, { ...same, choice: 'doubao' })).toBe(true);
    // Until the services are known there is no service to compare; a still has none.
    expect(takeChanged(made, { ...same, choice: 'doubao', current: undefined })).toBe(false);
    const still = take('character', { kind: 'image', prompt: 'girl in a yellow raincoat', params: { size: '2K' } });
    expect(takeChanged(still, { prompt: 'girl in a yellow raincoat', choice: '' })).toBe(false);
    expect(takeChanged(still, { prompt: 'girl in a red raincoat', choice: '' })).toBe(true);
  });

  // 2026-11-12: a character still headed "Shot 01", so the first video shot read as the second.
  it('heads a still as an image and a video as a shot, each counted among its own kind', () => {
    const still = { ...shot('character'), results: [take('character', { kind: 'image' })] };
    const first = { ...shot('shot1'), results: [take('shot1', { kind: 'video' })] };
    const second = { ...shot('shot2'), results: [take('shot2-a', { kind: 'video' }), take('shot2-b', { kind: 'video' })] };
    const canvas = production({ shots: [still, first, second] });
    expect(shotHeading(canvas, still)).toEqual({ kind: 'image', n: '01' });
    expect(shotHeading(canvas, first)).toEqual({ kind: 'shot', n: '01' });
    expect(shotHeading(canvas, second)).toEqual({ kind: 'shot', n: '02' });
    // A shot with no take on record is counted as a shot.
    const empty = shot('empty');
    expect(shotHeading(production({ shots: [still, empty] }), empty)).toEqual({ kind: 'shot', n: '01' });
  });
});

// Decided 2026-11-10 (plan 27.20): footage joins a shot in its panel or along a line drawn from a
// card's "+", as TapNow does, and a line drawn to empty board makes a new shot.
describe('video canvas › adding footage and new shots', () => {
  const take = (id: string, extra: Record<string, unknown> = {}) => ({ asset_id: id, refs: [], used_in: 0, ...extra });
  const draft = (id: string, extra: Record<string, unknown> = {}) => ({
    key: `draft:${id}`, id, kind: 'video', prompt: '', method: 'references', inputs: [], uses: [], ...extra,
  });

  it('puts new shots in the shots column, after the shots, with lines from their footage', () => {
    const canvas = production({
      assets: [asset('photo')],
      shots: [shot('pour', ['asset:photo'])],
      drafts: [draft('n1', { uses: ['asset:photo', 'shot:pour', 'asset:gone'] })],
    });

    expect(productionCards(canvas).map((card: { key: string; column: string; kind: string }) => [card.key, card.column, card.kind]))
      .toEqual([['asset:photo', 'asset', 'asset'], ['shot:pour', 'shot', 'shot'], ['draft:n1', 'shot', 'draft']]);
    const { positions } = layoutCards(canvas, {});
    expect(positions['draft:n1'].x).toBe(positions['shot:pour'].x);
    expect(positions['draft:n1'].y).toBeGreaterThan(positions['shot:pour'].y);
    expect(edgesOf(canvas)).toEqual([
      { from: 'asset:photo', to: 'shot:pour' },
      { from: 'asset:photo', to: 'draft:n1' },
      { from: 'shot:pour', to: 'draft:n1' },
    ]);
  });

  it('gives inputs their part by order: frames open and close, everything else is a reference', () => {
    expect([0, 1, 2].map((index) => inputRole('frames', index))).toEqual(['first_frame', 'last_frame', 'reference']);
    expect([0, 1].map((index) => inputRole('references', index))).toEqual(['reference', 'reference']);
  });

  it('lists a take\'s own footage first, then what the user added, which alone can be taken out', () => {
    const pour = { ...shot('pour'), results: [take('pour-1'), take('pour-2')] };
    const canvas = production({ assets: [asset('photo'), asset('logo')], shots: [pour, shot('bg')] });
    const made = take('t', { refs: [{ card: 'asset:photo', role: 'first_frame' }, { card: 'asset:gone', role: 'reference' }] });

    const inputs = takeInputs(canvas, made, 'frames', ['logo', 'pour-1', 'missing']);
    expect(inputs.map((input: { card: { key: string }; role: string; removable: boolean; asset_id?: string }) => [input.card.key, input.role, input.removable, input.asset_id ?? null]))
      .toEqual([
        ['asset:photo', 'first_frame', false, null],
        ['asset:logo', 'last_frame', true, 'logo'],
        ['shot:pour', 'reference', true, 'pour-1'],
      ]);
    expect(takeInputs(canvas, made, 'references', []).map((input: { role: string }) => input.role)).toEqual(['reference']);
  });

  it('offers what is on the canvas and not yet an input, and only images where only images go', () => {
    const cards = [
      { key: 'asset:photo', asset_id: 'photo', kind: 'image' },
      { key: 'asset:clip', asset_id: 'clip', kind: 'video' },
      { key: 'shot:pour', asset_id: 'pour-2', kind: 'video' },
    ];
    expect(inputCandidates(cards, { imagesOnly: false, exclude: ['shot:pour'] }).map((card: { key: string }) => card.key))
      .toEqual(['asset:photo', 'asset:clip']);
    expect(inputCandidates(cards, { imagesOnly: true, exclude: [] }).map((card: { key: string }) => card.key)).toEqual(['asset:photo']);
  });

  it('takes a dropped picture only where it can go, and only once', () => {
    const photo = { key: 'asset:photo', kind: 'image' };
    const clip = { key: 'asset:clip', kind: 'video' };
    expect(acceptsInput({ key: 'draft:n1', imagesOnly: false, cards: [] }, clip)).toBe(true);
    expect(acceptsInput({ key: 'draft:n1', imagesOnly: true, cards: [] }, clip)).toBe(false);
    expect(acceptsInput({ key: 'draft:n1', imagesOnly: true, cards: [] }, photo)).toBe(true);
    expect(acceptsInput({ key: 'shot:pour', imagesOnly: false, cards: ['asset:photo'] }, photo)).toBe(false);
    expect(acceptsInput({ key: 'asset:photo', imagesOnly: false, cards: [] }, photo)).toBe(false);
    expect(acceptsInput(null, photo)).toBe(false);
  });

  it('draws a line being dragged as the canvas draws the others', () => {
    expect(linkPath(0, 10, 200, 50)).toBe('M0 10 C100 10 100 50 200 50');
    expect(linkPath(0, 0, 20, 0)).toBe('M0 0 C40 0 -20 0 20 0');
  });

  // On 2026-11-10 a second new shot from the same photo landed exactly on the first and hid it,
  // and one from a shot beside the video covered the video.
  it('puts a new shot right of its card, lower down past any card in the way', () => {
    type Rect = { x: number; y: number; width: number; height: number };
    // A new shot is 200 wide before it is measured, and its card about as tall.
    const placed = (spot: { x: number; y: number }): Rect => ({ ...spot, width: 200, height: 200 });
    const apart = (a: Rect, b: Rect) => a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height;
    const photo = { x: 0, y: 100, width: 160, height: 170 };

    // Level with its card, to its right, when nothing is there.
    const first = newShotSpot(photo, []);
    expect(first.y).toBe(photo.y);
    expect(first.x).toBeGreaterThan(photo.x + photo.width);

    const firstCard = { ...placed(first), height: 187 };
    const second = newShotSpot(photo, [photo, firstCard]);
    expect(second.x).toBe(first.x);
    expect(apart(placed(second), firstCard)).toBe(true);
    expect(apart(placed(second), photo)).toBe(true);

    // Past a whole column of cards, not only the first in the way.
    const column = [0, 1, 2].map((index) => ({ x: first.x, y: 100 + index * 220, width: 200, height: 200 }));
    const below = newShotSpot(photo, column);
    for (const card of column) expect(apart(placed(below), card)).toBe(true);

    // From a shot beside a video, below the video rather than over it.
    const shot = { x: 240, y: 286, width: 200, height: 210 };
    const video = { x: 552, y: 0, width: 380, height: 480 };
    const spot = newShotSpot(shot, [shot, video]);
    expect(spot.x).toBeGreaterThan(shot.x + shot.width);
    expect(apart(placed(spot), video)).toBe(true);
  });

  it('keeps one job per new shot', () => {
    const made = { dir: 'ad', kind: 'new_shot', shot: 'draft:n1' };
    expect(jobKey(made)).toBe(jobKey({ ...made, phase: 'generate' }));
    expect(jobKey(made)).not.toBe(jobKey({ dir: 'ad', kind: 'redo', shot: 'draft:n1' }));
  });
});

describe('video canvas › composer instructions', () => {
  const VISUAL_S3 = { full: '修改视频「vids/social」场景 s3 的画面：', short: '场景 s3 的画面：' };
  const COPY_S5 = { full: '修改视频「vids/social」场景 s5 的文案：', short: '场景 s5 的文案：' };
  const PRODUCTION = 'vids/social';

  it('fills an empty composer with the full instruction, caret at the end', () => {
    const merged = mergeComposerInstruction({ current: '', ...VISUAL_S3, production: PRODUCTION });
    expect(merged.value).toBe(VISUAL_S3.full);
    expect(merged.selectionStart).toBe(VISUAL_S3.full.length);
  });

  it('appends a second scene without touching what the user already wrote', () => {
    const current = `${VISUAL_S3.full}背景改成深蓝`;
    const merged = mergeComposerInstruction({ current, ...COPY_S5, production: PRODUCTION });
    expect(merged.value).toBe(`${current}\n${COPY_S5.short}`);
    expect(merged.selectionStart).toBe(merged.value.length);
  });

  it('names the production again when another video was named more recently', () => {
    // Dropping the name here would aim the instruction at whichever video the
    // previous line named — a silent edit to the wrong production.
    const current = `${VISUAL_S3.full}背景改成深蓝\n修改视频「vids/launch」场景 s1 的画面：换个开场`;
    const merged = mergeComposerInstruction({
      current,
      ...COPY_S5,
      production: PRODUCTION,
      otherProductions: ['vids/launch'],
    });
    expect(merged.value).toBe(`${current}\n${COPY_S5.full}`);
  });

  it('keeps the short form once this video is the one named most recently', () => {
    // Negative control for the rule above: the other production appears in the
    // message, but this one was named after it, so the list can stay compact.
    const current = `修改视频「vids/launch」场景 s1 的画面：换个开场\n${VISUAL_S3.full}背景改成深蓝`;
    const merged = mergeComposerInstruction({
      current,
      ...COPY_S5,
      production: PRODUCTION,
      otherProductions: ['vids/launch'],
    });
    expect(merged.value).toBe(`${current}\n${COPY_S5.short}`);
  });

  it('stays compact across a run of edits to the same video', () => {
    // The user's own wording between clicks must not push later entries back
    // to the long form; only another production may do that.
    const current = `${VISUAL_S3.full}背景改成深蓝\n${COPY_S5.short}字太小\n再整体亮一点`;
    const merged = mergeComposerInstruction({
      current,
      full: '修改视频「vids/social」场景 s7 的画面：',
      short: '场景 s7 的画面：',
      production: PRODUCTION,
      otherProductions: [],
    });
    expect(merged.value).toBe(`${current}\n场景 s7 的画面：`);
  });

  it('names the production when the user opened with their own words', () => {
    const current = '这个视频整体节奏偏快';
    const merged = mergeComposerInstruction({ current, ...VISUAL_S3, production: PRODUCTION });
    expect(merged.value).toBe(`${current}\n${VISUAL_S3.full}`);
  });

  it('moves the caret to an entry already written instead of repeating it', () => {
    const current = `${VISUAL_S3.full}背景改成深蓝\n${COPY_S5.short}`;
    const merged = mergeComposerInstruction({ current, ...VISUAL_S3, production: PRODUCTION });
    expect(merged.value).toBe(current);
    expect(merged.selectionStart).toBe(`${VISUAL_S3.full}背景改成深蓝`.length);
  });

  it('recognizes a repeated entry through the short form too', () => {
    const current = `${VISUAL_S3.full}背景改成深蓝\n${COPY_S5.short}字太小`;
    const merged = mergeComposerInstruction({ current, ...COPY_S5, production: PRODUCTION });
    expect(merged.value).toBe(current);
    expect(merged.selectionStart).toBe(current.length);
  });

  it('does not leave a blank line behind trailing whitespace', () => {
    const merged = mergeComposerInstruction({
      current: `${VISUAL_S3.full}背景改成深蓝\n\n  `,
      ...COPY_S5,
      production: PRODUCTION,
    });
    expect(merged.value).toBe(`${VISUAL_S3.full}背景改成深蓝\n${COPY_S5.short}`);
  });

  it('leaves the composer untouched when there is no instruction to add', () => {
    const merged = mergeComposerInstruction({ current: '已经写好的内容', full: '' });
    expect(merged.value).toBe('已经写好的内容');
    expect(merged.selectionStart).toBe('已经写好的内容'.length);
  });

  // Decided 2026-11-11: another version lists the canvas's footage and shots under the ask, one
  // per line, for the user to delete what should not be used, and the caret waits on the ask.
  const ANOTHER = { full: '再做一版「暖光台灯」：', production: '暖光台灯' };
  const LIST = ['用这些素材和镜头：', '- 素材「台灯正面.png」', '- 镜头「台灯亮起」'];

  it('lists the materials under the ask, with the caret at the end of the ask', () => {
    const merged = mergeComposerInstruction({ current: '', ...ANOTHER, lines: LIST });
    expect(merged.value).toBe(['再做一版「暖光台灯」：', ...LIST].join('\n'));
    expect(merged.selectionStart).toBe('再做一版「暖光台灯」：'.length);
  });

  it('adds the ask and its list after what the user wrote, caret on the ask', () => {
    const current = '这个视频整体节奏偏快';
    const merged = mergeComposerInstruction({ current, ...ANOTHER, lines: LIST });
    expect(merged.value).toBe([current, '再做一版「暖光台灯」：', ...LIST].join('\n'));
    expect(merged.selectionStart).toBe(`${current}\n再做一版「暖光台灯」：`.length);
  });

  it('does not list the materials twice when the ask is already there', () => {
    const current = ['再做一版「暖光台灯」：短一点', '用这些素材和镜头：', '- 镜头「台灯亮起」'].join('\n');
    const merged = mergeComposerInstruction({ current, ...ANOTHER, lines: LIST });
    expect(merged.value).toBe(current);
    expect(merged.selectionStart).toBe('再做一版「暖光台灯」：短一点'.length);
  });
});

describe('video canvas › what another version is made from', () => {
  it('lists the footage, then the shots, by the names their cards show', () => {
    const materials = versionMaterials(production({
      assets: [asset('front.png'), { ...asset('nameless'), label: '' }, asset('side.png')],
      shots: [shot('Lamp turning on'), shot('Close-up')],
      drafts: [{ key: 'draft:n1', id: 'n1', kind: 'video', prompt: 'not made yet' }],
      product: { key: 'product', label: 'Desk lamp', facts: [] },
      videos: [video('main')],
    }));

    expect(materials).toEqual([
      { kind: 'footage', name: 'front.png' },
      { kind: 'footage', name: 'side.png' },
      { kind: 'shot', name: 'Lamp turning on' },
      { kind: 'shot', name: 'Close-up' },
    ]);
  });

  it('lists nothing for a canvas without footage or shots, or none at all', () => {
    expect(versionMaterials(production())).toEqual([]);
    expect(versionMaterials(null)).toEqual([]);
  });
});

// Decided 2026-11-11, with the words the product owner confirmed: narration changed on the canvas,
// or the video's voice, goes to VideoStudio as the user's message; product facts keep theirs.
describe('video canvas › what Update asks of VideoStudio', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/renderer/locales/zh.json'), 'utf8')) as Record<string, string>;
  const tr = (key: string, params: Record<string, unknown> = {}) => String(zh[key] ?? key)
    .replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''));
  const card = (extra: Record<string, unknown> = {}) => ({
    id: 'main',
    label: '暖光台灯带货短视频',
    product_changes: [],
    narration_changes: [],
    voice_wanted: null,
    ...extra,
  });
  const LINE = { position: 2, scene: 'light', text: '暖光不刺眼，看书一整晚也不累' };
  const VOICE = { route_ref: 'configured:test-voice', voice_ref: 'zh_female_warm', name: '温暖女声' };
  const PRODUCT = [
    '商品信息改了，请更新视频「暖光台灯带货短视频」：',
    '- 「¥179」改成「¥159」',
    '画面文字和旁白里说到这些的地方，用视频原来的说法和格式改，只补上或改掉变了的部分；其他不动。',
  ];

  it('asks nothing when the app renders the change itself', () => {
    expect(agentUpdateMessage(card(), tr)).toBe('');
  });

  it('asks for narration voiced again in the voice it has', () => {
    expect(agentUpdateMessage(card({ narration_changes: [LINE] }), tr)).toBe([
      '旁白改了，请更新视频「暖光台灯带货短视频」：',
      '- 第 2 段（light）的旁白改成「暖光不刺眼，看书一整晚也不累」',
      '用原来的音色重新配这几句，配出来放不进哪一段，就调整那一段的时长，其他不动。',
    ].join('\n'));
  });

  it('asks for all narration voiced again in a new voice', () => {
    expect(agentUpdateMessage(card({ narration_changes: [LINE], voice_wanted: VOICE }), tr)).toBe([
      '旁白改了，请更新视频「暖光台灯带货短视频」：',
      '- 第 2 段（light）的旁白改成「暖光不刺眼，看书一整晚也不累」',
      '- 音色换成「温暖女声」（route_ref configured:test-voice，voice_ref zh_female_warm）',
      '整条视频的旁白都用新音色重新配，配出来放不进哪一段，就调整那一段的时长，其他不动。',
    ].join('\n'));
  });

  it('puts a product change first and the narration after it', () => {
    expect(agentUpdateMessage(card({ product_changes: [{ before: '¥179', after: '¥159' }], voice_wanted: VOICE }), tr)).toBe([
      ...PRODUCT,
      '旁白也改了：',
      '- 音色换成「温暖女声」（route_ref configured:test-voice，voice_ref zh_female_warm）',
      '整条视频的旁白都用新音色重新配，配出来放不进哪一段，就调整那一段的时长，其他不动。',
    ].join('\n'));
  });

  it('keeps the product message as it was when only the product changed', () => {
    expect(agentUpdateMessage(card({ product_changes: [{ before: '¥179', after: '¥159' }] }), tr)).toBe(PRODUCT.join('\n'));
  });
});
