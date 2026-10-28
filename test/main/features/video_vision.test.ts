import { getEventListeners } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  analyzeFrames,
  interpretVisionResponse,
  selectFrames,
  resolveVisionRoute,
  NO_VISION_SENTINEL,
  type LoadedImage,
} from '../../../src/main/features/video_vision';

const visionWarnings = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/logger', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/main/logger')>();
  return { ...actual, createLogger: (name: string) => {
    const logger = actual.createLogger(name);
    return name === 'video-vision' ? { ...logger, warn: visionWarnings } : logger;
  } };
});

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
  it.each([false, true])('preserves caller cancellation (already aborted=%s)', async alreadyAborted => {
    const caller = new AbortController();
    if (alreadyAborted) caller.abort();
    const chat = vi.fn((options: { abortSignal?: AbortSignal }) => new Promise(resolve => {
      const finish = () => resolve({ ok: false, text: '', error: 'cancelled', aborted: true });
      if (options.abortSignal?.aborted) finish();
      else options.abortSignal?.addEventListener('abort', finish, { once: true });
    }));
    const pending = analyzeFrames({
      userId: 'u1', framePaths: ['frame.png'], question: 'describe', signal: caller.signal,
      loadFrames: fakeLoader, chat: chat as never,
    });
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
    caller.abort();
    expect(await pending).toMatchObject({ ok: false, reason: 'aborted' });
    expect(chat.mock.calls[0][0].abortSignal?.aborted).toBe(true);
    expect(getEventListeners(caller.signal, 'abort')).toEqual([]);
  });

  it.each(['success', 'failure', 'timeout'] as const)('releases its caller abort listener after %s without removing other listeners', async outcome => {
    const caller = new AbortController();
    const otherListener = vi.fn();
    caller.signal.addEventListener('abort', otherListener);
    const chat = vi.fn(() => outcome === 'timeout'
      ? new Promise<ReturnType<typeof okRes>>(() => {})
      : Promise.resolve(outcome === 'success' ? okRes('Visible frame')
        : { ok: false, text: '', error: 'controlled failure', aborted: false }));
    if (outcome === 'timeout') vi.useFakeTimers();
    try {
      const pending = analyzeFrames({
        userId: 'u1', framePaths: ['frame.png'], question: 'describe', signal: caller.signal,
        loadFrames: fakeLoader, chat: chat as never,
      });
      if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(180_000);
      const result = await pending;
      expect(result).toMatchObject(outcome === 'success' ? { ok: true }
        : { ok: false, reason: outcome === 'timeout' ? 'aborted' : 'error' });
      expect(chat).toHaveBeenCalledOnce();
      expect(getEventListeners(caller.signal, 'abort')).toEqual([otherListener]);
      caller.abort();
      expect(otherListener).toHaveBeenCalledOnce();
      if (outcome === 'timeout') expect(vi.getTimerCount()).toBe(0);
    } finally {
      caller.signal.removeEventListener('abort', otherListener);
      if (outcome === 'timeout') vi.useRealTimers();
    }
  });

  it.each(['frame', 'provider'] as const)('keeps private %s failure details out of the logger boundary', async failure => {
    visionWarnings.mockClear();
    const privateDetail = failure === 'frame'
      ? join(tmpdir(), 'private-client-document', 'unpublished-frame.png')
      : 'Private provider diagnostic with user request content';
    const chat = vi.fn(async () => { throw new Error(privateDetail); });
    const result = await analyzeFrames({
      userId: 'u1', framePaths: [privateDetail], question: 'describe', chat: chat as never,
      ...(failure === 'provider' ? { loadFrames: fakeLoader } : {}),
    });
    expect(result).toMatchObject({ ok: false, reason: failure === 'frame' ? 'no-frames' : 'error' });
    expect(chat).toHaveBeenCalledTimes(failure === 'frame' ? 0 : 1);
    expect(visionWarnings).toHaveBeenCalledOnce();
    const diagnostic = visionWarnings.mock.calls[0];
    expect(JSON.stringify(diagnostic)).not.toContain(privateDetail);
    expect(diagnostic[0]).toBe(failure === 'frame' ? 'frame load failed' : 'frame analysis degraded');
    expect(diagnostic[1].error).toMatchObject({ message_hash: expect.stringMatching(/^[a-f0-9]{12}$/) });
    if (failure === 'frame') expect(diagnostic[1].frame).toMatchObject({ path_hash: expect.stringMatching(/^[a-f0-9]{12}$/) });
  });

  it('preserves color through the real frame loader into model input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orkas-frame-color-'));
    try {
      const { Jimp } = await import('jimp' as any);
      const frame = new Jimp({ width: 80, height: 60, color: 0xDC1E1EFF });
      const path = join(dir, 'frame.png');
      await writeFile(path, await frame.getBuffer('image/png'));
      const chat = vi.fn(async (_opts: { images?: LoadedImage[] }) => okRes('A red frame.'));
      const result = await analyzeFrames({
        userId: 'u1', framePaths: [path], question: 'describe', chat: chat as never,
      });
      expect(result).toMatchObject({ ok: true, framesUsed: 1 });
      const options = chat.mock.calls[0][0];
      const decoded = await Jimp.read(Buffer.from(options.images![0].data, 'base64'));
      const px = decoded.getPixelColor(40, 30);
      expect((px >>> 24) & 0xff).toBeGreaterThan(200);
      expect((px >>> 16) & 0xff).toBeLessThan(45);
      expect((px >>> 8) & 0xff).toBeLessThan(45);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

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
