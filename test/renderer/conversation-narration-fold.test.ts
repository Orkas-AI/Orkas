import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

/**
 * Narration folding (2026-09-18).
 *
 * An external-CLI turn narrates every tool loop, so one turn can carry dozens
 * of segments — a 16-minute task produced 62, and the 61 narration blocks
 * filled 95% of the bubble. All but the last couple fold behind one line.
 * Folding is presentation only: every block stays in the DOM and in
 * `row._narration`, so quoting, copying and search keep working.
 *
 * The keyed-rendering harness deliberately stubs `.chat-bubble`, so the fold
 * path is inert there. This file mounts a DOM complete enough to execute it.
 */

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const VIEW_MODEL_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation-view-model.js'),
  'utf8',
);

class El {
  className = '';
  dataset: Record<string, string> = {};
  children: El[] = [];
  parentElement: El | null = null;
  textContent = '';
  innerHTML = '';
  style: Record<string, string> = {};
  private attrs: Record<string, string> = {};
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  classList = {
    add: (name: string) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      set.add(name);
      this.className = [...set].join(' ');
    },
    remove: (name: string) => {
      this.className = this.className.split(/\s+/).filter((n) => n && n !== name).join(' ');
    },
    contains: (name: string) => this.className.split(/\s+/).includes(name),
  };

  appendChild(child: El) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child: El, ref: El | null) {
    child.parentElement = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at >= 0) this.children.splice(at, 0, child);
    else this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }

  get firstChild() { return this.children[0] || null; }

  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  click() {
    for (const fn of this.listeners.click || []) {
      fn({ preventDefault() {}, stopPropagation() {} });
    }
  }

  private descendants(): El[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }

  querySelectorAll(selector: string): El[] {
    const cls = selector.replace(/^\./, '').replace(/\[.*$/, '');
    const segMatch = selector.match(/data-narration-seg="([^"]+)"/);
    return this.descendants().filter((el) => {
      if (cls && !el.classList.contains(cls)) return false;
      if (segMatch && el.dataset.narrationSeg !== segMatch[1]) return false;
      return true;
    });
  }

  querySelector(selector: string): El | null {
    if (selector === '[data-role="final"]') {
      return this.descendants().find((el) => el.getAttribute('data-role') === 'final') || null;
    }
    if (selector === '.chat-bubble') {
      return this.descendants().find((el) => el.classList.contains('chat-bubble')) || null;
    }
    return this.querySelectorAll(selector)[0] || null;
  }
}

function loadFoldContext() {
  const context: any = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Map, Set, Array, String, Number, RegExp, Math, Promise, Boolean, Object,
    encodeURIComponent, URLSearchParams,
    CSS: { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') },
    requestAnimationFrame: (fn: Function) => { fn(); return 1; },
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    escapeHtml: (s: string) => String(s),
    t: (key: string) => key,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => new El(),
    },
    window: { addEventListener() {}, uiIconHtml: () => '', ConversationRuntime: {} },
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(VIEW_MODEL_SOURCE, context);
  vm.runInContext(SOURCE, context);
  vm.runInContext('globalThis.__fold = _applyNarrationFold;', context);
  return context;
}

function rowWithBlocks(count: number, turnId = 'T-fold') {
  const row = new El();
  row.dataset.turnId = turnId;
  const bubble = new El();
  bubble.className = 'chat-bubble';
  row.appendChild(bubble);
  for (let i = 0; i < count; i++) {
    const block = new El();
    block.className = 'chat-turn-narration';
    block.dataset.narrationSeg = String(i);
    bubble.appendChild(block);
  }
  const body = new El();
  body.setAttribute('data-role', 'final');
  bubble.appendChild(body);
  return { row, bubble };
}

function foldedCount(bubble: El) {
  return bubble.querySelectorAll('.chat-turn-narration')
    .filter((b) => b.classList.contains('chat-turn-narration--folded')).length;
}

describe('narration folding', () => {
  it('leaves a short turn alone', () => {
    const ctx = loadFoldContext();
    const { row, bubble } = rowWithBlocks(3);
    ctx.__fold(row);
    expect(foldedCount(bubble), 'three blocks stay readable').toBe(0);
    expect(bubble.querySelectorAll('.chat-turn-narration-toggle')).toHaveLength(0);
  });

  it('folds all but the tail of a long turn and counts what it hid', () => {
    const ctx = loadFoldContext();
    const { row, bubble } = rowWithBlocks(61);
    ctx.__fold(row);
    expect(foldedCount(bubble)).toBe(59);
    const toggle = bubble.querySelectorAll('.chat-turn-narration-toggle')[0];
    expect(toggle, 'a fold needs a way back').toBeTruthy();
    expect(toggle.dataset.hiddenCount).toBe('59');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // The blocks are hidden, never dropped: quoting and search still see them.
    expect(bubble.querySelectorAll('.chat-turn-narration')).toHaveLength(61);
  });

  it('keeps the newest segments visible, not the oldest', () => {
    const ctx = loadFoldContext();
    const { row, bubble } = rowWithBlocks(61);
    ctx.__fold(row);
    const visible = bubble.querySelectorAll('.chat-turn-narration')
      .filter((b) => !b.classList.contains('chat-turn-narration--folded'))
      .map((b) => Number(b.dataset.narrationSeg));
    expect(visible).toEqual([59, 60]);
  });

  it('opens and closes on click', () => {
    const ctx = loadFoldContext();
    const { row, bubble } = rowWithBlocks(61);
    ctx.__fold(row);
    const toggle = bubble.querySelectorAll('.chat-turn-narration-toggle')[0];
    toggle.click();
    expect(foldedCount(bubble), 'expanded shows every segment').toBe(0);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    expect(foldedCount(bubble), 'collapsing again re-hides them').toBe(59);
  });

  it('remembers a collapse across a transcript rebuild', () => {
    // Switching conversations rebuilds the transcript, so the row carrying
    // `narrationExpanded` is gone. A fold the reader chose must survive it
    // (2026-09-18: it came back open).
    const ctx = loadFoldContext();
    const first = rowWithBlocks(61, 'T-keep');
    ctx.__fold(first.row);
    const toggle = first.bubble.querySelectorAll('.chat-turn-narration-toggle')[0];
    toggle.click();                       // open
    toggle.click();                       // and fold again — an explicit choice
    expect(foldedCount(first.bubble)).toBe(59);

    // Same turn, brand new DOM: what a conversation switch produces.
    const rebuilt = rowWithBlocks(61, 'T-keep');
    ctx.__fold(rebuilt.row);
    expect(foldedCount(rebuilt.bubble), 'the choice outlives the row').toBe(59);
    expect(rebuilt.row.dataset.narrationExpanded).toBe('0');
  });

  it('carries an explicit open across a rebuild too', () => {
    const ctx = loadFoldContext();
    const first = rowWithBlocks(61, 'T-open');
    ctx.__fold(first.row);
    first.bubble.querySelectorAll('.chat-turn-narration-toggle')[0].click();
    const rebuilt = rowWithBlocks(61, 'T-open');
    ctx.__fold(rebuilt.row);
    expect(foldedCount(rebuilt.bubble)).toBe(0);
  });

  it('keeps turns independent', () => {
    const ctx = loadFoldContext();
    const a = rowWithBlocks(61, 'T-a');
    ctx.__fold(a.row);
    a.bubble.querySelectorAll('.chat-turn-narration-toggle')[0].click();
    const b = rowWithBlocks(61, 'T-b');
    ctx.__fold(b.row);
    expect(foldedCount(a.bubble), 'opened turn stays open').toBe(0);
    expect(foldedCount(b.bubble), 'untouched turn keeps the default').toBe(59);
  });

  it('re-folds newly absorbed older segments without losing the open state', () => {
    const ctx = loadFoldContext();
    const { row, bubble } = rowWithBlocks(61);
    ctx.__fold(row);
    bubble.querySelectorAll('.chat-turn-narration-toggle')[0].click();
    // An older history page lands in this bubble (cross-page absorb).
    const older = new El();
    older.className = 'chat-turn-narration';
    older.dataset.narrationSeg = '-1';
    bubble.insertBefore(older, bubble.children[0]);
    ctx.__fold(row);
    expect(foldedCount(bubble), 'still expanded after absorbing').toBe(0);
    expect(bubble.querySelectorAll('.chat-turn-narration-toggle')[0].dataset.hiddenCount).toBe('60');
  });
});
