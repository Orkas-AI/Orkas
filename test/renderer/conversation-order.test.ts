import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

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

class FakeClassList {
  private classes: Set<string>;

  constructor(className: string) {
    this.classes = new Set(className.split(/\s+/).filter(Boolean));
  }

  contains(name: string) {
    return this.classes.has(name);
  }
}

class FakeElement {
  dataset: Record<string, string> = {};
  classList: FakeClassList;
  parentElement: FakeHistory | null = null;
  style = {};
  querySelector() { return null; }
  matches(selector: string) { return selector === '.chat-message[data-ts]' && this.dataset.ts != null; }

  constructor(public label: string, className: string, dataset: Record<string, string> = {}) {
    this.classList = new FakeClassList(className);
    this.dataset = { ...dataset };
  }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return idx > 0 ? this.parentElement.children[idx - 1] : null;
  }

  get nextElementSibling(): FakeElement | null {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return this.parentElement.children[idx + 1] || null;
  }
}

class FakeHistory {
  children: FakeElement[] = [];
  scrollTop = 123;
  style = { removeProperty() {} };

  querySelector(selector: string) {
    const id = selector.match(/data-msg-id="([^"]+)"/)?.[1];
    return id ? this.children.find(el => el.dataset.msgId === id) || null : null;
  }

  querySelectorAll() { return this.children.filter(el => el.dataset.ts != null); }
  appendChild(el: FakeElement) { this.insertBefore(el, null); }

  append(label: string, className: string, dataset: Record<string, string> = {}) {
    const el = new FakeElement(label, className, dataset);
    el.parentElement = this;
    this.children.push(el);
    return el;
  }

  insertBefore(el: FakeElement, ref: FakeElement | null) {
    const oldIdx = this.children.indexOf(el);
    if (oldIdx >= 0) this.children.splice(oldIdx, 1);
    const refIdx = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(refIdx >= 0 ? refIdx : this.children.length, 0, el);
    el.parentElement = this;
  }

  labels() {
    return this.children.map((el) => el.label);
  }
}

function loadSnapshotOrdering(history: FakeHistory, row: FakeElement) {
  const parsed = ts.createSourceFile('conversation.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set(['_restoreLiveDisplaySnapshot', '_restoreStreamingMessageActivityPosition',
    '_insertByTimestamp', '_appendBeforeSpacer', '_nextChatMessage', '_isChatMessageEl',
    '_hasChatMessageClass', '_isLivePlaceholderMessage', '_anchorPlaceholderToTurnStart',
    '_isTimestampPositionCorrect']);
  const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node)
    && names.has(node.name?.text || '')).map(node => node.getText(parsed)).join('\n');
  const context: any = {
    currentCid: 'c1', CSS: { escape: (s: string) => s },
    formatTime: (s: string) => s,
    _turnHasEndedRow: () => false, _unpersistedTurnRows: () => [row],
    _cancelPendingStreamRaf() {}, _phKey: (...parts: string[]) => parts.join('|'),
    _groupPlaceholders: new Map(), _absorbedTurnSegments: new Map(),
    _isFoldableSegmentActor: () => true, _rowSegmentIndex: () => 0,
    _stampRenderKey(el: FakeElement, _cid: string, key: string) { el.dataset.renderKey = key; },
    _segmentRenderKey: (turn: string, seg: number) => `s:${turn}:${seg}`,
    _replayPersistedProcessItems() {}, _streamingAppendFinalDelta() {},
    _markProgrammaticStickyScroll() {}, pendingConvs: new Map(),
    _liveDisplayWatermarks: new Map(), _offViewLiveDisplayDirty: new Set(),
    document: { getElementById: () => history },
  };
  vm.createContext(context);
  vm.runInContext(functions, context);
  return {
    restore: (afterMessageId?: string) => context._restoreLiveDisplaySnapshot('c1', {
      sequence: 4, turns: [{ actor: 'codex', turn_id: 'turn', activity_after_message_id: afterMessageId,
        records: [{ seg: 0, text: 'Recovered output', process: [] }] }],
    }),
    reanchor: (startedAt: number) => context._anchorPlaceholderToTurnStart(row, startedAt),
  };
}

function loadMoveHelper(): (container: FakeHistory, userEl: FakeElement) => boolean {
  const fns = [
    '_isChatMessageEl',
    '_hasChatMessageClass',
    '_previousChatMessage',
    '_isLivePlaceholderMessage',
    '_placeholderBlockHasTriggerUser',
    '_moveUserBeforeOrphanLivePlaceholder',
  ].map(extractFunction).join('\n');
  return vm.runInNewContext(`${fns}\n_moveUserBeforeOrphanLivePlaceholder;`, {});
}

describe('conversation message ordering', () => {
  it.each([1000, 2300])('restores output after the updates it followed while retaining a newer same-second user below it (start=%s)', startedAt => {
    const history = new FakeHistory();
    history.append('original', 'chat-message user', { ts: '900', msgId: 'original' });
    const row = history.append('reply', 'chat-message assistant', {
      ts: String(startedAt), placeholder: '1', renderKey: 's:turn:0',
    });
    history.append('update-1', 'chat-message user', { ts: '2000', msgId: 'update-1' });
    history.append('update-2', 'chat-message user', { ts: '2000', msgId: 'update-2' });
    history.append('not-yet-followed', 'chat-message user', { ts: '2000', msgId: 'newer' });
    const { restore, reanchor } = loadSnapshotOrdering(history, row);
    restore('update-2');
    expect(history.labels()).toEqual(['original', 'update-1', 'update-2', 'reply', 'not-yet-followed']);
    reanchor(startedAt);
    expect(history.labels()).toEqual(['original', 'update-1', 'update-2', 'reply', 'not-yet-followed']);
    expect(history.scrollTop).toBe(123);
    // Repeated foreground recovery does not change order or promote the
    // recovered old content across a user message received after that content.
    restore('update-2');
    expect(history.labels()).toEqual(['original', 'update-1', 'update-2', 'reply', 'not-yet-followed']);
    expect(row.dataset.activitySortAfter).toBe('2000');
  });

  it.each([undefined, 'not-in-page', 'original'])('keeps an earlier reply in place without a newer recovered user boundary: %s', afterId => {
    const history = new FakeHistory();
    history.append('original', 'chat-message user', { ts: '900', msgId: 'original' });
    const row = history.append('reply', 'chat-message assistant', {
      ts: '1000', placeholder: '1', renderKey: 's:turn:0',
    });
    history.append('newer', 'chat-message user', { ts: '1000', msgId: 'newer' });
    loadSnapshotOrdering(history, row).restore(afterId);
    expect(history.labels()).toEqual(['original', 'reply', 'newer']);
  });

  it('places a late-rendered user message before an orphan live placeholder', () => {
    const move = loadMoveHelper();
    const history = new FakeHistory();
    history.append('previous-assistant', 'chat-message assistant', { finalized: '1' });
    history.append('thinking', 'chat-message assistant', { placeholder: '1', ts: '1000' });
    const user = history.append('user', 'chat-message user', { ts: '900' });

    expect(move(history, user)).toBe(true);
    expect(history.labels()).toEqual(['previous-assistant', 'user', 'thinking']);
  });

  it('does not move a queued user above the placeholder for an earlier user turn', () => {
    const move = loadMoveHelper();
    const history = new FakeHistory();
    history.append('trigger-user', 'chat-message user');
    history.append('thinking', 'chat-message assistant', { placeholder: '1' });
    const queued = history.append('queued-user', 'chat-message user');

    expect(move(history, queued)).toBe(false);
    expect(history.labels()).toEqual(['trigger-user', 'thinking', 'queued-user']);
  });

  it('keeps a reconciled optimistic user before its own live placeholder', () => {
    const move = loadMoveHelper();
    const history = new FakeHistory();
    history.append('previous-assistant', 'chat-message assistant', { finalized: '1' });
    history.append('thinking', 'chat-message assistant', {
      placeholder: '1',
      ts: '1000',
      convPair: 'send-1',
    });
    const user = history.append('user', 'chat-message user', {
      ts: '1100',
      convPair: 'send-1',
    });

    expect(move(history, user)).toBe(true);
    expect(history.labels()).toEqual(['previous-assistant', 'user', 'thinking']);
  });

  it('keeps the paired user above its placeholder even after earlier unanswered users', () => {
    const move = loadMoveHelper();
    const history = new FakeHistory();
    history.append('previous-user', 'chat-message user', { ts: '800' });
    history.append('thinking', 'chat-message assistant', {
      placeholder: '1',
      ts: '1000',
      convPair: 'send-2',
    });
    const user = history.append('current-user', 'chat-message user', {
      ts: '1100',
      convPair: 'send-2',
    });

    expect(move(history, user)).toBe(true);
    expect(history.labels()).toEqual(['previous-user', 'current-user', 'thinking']);
  });

  it('keeps a persisted user above the placeholder triggered by its message id', () => {
    const move = loadMoveHelper();
    const history = new FakeHistory();
    history.append('previous-user', 'chat-message user', { ts: '800', msgId: 'msg-1' });
    history.append('thinking', 'chat-message assistant', {
      placeholder: '1',
      ts: '1000',
      triggerMsgId: 'msg-2',
    });
    const user = history.append('current-user', 'chat-message user', {
      ts: '2000',
      msgId: 'msg-2',
    });

    expect(move(history, user)).toBe(true);
    expect(history.labels()).toEqual(['previous-user', 'current-user', 'thinking']);
  });

  it('does not move a persisted user above another message id placeholder', () => {
    const move = loadMoveHelper();
    const history = new FakeHistory();
    history.append('previous-user', 'chat-message user', { ts: '800', msgId: 'msg-1' });
    history.append('thinking', 'chat-message assistant', {
      placeholder: '1',
      ts: '1000',
      triggerMsgId: 'msg-1',
    });
    const user = history.append('later-user', 'chat-message user', {
      ts: '900',
      msgId: 'msg-2',
    });

    expect(move(history, user)).toBe(false);
    expect(history.labels()).toEqual(['previous-user', 'thinking', 'later-user']);
  });

  it('does not move a later user above an unrelated live placeholder', () => {
    const move = loadMoveHelper();
    const history = new FakeHistory();
    history.append('previous-assistant', 'chat-message assistant', { finalized: '1' });
    history.append('thinking', 'chat-message assistant', { placeholder: '1', ts: '1000' });
    const laterUser = history.append('later-user', 'chat-message user', { ts: '1100' });

    expect(move(history, laterUser)).toBe(false);
    expect(history.labels()).toEqual(['previous-assistant', 'thinking', 'later-user']);
  });
});
