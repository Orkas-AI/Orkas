import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetRuntimeContentPublishForTests,
  _runtimeContentPublishState,
  enterRuntimeContentTurn,
  withIdleRuntimePublish,
} from '../../../src/main/features/runtime_content_publish';

afterEach(() => {
  _resetRuntimeContentPublishForTests();
});

describe('runtime content publication', () => {
  it('publishes from the active-turn release event without polling', async () => {
    const releaseTurn = await enterRuntimeContentTurn('u1');
    let published = false;
    const publication = withIdleRuntimePublish('u1', async () => {
      published = true;
    });

    await Promise.resolve();
    expect(published).toBe(false);
    expect(_runtimeContentPublishState('u1')).toEqual({
      activeTurns: 1,
      waitingTurns: 0,
      publishing: false,
      queued: 1,
    });

    releaseTurn();
    await publication;
    expect(published).toBe(true);
    expect(_runtimeContentPublishState('u1')).toEqual({
      activeTurns: 0,
      waitingTurns: 0,
      publishing: false,
      queued: 0,
    });
  });

  it('waits for the last active turn and holds a new turn during final publication', async () => {
    const releaseFirst = await enterRuntimeContentTurn('u1');
    const releaseSecond = await enterRuntimeContentTurn('u1');
    let releasePublish!: () => void;
    let markPublishStarted!: () => void;
    const publishStarted = new Promise<void>((resolve) => { markPublishStarted = resolve; });
    const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
    const publication = withIdleRuntimePublish('u1', async () => {
      markPublishStarted();
      await publishGate;
    });

    releaseFirst();
    await Promise.resolve();
    expect(_runtimeContentPublishState('u1')).toMatchObject({
      activeTurns: 1,
      publishing: false,
      queued: 1,
    });

    releaseSecond();
    await publishStarted;
    let thirdEntered = false;
    const thirdTurn = enterRuntimeContentTurn('u1').then((release) => {
      thirdEntered = true;
      return release;
    });
    await Promise.resolve();
    expect(thirdEntered).toBe(false);
    expect(_runtimeContentPublishState('u1')).toMatchObject({
      activeTurns: 0,
      waitingTurns: 1,
      publishing: true,
    });

    releasePublish();
    await publication;
    const releaseThird = await thirdTurn;
    expect(thirdEntered).toBe(true);
    releaseThird();
  });

  it('continues with the next queued publication after one fails', async () => {
    const first = withIdleRuntimePublish('u1', async () => {
      throw new Error('activation failed');
    });
    let secondPublished = false;
    const second = withIdleRuntimePublish('u1', async () => {
      secondPublished = true;
    });

    await expect(first).rejects.toThrow('activation failed');
    await expect(second).resolves.toBeUndefined();
    expect(secondPublished).toBe(true);

    const releaseTurn = await enterRuntimeContentTurn('u1');
    expect(_runtimeContentPublishState('u1').activeTurns).toBe(1);
    releaseTurn();
  });
});
