import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  embedTexts,
  embedQuery,
  closeEmbedder,
  _setEmbedChannelFactoryForTest,
  type EmbedChannel,
} from '../../../src/main/features/kb_embed';

// A fake worker channel: records posts, lets the test push replies/exit. The
// supervisor's request correlation + crash handling run here WITHOUT Electron
// (the real path is an Electron utilityProcess, exercised only in the app).
class FakeChannel implements EmbedChannel {
  posts: any[] = [];
  killed = false;
  private msgCb: ((m: any) => void) | null = null;
  private exitCb: ((c: number) => void) | null = null;
  // Auto-answer each embed request as if the worker vectorized it (dim=2).
  autoReply = true;

  postMessage(msg: any): void {
    this.posts.push(msg);
    if (this.autoReply && msg && msg.type === 'embed') {
      const vectors = msg.texts.map((_: string, i: number) => [i, i + 1]);
      queueMicrotask(() => this.reply({ id: msg.id, ok: true, vectors }));
    }
  }
  onMessage(cb: (m: any) => void): void { this.msgCb = cb; }
  onExit(cb: (c: number) => void): void { this.exitCb = cb; }
  kill(): void { this.killed = true; }

  reply(msg: any): void { this.msgCb?.(msg); }
  crash(code = 1): void { this.exitCb?.(code); }
}

let channels: FakeChannel[] = [];
let factory: () => FakeChannel;

beforeEach(() => {
  channels = [];
  factory = () => { const c = new FakeChannel(); channels.push(c); return c; };
  _setEmbedChannelFactoryForTest(factory as any);
});
afterEach(() => {
  _setEmbedChannelFactoryForTest(null); // restore real factory + tear down
});

describe('kb_embed supervisor', () => {
  it('empty input never spawns a worker', async () => {
    expect(await embedTexts([])).toEqual([]);
    expect(channels).toHaveLength(0);
  });

  it('correlates concurrent requests by id and reuses one worker', async () => {
    const a = embedTexts(['x', 'y']);
    const b = embedQuery('q');
    expect(await a).toEqual([[0, 1], [1, 2]]);
    expect(await b).toEqual([0, 1]);
    // Both served by the single spawned worker.
    expect(channels).toHaveLength(1);
    expect(channels[0].posts).toHaveLength(2);
  });

  it('rejects when the worker returns fewer vectors than texts', async () => {
    channels = []; factory = () => { const c = new FakeChannel(); c.autoReply = false; channels.push(c); return c; };
    _setEmbedChannelFactoryForTest(factory as any);
    const p = embedTexts(['a', 'b', 'c']);
    await Promise.resolve();
    channels[0].reply({ id: channels[0].posts[0].id, ok: true, vectors: [[1, 1]] });
    await expect(p).rejects.toThrow(/count mismatch/);
  });

  it('a worker crash rejects in-flight embeds; the next call respawns', async () => {
    channels = []; factory = () => { const c = new FakeChannel(); c.autoReply = false; channels.push(c); return c; };
    _setEmbedChannelFactoryForTest(factory as any);

    const p = embedTexts(['a']);
    await Promise.resolve();
    channels[0].crash(139); // SIGSEGV-style native death — no reply
    await expect(p).rejects.toThrow(/exited/);
    expect(channels[0].killed).toBe(true);

    // Next call spawns a fresh worker (crash isolated to the batch, not the app).
    const q = embedTexts(['b']);
    await Promise.resolve();
    expect(channels).toHaveLength(2);
    channels[1].reply({ id: channels[1].posts[0].id, ok: true, vectors: [[0, 1]] });
    expect(await q).toEqual([[0, 1]]);
  });

  it('stops respawning (cooldown) after repeated crashes, then fails fast', async () => {
    channels = []; factory = () => { const c = new FakeChannel(); c.autoReply = false; channels.push(c); return c; };
    _setEmbedChannelFactoryForTest(factory as any);

    // Four crashes in the window trip the cooldown.
    for (let i = 0; i < 4; i += 1) {
      const p = embedTexts(['x']);
      await Promise.resolve();
      channels[channels.length - 1].crash(139);
      await expect(p).rejects.toThrow();
    }
    const spawnedBefore = channels.length;
    // Now embeds fail fast without spawning yet another doomed worker.
    await expect(embedTexts(['x'])).rejects.toThrow(/cooling down/);
    expect(channels.length).toBe(spawnedBefore);
  });

  it('closeEmbedder kills the worker and rejects in-flight embeds', async () => {
    channels = []; factory = () => { const c = new FakeChannel(); c.autoReply = false; channels.push(c); return c; };
    _setEmbedChannelFactoryForTest(factory as any);
    const p = embedTexts(['a']);
    await Promise.resolve();
    closeEmbedder();
    await expect(p).rejects.toThrow(/closed/);
    expect(channels[0].killed).toBe(true);
  });
});
