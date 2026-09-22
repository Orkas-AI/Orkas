import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { cssDeclarationsForSelector, onlyCssDeclarations } from './helpers/css-oracle';

// Scenario: a conversation that belongs to a project shows the project name
// under its title. Clicking (or keyboard-activating) that name must take the
// user to the project page; a conversation without a resolvable project shows
// no such affordance. The sidebar row is the other entry to the same page, so
// the header link must land on the identical `setView('project', pid)` route.

const conversationSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const utilsSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/utils.js'),
  'utf8',
);
const styleSource = readFileSync(resolve(__dirname, '../../src/renderer/style.css'), 'utf8');

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  const end = source.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`unterminated ${name}`);
  return source.slice(start, end + 2);
}

type FakeEl = Record<string, any>;

function makeHeaderDom() {
  const els: Record<string, FakeEl> = {
    'chat-header-title': { textContent: '', hidden: false },
    'chat-header-title-input': { value: '', hidden: true },
    'chat-header-meta': { innerHTML: '' },
    'chat-header-menu-btn': { title: '', setAttribute() {} },
  };
  return {
    els,
    document: {
      getElementById: (id: string) => els[id] || null,
      querySelector: () => null,
      activeElement: null,
    },
  };
}

/** Every `<span …>text</span>` in the meta line as `{ attrs, text }`. */
function metaSpans(html: string): Array<{ attrs: string; text: string }> {
  return [...html.matchAll(/<span([^>]*)>([^<]*)<\/span>/g)].map((m) => ({ attrs: m[1], text: m[2] }));
}

function renderHeaderMeta(opts: {
  conv: Record<string, unknown> | null;
  projectName: string;
}): string {
  const dom = makeHeaderDom();
  const globals = {
    document: dom.document,
    currentCid: 'c1',
    conversations: opts.conv ? [opts.conv] : [],
    _conversationHeaderRenameCid: '',
    t: (key: string) => key,
    getCommanderProjectIdName: (pid: string) => (pid === 'p1' ? opts.projectName : ''),
    _groupMembersCache: new Map(),
    _agentsCache: [],
    _commanderAvatar: () => ({ icon: '', color: '' }),
    renderAvatarHtml: () => '',
  };
  const context = vm.createContext(globals);
  vm.runInContext(extractFunction(utilsSource, 'escapeHtml'), context);
  vm.runInContext(extractFunction(conversationSource, '_refreshChatHeader'), context);
  vm.runInContext('_refreshChatHeader()', context);
  return dom.els['chat-header-meta'].innerHTML;
}

describe('conversation header › project name link', () => {
  it('renders the project name as a keyboard-reachable button carrying the project id', () => {
    const html = renderHeaderMeta({
      conv: { conversation_id: 'c1', title: 'T', project_id: 'p1' },
      projectName: 'Iterate Orkas',
    });
    const link = metaSpans(html).find((s) => s.attrs.includes('data-header-project-id="p1"'));
    expect(link).toBeDefined();
    expect(link!.text).toBe('Iterate Orkas');
    expect(link!.attrs).toContain('role="button"');
    expect(link!.attrs).toContain('tabindex="0"');
    expect(link!.attrs).toContain('chat-header-meta-project-link');
  });

  it('escapes a hostile project name inside the link', () => {
    const html = renderHeaderMeta({
      conv: { conversation_id: 'c1', title: 'T', project_id: 'p1' },
      projectName: '<b>Ops</b> & "x"',
    });
    expect(html).not.toContain('<b>');
    const link = metaSpans(html).find((s) => s.attrs.includes('data-header-project-id="p1"'));
    expect(link!.text).toBe('&lt;b&gt;Ops&lt;/b&gt; &amp; &quot;x&quot;');
  });

  it('shows no project link when the conversation has no project or the project is gone', () => {
    const orphan = renderHeaderMeta({
      conv: { conversation_id: 'c1', title: 'T' },
      projectName: 'Iterate Orkas',
    });
    expect(orphan).not.toContain('data-header-project-id');
    // A just-deleted project resolves to no name: nothing to navigate to.
    const deleted = renderHeaderMeta({
      conv: { conversation_id: 'c1', title: 'T', project_id: 'p1' },
      projectName: '',
    });
    expect(deleted).not.toContain('data-header-project-id');
  });
});

describe('conversation header › project link activation', () => {
  function bindHeader() {
    const meta: FakeEl = {
      dataset: {},
      listeners: {} as Record<string, (e: any) => void>,
      addCalls: 0,
      addEventListener(type: string, fn: (e: any) => void) {
        this.addCalls += 1;
        this.listeners[type] = fn;
      },
    };
    const globals = {
      document: {
        getElementById: (id: string) => (id === 'chat-header-meta' ? meta : null),
        readyState: 'complete',
      },
      window: {},
      currentCid: 'c1',
      setView: vi.fn(),
      _refreshChatHeader: vi.fn(),
    };
    const context = vm.createContext(globals);
    vm.runInContext(extractFunction(conversationSource, '_openChatHeaderProject'), context);
    vm.runInContext(extractFunction(conversationSource, '_bindChatHeaderActions'), context);
    vm.runInContext('_bindChatHeaderActions()', context);
    return { meta, globals, context };
  }

  function eventOn(target: FakeEl | null, extra: Record<string, unknown> = {}) {
    return {
      target: { closest: (sel: string) => (sel === '[data-header-project-id]' ? target : null) },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...extra,
    };
  }
  const link = { dataset: { headerProjectId: 'p1' } };

  it('opens the project page on click and leaves other meta clicks alone', () => {
    const { meta, globals } = bindHeader();
    meta.listeners.click(eventOn(link));
    expect(globals.setView).toHaveBeenCalledExactlyOnceWith('project', 'p1');
    meta.listeners.click(eventOn(null));
    expect(globals.setView).toHaveBeenCalledTimes(1);
  });

  it('activates with Enter or Space but not while an IME composition is open', () => {
    const { meta, globals } = bindHeader();
    meta.listeners.keydown(eventOn(link, { key: 'Enter' }));
    meta.listeners.keydown(eventOn(link, { key: ' ' }));
    expect(globals.setView).toHaveBeenCalledTimes(2);
    meta.listeners.keydown(eventOn(link, { key: 'a' }));
    meta.listeners.keydown(eventOn(link, { key: 'Enter', isComposing: true }));
    meta.listeners.keydown(eventOn(link, { key: 'Enter', keyCode: 229 }));
    expect(globals.setView).toHaveBeenCalledTimes(2);
  });

  it('binds the meta line once even when header binding runs again', () => {
    const { meta, context } = bindHeader();
    vm.runInContext('_bindChatHeaderActions()', context);
    expect(meta.addCalls).toBe(2); // click + keydown, from the first bind only
  });
});

describe('conversation header › project link affordance', () => {
  it('reads as clickable and highlights on hover like the message actor link', () => {
    expect(onlyCssDeclarations(styleSource, '.chat-header-meta-project-link').cursor).toBe('pointer');
    expect(cssDeclarationsForSelector(styleSource, '.chat-header-meta-project-link:hover')).toHaveLength(1);
  });
});
