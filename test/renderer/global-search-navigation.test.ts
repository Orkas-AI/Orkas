import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const searchSource = fs.readFileSync(path.join(root, 'src/renderer/modules/search.js'), 'utf8');
const bootSource = fs.readFileSync(path.join(root, 'src/renderer/modules/boot.js'), 'utf8');
const conversationSource = fs.readFileSync(path.join(root, 'src/renderer/modules/conversation.js'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'src/main/ipc/index.ts'), 'utf8');
const chatsSource = fs.readFileSync(path.join(root, 'src/main/features/chats.ts'), 'utf8');

function extractFunction(source: string, name: string): string {
  const asyncMarker = `async function ${name}`;
  const syncMarker = `function ${name}`;
  const start = source.indexOf(asyncMarker) >= 0
    ? source.indexOf(asyncMarker)
    : source.indexOf(syncMarker);
  if (start < 0) throw new Error(`missing ${name}`);
  const signatureEnd = source.indexOf(') {', start);
  const braceStart = signatureEnd >= 0 ? signatureEnd + 2 : -1;
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

describe('global search conversation navigation', () => {
  it('passes the stable message identity into paged conversation loading', () => {
    expect(searchSource).toContain("msgId: r.msg_id || ''");
    expect(searchSource).toContain('msgIndex: r.msg_index');
    expect(searchSource).toContain('historyTarget: {');
    expect(searchSource).not.toContain('_scrollToMsgIndex');
    expect(bootSource).toContain('{ searchTarget: opts.historyTarget }');
    expect(bootSource).toContain('_revealConversationHistorySearchTarget(cid, opts.historyTarget)');
    expect(ipcSource).toContain('chats.getMessagesPageAtIndex(');
    expect(ipcSource).toContain('history_indexes: page.historyIndexes');
    expect(chatsSource).toContain(
      'readJsonlWindow<MessageRecord>(file, pageStart, Number.MAX_SAFE_INTEGER)',
    );
    const loadStart = conversationSource.indexOf('async function loadConversationHistory');
    const loadBody = conversationSource.slice(loadStart, conversationSource.indexOf('\nfunction _messageRecordHasMountedSidecars', loadStart));
    expect(loadBody).toContain('Array.isArray(data.history_indexes)');
    expect(loadBody).toContain('_history_index: sourceIndex');
    expect(loadBody.indexOf('_revealConversationHistorySearchTarget(cid, opts.searchTarget)')).toBeLessThan(
      loadBody.indexOf('await _evaluateAutoRecipient(cid)'),
    );
  });

  it('keeps normal first paint at 10 rows and requests the target page directly', () => {
    const context: any = {
      Math,
      Number,
      encodeURIComponent,
      HISTORY_PAGE_SIZE: 10,
      _projectIdForConversation: () => 'p1',
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(conversationSource, '_historyRequestUrl'), context);

    expect(context._historyRequestUrl('c1')).toBe(
      '/api/conversations/c1/history?limit=10&project_id=p1',
    );
    expect(context._historyRequestUrl('c1', 120, 100)).toBe(
      '/api/conversations/c1/history?limit=100&before=120&project_id=p1',
    );
    expect(context._historyRequestUrl('c1', null, 10, 23)).toBe(
      '/api/conversations/c1/history?limit=10&around_index=23&project_id=p1',
    );
    expect(conversationSource).not.toContain('HISTORY_SEARCH_PAGE_SIZE');
  });

  it('positions an identity-less legacy target by its global index without catch-up loads', () => {
    const added: string[] = [];
    let olderLoads = 0;
    const container: any = {
      scrollTop: 0,
      clientHeight: 400,
      style: { scrollBehavior: '' },
      getBoundingClientRect: () => ({ top: 0, height: 400 }),
      querySelectorAll: () => [matched],
      querySelector: () => ({ dataset: { state: 'idle', cursor: '100', cid: 'c1' } }),
    };
    const matched = {
      dataset: { msgIndex: '23' },
      classList: {
        contains: () => true,
        add: (name: string) => added.push(name),
        remove: (name: string) => added.push(`removed:${name}`),
      },
      closest: () => container,
      getBoundingClientRect: () => ({ top: 100, height: 50 }),
    };
    const context: any = {
      Array,
      Math,
      Number,
      String,
      HISTORY_AUTO_LOAD_THRESHOLD: 48,
      currentCid: 'c1',
      document: { getElementById: () => container },
      _msTs: () => 0,
      _markProgrammaticStickyScroll: (el: any) => { el._programmatic = true; },
      _isProgrammaticStickyScroll: (el: any) => el._programmatic === true,
      _loadOlderConversationHistory: () => { olderLoads += 1; },
      _historyNextCursor: (value: unknown) => Number(value),
      _setEarlierHistoryLoaderState: () => {},
      requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
      setTimeout: (fn: () => void) => { fn(); return 1; },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(conversationSource, '_findConversationHistorySearchTarget'),
      extractFunction(conversationSource, '_flashConversationHistorySearchTarget'),
      extractFunction(conversationSource, '_revealConversationHistorySearchTarget'),
      extractFunction(conversationSource, '_maybeAutoLoadEarlierHistory'),
    ].join('\n'), context);

    const found = context._revealConversationHistorySearchTarget('c1', {
      msgIndex: 23,
    });
    context._maybeAutoLoadEarlierHistory(container);

    expect(found).toBe(true);
    expect(container.scrollTop).toBe(0);
    expect(container._stickyEnabled).toBe(false);
    expect(olderLoads).toBe(0);
    expect(added).toEqual(['search-flash', 'removed:search-flash']);
    expect(conversationSource).not.toContain("target.scrollIntoView({ block: 'center' })");
  });
});
