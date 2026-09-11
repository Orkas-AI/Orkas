/* Orkas Frontend — conversation row identity
 *
 * Every rendered row has a `key` that is stable from its first byte:
 *
 *   persisted message      → `m:<msg.id>`
 *   commander/agent stream → `s:<turn_id>:<seg>`
 *   optimistic user send   → `u:<client_msg_id>`
 *
 * A streaming segment keeps its `s:` key when the bus persists it: the
 * `message` event carries the same `turn_id` + `seg` as the deltas that
 * preceded it, so persistence UPDATES the row instead of creating a second
 * one. This is the property the old placeholder-claiming logic had to
 * reconstruct by guessing, and the reason `seg` was added to `process` events
 * (see bus.ts `GroupEvent`). The renderer resolves identity through
 * `window.ConversationViewModel.keyForMessage`; the DOM-free reducer that once
 * lived beside these helpers was never wired into rendering and is gone.
 */

(function initConversationViewModel(global) {
  'use strict';

  const USER_ACTOR = 'user';

  function segmentKey(turnId, seg) {
    return `s:${turnId}:${seg}`;
  }

  function messageKey(msgId) {
    return `m:${msgId}`;
  }

  function optimisticKey(clientMsgId) {
    return `u:${clientMsgId}`;
  }

  /** Key a persisted record would occupy. Segment-bearing actor replies keep
   * the identity their stream already established; everything else is keyed by
   * its persisted id. User rows prefer the echoed client id so the optimistic
   * row is updated rather than duplicated. */
  function keyForMessage(msg) {
    if (!msg) return '';
    if (msg.from === USER_ACTOR && msg.client_msg_id) return optimisticKey(msg.client_msg_id);
    if (msg.from !== USER_ACTOR && msg.turn_id && msg.seg !== undefined && msg.seg !== null) {
      return segmentKey(msg.turn_id, msg.seg);
    }
    return msg.id ? messageKey(msg.id) : '';
  }

  global.ConversationViewModel = {
    keyForMessage,
    segmentKey,
    messageKey,
    optimisticKey,
  };

  // Test bridge: pure functions only, no DOM/i18n/IPC (see PC/CLAUDE.md).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.ConversationViewModel;
  }
}(typeof window !== 'undefined' ? window : globalThis));
