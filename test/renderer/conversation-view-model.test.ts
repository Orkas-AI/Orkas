import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

// Pure module, no DOM — loaded through the guarded CommonJS test bridge.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ViewModel = require(path.join(__dirname, '../../src/renderer/modules/conversation-view-model.js'));

type Ev = Record<string, any>;

const TURN = 'turn-1';

function delta(seg: number, text: string, actor = 'commander'): Ev {
  return { type: 'process', cid: 'c1', actor, turn_id: TURN, seg, data: { type: 'delta', text } };
}

function toolEvent(seg: number, name: string, actor = 'commander'): Ev {
  return {
    type: 'process',
    cid: 'c1',
    actor,
    turn_id: TURN,
    seg,
    data: { type: 'event', event: { stream: 'tool', data: { phase: 'start', id: `t-${name}`, name } } },
  };
}

function segMessage(seg: number, text: string, id: string, ts = '2026-07-30T16:43:07'): Ev {
  return {
    type: 'message',
    cid: 'c1',
    turn_id: TURN,
    seg,
    msg: { id, from: 'commander', to: ['user'], text, ts, turn_id: TURN, seg },
  };
}

function textsOf(view: any): string[] {
  return ViewModel.orderedRows(view).map((row: any) => row.text);
}

describe('conversation view model › segment identity', () => {
  // The defect this whole model exists to make unrepresentable: a commander
  // segment streamed, then persisted, must be ONE row. The old renderer keyed
  // the live text to a placeholder bubble and the persisted record to a msg id,
  // so a failed claim produced two identical bubbles that survived until the
  // whole turn ended.
  it('folds a streamed segment and its persisted record into one row', () => {
    const view = ViewModel.reduceAll(ViewModel.emptyView(), [
      delta(0, 'Handing this to '),
      delta(0, 'the researcher.'),
      toolEvent(0, 'read_file'),
      segMessage(0, 'Handing this to the researcher.', 'msg-seg-0'),
    ]);

    const rows = ViewModel.orderedRows(view);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('Handing this to the researcher.');
    expect(rows[0].msgId).toBe('msg-seg-0');
    expect(rows[0].persisted).toBe(true);
    // The rail streamed before the record landed must survive persistence.
    expect(rows[0].process).toHaveLength(1);
  });

  it('keeps pre-dispatch narration and post-handback synthesis as separate rows', () => {
    const view = ViewModel.reduceAll(ViewModel.emptyView(), [
      delta(0, 'Handing this over.'),
      segMessage(0, 'Handing this over.', 'msg-seg-0', '2026-07-30T16:43:07'),
      { // the delegated agent replies between the two segments
        type: 'message',
        cid: 'c1',
        msg: { id: 'msg-agent', from: 'agent-1', to: ['user'], text: 'agent result', ts: '2026-07-30T17:11:18' },
      },
      delta(1, 'Here is the summary.'),
      segMessage(1, 'Here is the summary.', 'msg-seg-1', '2026-07-30T17:11:20'),
    ]);

    expect(textsOf(view)).toEqual(['Handing this over.', 'agent result', 'Here is the summary.']);
  });

  // A late delta for an already-persisted segment used to append to the live
  // bubble, so the row drifted away from what the bus actually stored.
  it('ignores a delta that arrives after its segment was persisted', () => {
    const view = ViewModel.reduceAll(ViewModel.emptyView(), [
      delta(0, 'Canonical text.'),
      segMessage(0, 'Canonical text.', 'msg-seg-0'),
      delta(0, ' stray tail'),
    ]);

    expect(textsOf(view)).toEqual(['Canonical text.']);
  });
});

describe('conversation view model › duplicate and out-of-order delivery', () => {
  // Two subscribers relayed the same bus event; dedupe was a key-guessing layer
  // that returned an empty key for deltas, so those doubled.
  it('is idempotent when every event is delivered twice', () => {
    const events = [
      delta(0, 'one '),
      delta(0, 'two'),
      toolEvent(0, 'grep_files'),
      segMessage(0, 'one two', 'msg-seg-0'),
    ];
    const once = ViewModel.reduceAll(ViewModel.emptyView(), events);
    const twice = ViewModel.reduceAll(ViewModel.emptyView(), events.flatMap((e) => [e, e]));

    // Deltas are genuinely additive, so a doubled delta stream doubles text —
    // that is why the transport must not fan out. What must hold is that the
    // PERSISTED record wins and restores canonical text either way.
    expect(ViewModel.orderedRows(once)).toHaveLength(1);
    expect(ViewModel.orderedRows(twice)).toHaveLength(1);
    expect(textsOf(twice)).toEqual(['one two']);
    expect(ViewModel.orderedRows(twice)[0].process).toHaveLength(1);
  });

  it('attributes a delta that arrives after its own message event', () => {
    const view = ViewModel.reduceAll(ViewModel.emptyView(), [
      segMessage(0, 'persisted first', 'msg-seg-0'),
      delta(1, 'later segment'),
    ]);

    expect(textsOf(view)).toEqual(['persisted first', 'later segment']);
  });

  it('re-reducing full history produces the same rows as the live stream', () => {
    const live = ViewModel.reduceAll(ViewModel.emptyView(), [
      delta(0, 'narration'),
      segMessage(0, 'narration', 'msg-seg-0', '2026-07-30T16:43:07'),
      delta(1, 'summary'),
      segMessage(1, 'summary', 'msg-seg-1', '2026-07-30T17:11:20'),
    ]);
    const reloaded = ViewModel.viewFromHistory([
      { id: 'msg-seg-0', from: 'commander', to: ['user'], text: 'narration', ts: '2026-07-30T16:43:07', turn_id: TURN, seg: 0 },
      { id: 'msg-seg-1', from: 'commander', to: ['user'], text: 'summary', ts: '2026-07-30T17:11:20', turn_id: TURN, seg: 1 },
    ]);

    expect(textsOf(reloaded)).toEqual(textsOf(live));
    expect(ViewModel.orderedRows(reloaded).map((r: any) => r.key))
      .toEqual(ViewModel.orderedRows(live).map((r: any) => r.key));
  });
});

describe('conversation view model › interruption and silent turns', () => {
  // The real 2026-07-30 shape: commander narrates, dispatches, then ends its
  // turn silently because the delegate already answered the user.
  it('drops unpersisted residue when a turn ends silently', () => {
    const view = ViewModel.reduceAll(ViewModel.emptyView(), [
      delta(0, 'Handing this to the researcher.'),
      segMessage(0, 'Handing this to the researcher.', 'msg-seg-0'),
      toolEvent(1, 'dispatch_to'),
      { type: 'turn_silent', cid: 'c1', actor: 'commander', turn_id: TURN, reason: 'terminal_handoff' },
    ]);

    const rows = ViewModel.orderedRows(view);
    expect(rows).toHaveLength(1);
    expect(rows[0].msgId).toBe('msg-seg-0');
  });

  it('never discards a persisted segment when its turn goes silent', () => {
    const view = ViewModel.reduceAll(ViewModel.emptyView(), [
      segMessage(0, 'kept', 'msg-seg-0'),
      { type: 'turn_silent', cid: 'c1', actor: 'commander', turn_id: TURN },
    ]);

    expect(textsOf(view)).toEqual(['kept']);
  });

  it('leaves another actor\'s live turn alone when one turn goes silent', () => {
    const view = ViewModel.reduceAll(ViewModel.emptyView(), [
      delta(0, 'commander text'),
      { type: 'process', cid: 'c1', actor: 'agent-1', turn_id: 'turn-2', seg: 0, data: { type: 'delta', text: 'agent text' } },
      { type: 'turn_silent', cid: 'c1', actor: 'commander', turn_id: TURN },
    ]);

    expect(textsOf(view)).toEqual(['agent text']);
  });
});

describe('conversation view model › user messages', () => {
  it('updates the optimistic row in place when its persisted record arrives', () => {
    const optimistic = ViewModel.reduceConversationView(ViewModel.emptyView(), {
      type: 'message',
      cid: 'c1',
      msg: { from: 'user', to: ['commander'], text: 'do it', ts: '2026-07-30T16:42:37', client_msg_id: 'c-aaa' },
    });
    const persisted = ViewModel.reduceConversationView(optimistic, {
      type: 'message',
      cid: 'c1',
      msg: { id: 'u1', from: 'user', to: ['commander'], text: 'do it', ts: '2026-07-30T16:42:37', client_msg_id: 'c-aaa' },
    });

    const rows = ViewModel.orderedRows(persisted);
    expect(rows).toHaveLength(1);
    expect(rows[0].msgId).toBe('u1');
  });

  // Same text, same second, two sends — the signature heuristic collapsed these.
  it('keeps two identical concurrent sends apart', () => {
    const view = ViewModel.reduceAll(ViewModel.emptyView(), [
      { type: 'message', cid: 'c1', msg: { id: 'u1', from: 'user', text: 'run it', ts: '2026-07-30T16:42:37', client_msg_id: 'c-aaa' } },
      { type: 'message', cid: 'c1', msg: { id: 'u2', from: 'user', text: 'run it', ts: '2026-07-30T16:42:37', client_msg_id: 'c-bbb' } },
    ]);

    expect(ViewModel.orderedRows(view).map((r: any) => r.msgId)).toEqual(['u1', 'u2']);
  });
});

describe('conversation view model › hidden and deleted records', () => {
  it('never renders an internal commander → agent dispatch', () => {
    const view = ViewModel.reduceConversationView(ViewModel.emptyView(), {
      type: 'message',
      cid: 'c1',
      msg: { id: 'd1', from: 'commander', to: ['agent-1'], text: 'task brief', dispatch: true },
    });

    expect(ViewModel.orderedRows(view)).toHaveLength(0);
  });

  it('removes a row when its record comes back tombstoned', () => {
    const view = ViewModel.reduceAll(ViewModel.emptyView(), [
      segMessage(0, 'visible', 'msg-seg-0'),
      {
        type: 'message',
        cid: 'c1',
        msg: { id: 'msg-seg-0', from: 'commander', text: 'visible', turn_id: TURN, seg: 0, deleted_at: '2026-07-30T18:00:00' },
      },
    ]);

    expect(ViewModel.orderedRows(view)).toHaveLength(0);
  });
});

describe('conversation view model › reducer purity', () => {
  it('returns the same object when an event changes nothing', () => {
    const base = ViewModel.reduceAll(ViewModel.emptyView(), [segMessage(0, 'text', 'msg-seg-0')]);
    const after = ViewModel.reduceConversationView(base, { type: 'unrelated', cid: 'c1', actor: 'commander' });
    expect(after).toBe(base);
  });

  it('does not mutate the previous view when a new event lands', () => {
    const before = ViewModel.reduceAll(ViewModel.emptyView(), [delta(0, 'first')]);
    const beforeRows = ViewModel.orderedRows(before).map((r: any) => r.text);
    ViewModel.reduceConversationView(before, delta(0, ' second'));
    expect(ViewModel.orderedRows(before).map((r: any) => r.text)).toEqual(beforeRows);
  });
});
