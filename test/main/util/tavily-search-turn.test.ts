import { describe, expect, it } from 'vitest';
import {
  createTavilySearchTurn, currentTavilySearchTurn, recordTavilySearchRequest,
  withTavilySearchTurn,
} from '../../../src/main/util/tavily-search-turn';

describe('user-turn Tavily search reminders', () => {
  it('shares counts across concurrent descendants and preserves them across actor rebuilds', async () => {
    const turn = createTavilySearchTurn('user-a', 'conversation-a');
    const reminders: number[] = [];
    await withTavilySearchTurn(turn, async () => {
      await Promise.all(Array.from({ length: 16 }, async () => {
        await Promise.resolve();
        expect(currentTavilySearchTurn('user-a', 'conversation-a')).toBe(turn);
        const reminder = recordTavilySearchRequest(turn);
        if (reminder !== undefined) reminders.push(reminder);
      }));
    });
    await withTavilySearchTurn(turn, async () => {
      for (let i = 0; i < 10; i++) {
        const reminder = recordTavilySearchRequest(turn);
        if (reminder !== undefined) reminders.push(reminder);
      }
    });
    expect(reminders).toEqual([10, 15, 20, 25]);
    expect(currentTavilySearchTurn('user-a', 'conversation-a')).toBeUndefined();
  });

  it('isolates a later user message and foreign owners while an earlier turn is still running', async () => {
    const old = createTavilySearchTurn('user-a', 'conversation-a');
    const next = createTavilySearchTurn('user-a', 'conversation-a');
    await withTavilySearchTurn(old, async () => {
      for (let i = 0; i < 9; i++) expect(recordTavilySearchRequest(old)).toBeUndefined();
      expect(currentTavilySearchTurn('user-b', 'conversation-a')).toBeUndefined();
      expect(currentTavilySearchTurn('user-a', 'conversation-b')).toBeUndefined();
      await withTavilySearchTurn(next, async () => {
        expect(recordTavilySearchRequest(next)).toBeUndefined();
        await Promise.resolve();
        expect(currentTavilySearchTurn('user-a', 'conversation-a')).toBe(next);
      });
      expect(currentTavilySearchTurn('user-a', 'conversation-a')).toBe(old);
      expect(recordTavilySearchRequest(old)).toBe(10);
    });
    for (let i = 0; i < 8; i++) expect(recordTavilySearchRequest(next)).toBeUndefined();
    expect(recordTavilySearchRequest(next)).toBe(10);
  });
});
