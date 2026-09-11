import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  const end = source.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`unterminated ${name}`);
  return source.slice(start, end + 2);
}

describe('conversation › _forgetCidRecipient', () => {
  it('prunes every per-conversation cache of the forgotten conversation', () => {
    // These maps had no evictor: one entry per conversation ever opened, for
    // the renderer's lifetime. Deleting a conversation is the natural
    // boundary; entries of other conversations must survive.
    const globals = {
      _recipientByCid: { c1: 'agent-a' },
      _saveRecipientMap: vi.fn(),
      _autoRecipientByCid: new Map([['c1', 1]]),
      _serverFloorByCid: new Map([['c1', 1]]),
      _serverFloorRevisionByCid: new Map([['c1', 3], ['c2', 1]]),
      _pendingFloorResetByCid: new Map([['c1', 1]]),
      setGroupConversationBusy: vi.fn(),
      _latestInFlight: new Map([['c1', 1]]),
      _latestActiveTurns: new Map([['c1', 1]]),
      _conversationInfoFileRefreshTimers: new Map(),
      clearTimeout,
      _quotesByCid: new Map([['c1', 1]]),
      _failedConvs: new Set(['c1']),
      _groupMembersCache: new Map([['c1', 1]]),
      _settledConvTurns: new Map([['c1', 1]]),
      _chatAttachmentRevisions: new Map([['c1', 3], ['c2', 1]]),
      pollMsgCounts: new Map([['c1', 'm9'], ['c2', 'm1']]),
    };
    const forget = vm.runInNewContext(`(${extractFunction('_forgetCidRecipient')})`, globals);

    forget('c1');

    expect(globals._serverFloorRevisionByCid.has('c1')).toBe(false);
    expect(globals._serverFloorRevisionByCid.get('c2')).toBe(1);
    expect(globals._chatAttachmentRevisions.has('c1')).toBe(false);
    expect(globals.pollMsgCounts.has('c1')).toBe(false);
    expect(globals._chatAttachmentRevisions.get('c2')).toBe(1);
    expect(globals.pollMsgCounts.get('c2')).toBe('m1');
  });
});
