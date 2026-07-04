import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

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

  constructor(public label: string, className: string, dataset: Record<string, string> = {}) {
    this.classList = new FakeClassList(className);
    this.dataset = { ...dataset };
  }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return idx > 0 ? this.parentElement.children[idx - 1] : null;
  }
}

class FakeHistory {
  children: FakeElement[] = [];

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
