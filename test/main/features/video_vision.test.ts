import { describe, expect, it, vi } from 'vitest';

import {
  analyzeFrames,
  interpretVisionResponse,
  selectFrames,
  resolveVisionRoute,
  NO_VISION_SENTINEL,
  type LoadedImage,
} from '../../../src/main/features/video_vision';

const okRes = (text: string) => ({ ok: true, text, error: '', aborted: false });

// Injected frame loader — returns one dummy decoded image per path, so the
// orchestration test never depends on real jimp image encoding.
const fakeLoader = (paths: string[]): Promise<LoadedImage[]> =>
  Promise.resolve(paths.map(() => ({ data: 'ZmFrZQ==', mediaType: 'image/jpeg' as const })));

describe('selectFrames', () => {
  it('caps to the default, de-dupes, and preserves order', () => {
    expect(selectFrames(['a', 'b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
  });
  it('honors a custom cap and the hard ceiling', () => {
    expect(selectFrames(['a', 'b', 'c', 'd'], 2)).toEqual(['a', 'b']);
    const many = Array.from({ length: 40 }, (_, i) => `f${i}`);
    expect(selectFrames(many, 99).length).toBe(16); // HARD_MAX_FRAMES
  });
  it('drops blanks', () => {
    expect(selectFrames(['', '  ', 'x'])).toEqual(['x']);
  });
});

describe('interpretVisionResponse — degrade policy', () => {
  it('maps an aborted call to reason=aborted', () => {
    const r = interpretVisionResponse({ ok: false, text: '', error: 'stop', aborted: true }, 2, 'agent-model');
    expect(r).toEqual({ ok: false, reason: 'aborted', message: 'stop' });
  });
  it('maps a failed call to reason=error', () => {
    const r = interpretVisionResponse({ ok: false, text: '', error: 'boom', aborted: false }, 2, 'agent-model');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('error');
  });
  it('maps an empty answer to no-vision', () => {
    const r = interpretVisionResponse(okRes('   '), 1, 'agent-model');
    if (!r.ok) expect(r.reason).toBe('no-vision');
    else throw new Error('expected degrade');
  });
  it('treats the NO_VISION sentinel (and prefixed variants) as no-vision', () => {
    for (const t of [NO_VISION_SENTINEL, 'no_vision', 'NO_VISION. cannot see', 'NO_VISION\nsorry']) {
      const r = interpretVisionResponse(okRes(t), 1, 'agent-model');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('no-vision');
    }
  });
  it('does NOT misfire when NO_VISION appears mid-sentence', () => {
    const r = interpretVisionResponse(okRes('There is no_vision problem; the frame is sharp.'), 1, 'agent-model');
    expect(r.ok).toBe(true);
  });
  it('passes a real answer through with route + frame count', () => {
    const r = interpretVisionResponse(okRes('A red car turning left.'), 3, 'agent-model');
    expect(r).toEqual({ ok: true, route: 'agent-model', text: 'A red car turning left.', framesUsed: 3 });
  });
});

describe('resolveVisionRoute', () => {
  it('routes to the agent/configured model today (VLM profile not yet wired)', () => {
    expect(resolveVisionRoute('u1')).toBe('agent-model');
  });
});

describe('analyzeFrames — orchestration', () => {
  it('degrades to no-frames when no paths are supplied (no model call)', async () => {
    const chat = vi.fn();
    const r = await analyzeFrames({ userId: 'u1', framePaths: [], question: 'what?', chat: chat as never });
    expect(r).toEqual({ ok: false, reason: 'no-frames', message: 'no frame paths supplied' });
    expect(chat).not.toHaveBeenCalled();
  });

  it('loads frames, forwards them as images to the model, and returns the answer', async () => {
    const chat = vi.fn(async (opts: { images?: unknown[] }) => {
      expect(Array.isArray(opts.images)).toBe(true);
      expect(opts.images?.length).toBe(2);
      return okRes('Two frames of a red car.');
    });
    const r = await analyzeFrames({
      userId: 'u1', framePaths: ['a.png', 'b.png'], question: 'describe',
      chat: chat as never, loadFrames: fakeLoader,
    });
    expect(r).toEqual({ ok: true, route: 'agent-model', text: 'Two frames of a red car.', framesUsed: 2 });
    expect(chat).toHaveBeenCalledOnce();
  });

  it('degrades to no-frames when every frame fails to load', async () => {
    const chat = vi.fn();
    const r = await analyzeFrames({
      userId: 'u1', framePaths: ['a.png'], question: 'describe',
      chat: chat as never, loadFrames: async () => [],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-frames');
    expect(chat).not.toHaveBeenCalled();
  });

  it('degrades when the model reports it cannot see', async () => {
    const chat = vi.fn(async () => okRes(NO_VISION_SENTINEL));
    const r = await analyzeFrames({
      userId: 'u1', framePaths: ['a.png'], question: 'describe',
      chat: chat as never, loadFrames: fakeLoader,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-vision');
  });

  it('degrades when the model call throws', async () => {
    const chat = vi.fn(async () => { throw new Error('provider 500'); });
    const r = await analyzeFrames({
      userId: 'u1', framePaths: ['a.png'], question: 'describe',
      chat: chat as never, loadFrames: fakeLoader,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('error');
  });
});
