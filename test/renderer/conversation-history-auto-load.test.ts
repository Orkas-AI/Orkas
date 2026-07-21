import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const styleSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/style.css'),
  'utf8',
);

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = rendererSource.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = rendererSource.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < rendererSource.length; i += 1) {
    const ch = rendererSource[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return rendererSource.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

describe('conversation history auto-load', () => {
  it('triggers the older-page request when the user reaches the top threshold', () => {
    const calls: Array<[string, number]> = [];
    const row = { dataset: { state: 'idle', cursor: '120', cid: 'c1' } };
    const container = {
      scrollTop: 32,
      querySelector: () => row,
    };
    const context: any = {
      Number,
      String,
      currentCid: 'c1',
      HISTORY_AUTO_LOAD_THRESHOLD: 48,
      _isProgrammaticStickyScroll: () => false,
      _loadOlderConversationHistory: (cid: string, cursor: number) => {
        calls.push([cid, cursor]);
        return Promise.resolve();
      },
      _setEarlierHistoryLoaderState: () => {},
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction('_historyNextCursor'),
      extractFunction('_maybeAutoLoadEarlierHistory'),
    ].join('\n'), context);

    context._maybeAutoLoadEarlierHistory(container);

    expect(calls).toEqual([['c1', 120]]);
  });

  it('does not auto-load during a programmatic scroll or away from the top', () => {
    let calls = 0;
    const row = { dataset: { state: 'idle', cursor: '120', cid: 'c1' } };
    const context: any = {
      Number,
      String,
      currentCid: 'c1',
      HISTORY_AUTO_LOAD_THRESHOLD: 48,
      _isProgrammaticStickyScroll: () => true,
      _loadOlderConversationHistory: () => { calls += 1; },
      _setEarlierHistoryLoaderState: () => {},
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction('_historyNextCursor'),
      extractFunction('_maybeAutoLoadEarlierHistory'),
    ].join('\n'), context);

    context._maybeAutoLoadEarlierHistory({ scrollTop: 12, querySelector: () => row });
    context._isProgrammaticStickyScroll = () => false;
    context._maybeAutoLoadEarlierHistory({ scrollTop: 80, querySelector: () => row });

    expect(calls).toBe(0);
  });

  it('keeps the previous reading anchor after prepending older content', () => {
    const context: any = { Number, Math };
    vm.createContext(context);
    vm.runInContext(extractFunction('_olderHistoryPrependTop'), context);

    expect(context._olderHistoryPrependTop(0, 800, 1280)).toBe(480);
    expect(context._olderHistoryPrependTop(24, 800, 1280)).toBe(504);
    expect(context._olderHistoryPrependTop(0, 800, 760)).toBe(0);
  });

  it('keeps the sentinel first and advances across internal-only raw pages', () => {
    const start = rendererSource.indexOf('async function _loadOlderConversationHistory');
    const end = rendererSource.indexOf('\nfunction _ensureCreateAgentInlineObserver', start);
    const body = rendererSource.slice(start, end);

    expect(body).toContain('while (cursor !== null && page.length === 0)');
    expect(body).toContain('_isVisibleGroupHistoryRecord(gm)');
    expect(body).toContain('container.insertBefore(fragment, row.nextSibling)');
    expect(body).not.toContain('container.insertBefore(fragment, row);');
  });

  it('uses an inline loading view instead of a clickable history button', () => {
    const start = rendererSource.indexOf('function _setLoadEarlierHistory');
    const end = rendererSource.indexOf('\nasync function _loadOlderConversationHistory', start);
    const body = rendererSource.slice(start, end);

    expect(body).toContain("_setEarlierHistoryLoaderState(row, 'idle')");
    expect(body).toContain('container.insertBefore(row, container.firstChild)');
    expect(body).toContain('_bindAutoLoadEarlierHistory(container)');
    expect(body).not.toContain('button.onclick');
    expect(styleSource).toContain('.chat-history-load-earlier.is-loading');
    expect(styleSource).toContain('.chat-history-inline-spinner');
  });
});
