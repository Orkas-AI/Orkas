import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

// Pure module, no DOM — loaded through the guarded CommonJS test bridge.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ViewModel = require(path.join(__dirname, '../../src/renderer/modules/conversation-view-model.js'));

describe('conversation view model › row identity', () => {
  it('keys a streamed actor segment by its turn and segment so persistence updates the row', () => {
    // The persisted record carries the same turn_id + seg as the deltas that
    // preceded it; both must resolve to one key or the reply renders twice.
    expect(ViewModel.keyForMessage({ id: 'm-9', from: 'commander', turn_id: 'turn-1', seg: 0 }))
      .toBe(ViewModel.segmentKey('turn-1', 0));
    expect(ViewModel.keyForMessage({ id: 'm-10', from: 'agent-a', turn_id: 'turn-1', seg: 2 }))
      .toBe('s:turn-1:2');
  });

  it('keys a user send by its client id so the optimistic row is updated, not duplicated', () => {
    expect(ViewModel.keyForMessage({ id: 'm-1', from: 'user', client_msg_id: 'c-1' }))
      .toBe(ViewModel.optimisticKey('c-1'));
    // A user record without a client id, or an actor record without a
    // segment, falls back to its persisted id.
    expect(ViewModel.keyForMessage({ id: 'm-1', from: 'user' })).toBe(ViewModel.messageKey('m-1'));
    expect(ViewModel.keyForMessage({ id: 'm-2', from: 'commander', turn_id: 'turn-1' })).toBe('m:m-2');
    expect(ViewModel.keyForMessage({ id: 'm-3', from: 'commander', turn_id: 'turn-1', seg: null })).toBe('m:m-3');
  });

  it('never keys a user row by a turn segment, and yields no key without an id', () => {
    // A user message that happens to carry turn metadata still keys by id:
    // segment identity belongs to actor replies only.
    expect(ViewModel.keyForMessage({ id: 'm-4', from: 'user', turn_id: 'turn-1', seg: 0 })).toBe('m:m-4');
    expect(ViewModel.keyForMessage({ from: 'commander', turn_id: '', seg: 0 })).toBe('');
    expect(ViewModel.keyForMessage(null)).toBe('');
  });
});
