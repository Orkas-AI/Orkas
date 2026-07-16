import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const pcSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
const pcStyle = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');

function extractFunction(source: string, name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
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

function loadQuoteRuntime(source = pcSource) {
  const functionNames = [
    '_quoteIdentity',
    '_addQuote',
    '_removeQuoteAt',
    '_getQuotes',
    '_clearQuotes',
    'applyQuotePrefix',
  ];
  const context: any = {
    currentCid: 'conversation-a',
    Map,
    JSON,
    String,
    Number,
    Array,
    t: (key: string) => key === 'chat.quote_files_label' ? 'Attached files:' : key,
  };
  vm.createContext(context);
  vm.runInContext(`
    const _quotesByCid = new Map();
    function _renderQuotePreview() {}
    ${functionNames.map((name) => extractFunction(source, name)).join('\n')}
  `, context);
  return context;
}

function loadQuoteAttributionRuntime() {
  const context: any = {
    String,
    t: (key: string, values: Record<string, string>) => {
      if (key === 'chat.quote_from') return `Quoted from ${values.name}`;
      if (key === 'chat.reference_from_task') return `From ${values.title} · ${values.name}`;
      return key;
    },
  };
  vm.createContext(context);
  vm.runInContext(`
    function _referenceDisplayName(ref) { return ref.fromName || 'Unknown'; }
    function _conversationTitleForCid(cid) { return 'Title for ' + cid; }
    ${extractFunction(pcSource, '_quotePreviewAttribution')}
  `, context);
  return context;
}

describe('conversation multi-message quote', () => {
  it('appends distinct messages in selection order and dedupes the same message id', () => {
    const context = loadQuoteRuntime();
    vm.runInContext(`
      __first = _addQuote('conversation-a', { msgId: 'm1', fromActor: 'writer', text: 'First', produced: [] });
      __duplicate = _addQuote('conversation-a', { msgId: 'm1', fromActor: 'writer', text: 'Changed', produced: [] });
      __second = _addQuote('conversation-a', { msgId: 'm2', fromActor: 'reviewer', text: 'Second', produced: [] });
      __quotes = _getQuotes('conversation-a').map((quote) => ({ msgId: quote.msgId, text: quote.text }));
    `, context);

    expect(context.__first).toBe(true);
    expect(context.__duplicate).toBe(false);
    expect(context.__second).toBe(true);
    expect(context.__quotes).toEqual([
      { msgId: 'm1', text: 'First' },
      { msgId: 'm2', text: 'Second' },
    ]);
  });

  it('removes one quote without clearing the others and keeps conversations isolated', () => {
    const context = loadQuoteRuntime();
    vm.runInContext(`
      _addQuote('conversation-a', { msgId: 'm1', text: 'First' });
      _addQuote('conversation-a', { msgId: 'm2', text: 'Second' });
      _addQuote('conversation-b', { msgId: 'm3', text: 'Other conversation' });
      _removeQuoteAt('conversation-a', 0);
      __a = _getQuotes('conversation-a').map((quote) => quote.msgId);
      __b = _getQuotes('conversation-b').map((quote) => quote.msgId);
    `, context);

    expect(context.__a).toEqual(['m2']);
    expect(context.__b).toEqual(['m3']);
  });

  it('serializes every quote as routing-safe markdown before the typed reply', () => {
    const context = loadQuoteRuntime();
    vm.runInContext(`
      _addQuote('conversation-a', { msgId: 'm1', text: 'First line\\nmentions @writer', produced: [] });
      _addQuote('conversation-a', { msgId: 'm2', text: 'Second', produced: ['/tmp/report.md'] });
      __content = applyQuotePrefix('@reviewer compare these', 'conversation');
    `, context);

    expect(context.__content).toBe([
      '> First line',
      '> mentions @writer',
      '',
      '> Second',
      '>',
      '> Attached files:',
      '> - `/tmp/report.md`',
      '',
      '@reviewer compare these',
    ].join('\n'));
  });

  it('shows a task title only when the quote comes from another task', () => {
    const context = loadQuoteAttributionRuntime();
    vm.runInContext(`
      __sameTask = _quotePreviewAttribution({
        sourceCid: 'conversation-a',
        sourceTitle: 'Current task',
        fromName: 'User',
      }, 'conversation-a');
      __crossTask = _quotePreviewAttribution({
        sourceCid: 'conversation-a',
        sourceTitle: 'Source task',
        fromName: 'User',
      }, 'conversation-b');
      __legacySameTask = _quotePreviewAttribution({ fromName: 'User' }, 'conversation-a');
    `, context);

    expect(context.__sameTask).toBe('Quoted from User');
    expect(context.__crossTask).toBe('From Source task · User');
    expect(context.__legacySameTask).toBe('Quoted from User');
  });

  it('keeps the desktop multi-quote state and layout contract', () => {
    expect(pcSource).toContain('const _quotesByCid = new Map()');
    expect(pcSource).toContain('function _addQuote(cid, payload)');
    expect(pcSource).toContain('function _removeQuoteAt(cid, index)');
    expect(pcSource).toContain("const block = blocks.join('\\n\\n');");
    expect(pcSource).not.toContain('const _quoteByCid = new Map()');
    expect(pcStyle).toContain('.chat-quote-preview .chat-quote-item');
    expect(pcStyle).toContain('max-height: min(280px, 34vh);');
    expect(pcStyle).toContain('overflow-y: auto;');
  });
});
