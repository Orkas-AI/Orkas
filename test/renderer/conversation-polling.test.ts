import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/state.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('conversation polling cancellation', () => {
  it('discards an in-flight history response after the live stream stops polling', async () => {
    const fetchResult = deferred<any>();
    const callbacks = new Map<number, () => Promise<void>>();
    const recovered: unknown[] = [];
    let nextTimer = 0;

    const context: any = {
      Map,
      Date,
      pollTimers: new Map(),
      pollMsgCounts: new Map([['c1', 1]]),
      setInterval(fn: () => Promise<void>) {
        nextTimer += 1;
        callbacks.set(nextTimer, fn);
        return nextTimer;
      },
      clearInterval(id: number) {
        callbacks.delete(id);
      },
      apiFetch: () => fetchResult.promise,
      isGroupConversationBusy: () => false,
      isConvPending: () => false,
      _isPolledAssistantMsg: (m: any) => !!m && m.from !== 'user',
      _isPolledUserMsg: (m: any) => !!m && m.from === 'user',
      _onPolledResponse: (...args: unknown[]) => recovered.push(args),
      t: (key: string) => key,
      window: { ConversationRuntime: {} },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction('_polledMessageKey'),
      extractFunction('startPolling'),
      extractFunction('stopPolling'),
    ].join('\n'), context);

    context.startPolling('c1');
    const staleTick = callbacks.get(1);
    expect(staleTick).toBeTypeOf('function');
    const pendingTick = staleTick!();

    // This mirrors the normal stream-end cleanup while the polling fetch is
    // still awaiting its history response.
    context.stopPolling('c1');
    fetchResult.resolve({
      json: async () => ({
        ok: true,
        history: [
          { id: 'u1', from: 'user', text: 'question' },
          { id: 'a1', from: 'commander', text: 'answer' },
        ],
        conversation: { processing: false },
      }),
    });
    await pendingTick;

    expect(recovered).toEqual([]);
    expect(context.pollTimers.has('c1')).toBe(false);
  });

  it('does not let an old request act on a newly-started poll for the same conversation', async () => {
    const firstFetch = deferred<any>();
    const callbacks = new Map<number, () => Promise<void>>();
    const recovered: unknown[] = [];
    let nextTimer = 0;
    let fetchCount = 0;

    const context: any = {
      Map,
      Date,
      pollTimers: new Map(),
      pollMsgCounts: new Map([['c1', 1]]),
      setInterval(fn: () => Promise<void>) {
        nextTimer += 1;
        callbacks.set(nextTimer, fn);
        return nextTimer;
      },
      clearInterval(id: number) {
        callbacks.delete(id);
      },
      apiFetch: () => {
        fetchCount += 1;
        return fetchCount === 1 ? firstFetch.promise : Promise.reject(new Error('not used'));
      },
      isGroupConversationBusy: () => false,
      isConvPending: () => false,
      _isPolledAssistantMsg: (m: any) => !!m && m.from !== 'user',
      _isPolledUserMsg: (m: any) => !!m && m.from === 'user',
      _onPolledResponse: (...args: unknown[]) => recovered.push(args),
      t: (key: string) => key,
      window: { ConversationRuntime: {} },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction('_polledMessageKey'),
      extractFunction('startPolling'),
      extractFunction('stopPolling'),
    ].join('\n'), context);

    context.startPolling('c1');
    const oldTick = callbacks.get(1)!();
    context.stopPolling('c1');
    context.startPolling('c1');
    expect(context.pollTimers.get('c1')).toBe(2);

    firstFetch.resolve({
      json: async () => ({
        ok: true,
        history: [
          { id: 'u1', from: 'user', text: 'question' },
          { id: 'a1', from: 'commander', text: 'answer' },
        ],
        conversation: { processing: false },
      }),
    });
    await oldTick;

    expect(recovered).toEqual([]);
    expect(context.pollTimers.get('c1')).toBe(2);
  });
});
