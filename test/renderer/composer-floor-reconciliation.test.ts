import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

/**
 * The composer chip is the routing preview for a mention-less send, and since
 * D9 that send routes by the SERVER floor alone — the conversation composer
 * synthesizes no `@` prefix. So the chip and the floor must never disagree:
 * whatever name the chip shows is where the next plain message lands.
 *
 * The 2026-08-24 on-device report is the canonical case. The user picked
 * "Claude Code" on the chip, the agent hit a capability boundary and handed the
 * task back, and the floor returned to the commander — but the sticky client
 * pick outlived it, so the chip still read "Claude Code" while the next message
 * reached the commander.
 *
 * Oracle: the chip label is derived independently of the code under test, from
 * the floor these tests set. `_activeRecipient` (what the send path snapshots)
 * is asserted alongside it so a chip fixed only cosmetically still fails.
 */

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

const CID = 'cid-floor';
const AGENT_A = { kind: 'agent', id: 'agent-a', name: 'Claude Code' };
const AGENT_B = { kind: 'agent', id: 'agent-b', name: 'Writing Helper' };

function makeChipEl() {
  return {
    textContent: '',
    attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    removeAttribute(k: string) { delete this.attrs[k]; },
  };
}

function boot() {
  const chipEl = makeChipEl();
  const store = new Map<string, string>();
  // Resolved by the test when it wants an in-flight floor write to land.
  let releaseFloorWrite: (() => void) | null = null;

  const context: any = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Map, Set, Array, String, Number, RegExp, Math, Promise, Boolean, Object,
    encodeURIComponent, URLSearchParams,
    CSS: { escape: (s: string) => String(s) },
    requestAnimationFrame: (fn: Function) => { fn(); return 1; },
    currentCid: CID,
    conversations: [],
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    escapeHtml: (s: string) => String(s),
    t: (key: string) => key,
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    apiFetch: () => new Promise((resolve) => {
      releaseFloorWrite = () => resolve({ json: () => Promise.resolve({ ok: true }) });
    }),
    document: {
      // Keeps module-level boot wiring from running during eval — these tests
      // drive the reconciliation entry point directly.
      readyState: 'loading',
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: (id: string) => (id === 'chat-recipient-name' ? chipEl : null),
      createElement: () => ({ dataset: {}, style: {}, appendChild() {}, setAttribute() {} }),
    },
    window: { addEventListener() {}, uiIconHtml: () => '', ConversationRuntime: {} },
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);

  // Neutralize only the collaborators outside this behavior. Recipient
  // resolution, chip rendering and floor reconciliation stay production code.
  vm.runInContext(`
    _agentsCache = [
      { agent_id: '${AGENT_A.id}', name: '${AGENT_A.name}' },
      { agent_id: '${AGENT_B.id}', name: '${AGENT_B.name}' }
    ];
    _knownGroupActorLabel = function() { return ''; };
    _syncComposerModelChipAvailability = function() {};
    _onRecipientChanged = function() {};
    _persistQueueComposerEditState = function() {};
  `, context);

  const api = {
    chipEl,
    store,
    releaseFloorWrite: () => { releaseFloorWrite?.(); },
    /** What the send path would snapshot as this message's target. */
    activeRecipient: () => vm.runInContext(`_activeRecipient('conversation')`, context),
    setFloor: (agentId: string) => vm.runInContext(
      `_serverFloorByCid.set('${CID}', '${agentId}')`, context,
    ),
    stickyPick: () => vm.runInContext(`_recipientByCid['${CID}'] || null`, context),
    hasPendingWrite: () => vm.runInContext(`_floorSyncByCid.has('${CID}')`, context),
    pickOnChip: (agent: { id: string; name: string }) => vm.runInContext(
      `setChatRecipient('conversation', { kind: 'agent', id: '${agent.id}', name: '${agent.name}' })`,
      context,
    ),
    reconcile: () => vm.runInContext(`_evaluateAutoRecipient('${CID}')`, context),
  };
  return api;
}

describe('composer chip / server floor reconciliation', () => {
  it('drops a sticky pick the floor no longer backs, so the chip stops naming an unreachable agent', async () => {
    const app = boot();
    app.pickOnChip(AGENT_A);
    app.releaseFloorWrite();
    // Let the floor write settle, as it has long before the agent's turn ends.
    await new Promise((r) => setTimeout(r, 0));
    app.setFloor(AGENT_A.id);
    await app.reconcile();
    expect(app.chipEl.textContent).toBe(AGENT_A.name);

    // The agent hands the task back: the server returns the floor to the
    // commander, which is where a mention-less message now goes.
    app.setFloor('');
    await app.reconcile();

    expect(app.chipEl.textContent).toBe('chat.recipient_commander');
    expect(app.activeRecipient()).toMatchObject({ kind: 'commander' });
    expect(app.stickyPick()).toBeNull();
    // The stale pick must not come back from localStorage on the next boot.
    expect(app.store.get('chat.recipientByCid') || '{}').not.toContain(AGENT_A.id);
  });

  it('keeps the freshly picked agent while this client\'s own floor write is still in flight', async () => {
    const app = boot();
    app.pickOnChip(AGENT_A);
    expect(app.hasPendingWrite()).toBe(true);

    // A state_changed still carrying the pre-pick floor must not clobber the
    // optimistic display before the user's own write lands.
    app.setFloor('');
    await app.reconcile();

    expect(app.chipEl.textContent).toBe(AGENT_A.name);
    expect(app.activeRecipient()).toMatchObject({ kind: 'agent', id: AGENT_A.id });
    expect(app.stickyPick()).toMatchObject({ id: AGENT_A.id });
  });

  it('releases the in-flight marker once the floor write settles', async () => {
    const app = boot();
    app.pickOnChip(AGENT_A);
    expect(app.hasPendingWrite()).toBe(true);

    app.releaseFloorWrite();
    await new Promise((r) => setTimeout(r, 0));

    // Without this the marker would linger for any pick the user never sent,
    // suppressing reconciliation for the rest of the session.
    expect(app.hasPendingWrite()).toBe(false);
    app.setFloor('');
    await app.reconcile();
    expect(app.chipEl.textContent).toBe('chat.recipient_commander');
  });

  it('follows the floor to a different agent instead of the stale pick', async () => {
    const app = boot();
    app.pickOnChip(AGENT_A);
    app.releaseFloorWrite();
    await new Promise((r) => setTimeout(r, 0));

    // The commander hands off to a different agent.
    app.setFloor(AGENT_B.id);
    await app.reconcile();

    expect(app.chipEl.textContent).toBe(AGENT_B.name);
    expect(app.activeRecipient()).toMatchObject({ kind: 'agent', id: AGENT_B.id });
  });
});
