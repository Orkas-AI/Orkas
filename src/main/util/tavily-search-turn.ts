import { AsyncLocalStorage } from 'node:async_hooks';

/** Memory-only user-turn state. Queue items retain this reference so delayed
 * descendants cannot adopt a later user message's counter. No queries are kept. */
export interface TavilySearchTurn {
  readonly userId: string;
  readonly cid: string;
  requests: number;
}

const activeTurn = new AsyncLocalStorage<TavilySearchTurn>();

export function createTavilySearchTurn(userId: string, cid: string): TavilySearchTurn {
  return { userId, cid, requests: 0 };
}

export function currentTavilySearchTurn(userId: string, cid: string): TavilySearchTurn | undefined {
  const turn = activeTurn.getStore();
  return turn?.userId === userId && turn.cid === cid ? turn : undefined;
}

export function withTavilySearchTurn<T>(turn: TavilySearchTurn, run: () => T): T {
  return activeTurn.run(turn, run);
}

/** Called synchronously once per admitted web_search tool invocation, across
 * providers and keyless search, including failed calls.
 * Each crossing belongs to its issuing tool result; nothing rejects a request. */
export function recordTavilySearchRequest(turn: TavilySearchTurn): number | undefined {
  const count = ++turn.requests;
  return count >= 10 && count % 5 === 0 ? count : undefined;
}
