import { describe, expect, it } from 'vitest';
import {
  FULL_REBASE_MAX_BYTES,
  FULL_REBASE_MAX_PRIOR_TURNS,
  buildGroupConversationHistory,
  projectFullRebaseMessages,
  type GroupMessage,
} from '../../../../src/main/features/group_chat/visibility';
import { Session } from '../../../../src/core-agent/src/agent/session';

const CURRENT_ID = 'current-user-msg';

function serializedBytes(messages: unknown): number {
  return Buffer.byteLength(JSON.stringify(messages), 'utf8');
}

function fixtureRows(
  priorTurns: number,
  opts: { deletedTurns?: number[] } = {},
): GroupMessage[] {
  const rows: GroupMessage[] = [];
  for (let i = 1; i <= priorTurns; i++) {
    rows.push({
      id: `u${i}`,
      ts: `2026-08-01T00:${String(i).padStart(2, '0')}:00.000Z`,
      from: 'user',
      to: ['commander'],
      text: `user turn ${i}`,
      ...(opts.deletedTurns?.includes(i)
        ? { deleted_at: '2026-08-01T12:00:00.000Z' }
        : {}),
    } as GroupMessage);
    rows.push({
      id: `r${i}`,
      ts: `2026-08-01T00:${String(i).padStart(2, '0')}:30.000Z`,
      from: 'commander',
      to: ['user'],
      text: `reply ${i}`,
    } as GroupMessage);
  }
  rows.push({
    id: CURRENT_ID,
    ts: '2026-08-01T09:00:00.000Z',
    from: 'user',
    to: ['commander'],
    text: 'current turn',
  } as GroupMessage);
  return rows;
}

describe('full canonical rebuild replay cap', () => {
  it('exposes an independent 200 KiB pre-compaction byte ceiling', () => {
    expect(FULL_REBASE_MAX_BYTES).toBe(200 * 1024);
  });

  it('replays the whole log unchanged at or under the cap', () => {
    const rows = fixtureRows(FULL_REBASE_MAX_PRIOR_TURNS);
    const capped = projectFullRebaseMessages(rows, CURRENT_ID);
    expect(capped).toEqual(buildGroupConversationHistory(rows, CURRENT_ID));
    expect(JSON.stringify(capped)).not.toContain('Conversation context note');
  });

  it('caps an over-limit rebuild behind one note pair with stable global ordinals', () => {
    // The checkpoint-invalidation rebuild takes this same code path: full mode
    // is one branch, so this fixture covers first-contact and invalidation.
    const rows = fixtureRows(FULL_REBASE_MAX_PRIOR_TURNS + 5, { deletedTurns: [2] });
    const full = buildGroupConversationHistory(rows, CURRENT_ID);
    const capped = projectFullRebaseMessages(rows, CURRENT_ID);

    const [noteUser, noteAck] = capped;
    expect(noteUser?.role).toBe('user');
    expect(noteAck?.role).toBe('assistant');
    expect(noteUser?.turnId).toBe(5);
    expect(noteAck?.turnId).toBe(5);
    const noteText = (noteUser?.content?.[0] as { text?: string })?.text ?? '';
    expect(noteText).toContain('10 earlier messages');
    expect(noteText).toContain('across 5 earlier user turns');
    expect(noteText).toContain(
      'between 2026-08-01T00:01:00.000Z and 2026-08-01T00:05:30.000Z',
    );

    // Differential oracle: the replayed tail must be exactly the full-log
    // projection's turns after the omitted ordinals. The deleted user turn 2
    // still consumed ordinal 2, so the first replayed turn is 6 — a cut that
    // recounted ordinals without deleted rows would fail this equality.
    expect(capped.slice(2)).toEqual(full.filter((m) => (m.turnId ?? 0) > 5));
    expect(capped[2]?.turnId).toBe(6);
  });

  it('keeps the checkpoint tail boundary usable in a real session after a capped rebuild', () => {
    const rows = fixtureRows(FULL_REBASE_MAX_PRIOR_TURNS + 5);
    const capped = projectFullRebaseMessages(rows, CURRENT_ID);
    const source = 'group:cid-rebase-cap';
    const session = new Session();
    session.replaceConversationHistory(capped, source, { checkpoint: 'cp-1' });

    // Mirror the live turn the dispatch runs after the rebase. nextTurnId must
    // continue global numbering (45 replayed turns -> live turn 46).
    session.beginUserTurn([{ type: 'text', text: 'current turn' }]);
    session.addAssistantMessage([{ type: 'text', text: '(reply)' }]);
    session.completeActiveTurn();

    // The full-mode checkpoint stores tailStartTurnId = user rows through the
    // current message (46 here). The next dispatch can only go incremental if
    // that boundary survived the capped rebuild.
    expect(session.canReplaceConversationHistoryTail(source, 46)).toBe(true);
    session.replaceConversationHistory(
      [
        { role: 'user', turnId: 46, content: [{ type: 'text', text: 'current turn' }] },
        { role: 'assistant', turnId: 46, content: [{ type: 'text', text: '(reply)' }] },
      ],
      source,
      { replaceFromTurnId: 46, checkpoint: 'cp-2' },
    );
    expect(session.getConversationHistoryCheckpoint(source)).toBe('cp-2');
  });

  it('drops only complete oldest turns until the omission note and retained tail fit 200 KiB', () => {
    const rows = fixtureRows(4);
    for (let turn = 1; turn <= 4; turn++) {
      const row = rows.find((message) => message.id === `u${turn}`)!;
      row.text = `TURN-${turn}-BEGIN ${String(turn).repeat(70_000)} TURN-${turn}-END`;
    }

    const capped = projectFullRebaseMessages(rows, CURRENT_ID);
    expect(serializedBytes(capped)).toBeLessThanOrEqual(FULL_REBASE_MAX_BYTES);
    expect(capped.map((message) => message.turnId)).toEqual([2, 2, 3, 3, 4, 4]);
    const serialized = JSON.stringify(capped);
    expect(serialized).not.toContain('TURN-1-BEGIN');
    expect(serialized).not.toContain('TURN-2-BEGIN');
    expect(serialized).toContain('TURN-3-BEGIN');
    expect(serialized).toContain('TURN-4-END');
    expect(serialized.match(/Conversation context note/g)).toHaveLength(1);
    expect(serialized).toContain('across 2 earlier user turns');
  });

  it('measures multibyte history in UTF-8 bytes instead of JavaScript characters', () => {
    const rows = fixtureRows(2);
    rows[0].text = `MULTIBYTE-OLD-BEGIN ${'旧'.repeat(75_000)} MULTIBYTE-OLD-END`;

    // The text is below 200 KiB when counted as UTF-16 code units, but above
    // it once serialized as UTF-8. A length-based regression would retain it.
    expect(JSON.stringify(buildGroupConversationHistory(rows, CURRENT_ID)).length)
      .toBeLessThan(FULL_REBASE_MAX_BYTES);
    expect(serializedBytes(buildGroupConversationHistory(rows, CURRENT_ID)))
      .toBeGreaterThan(FULL_REBASE_MAX_BYTES);

    const capped = projectFullRebaseMessages(rows, CURRENT_ID);
    const serialized = JSON.stringify(capped);
    expect(serializedBytes(capped)).toBeLessThanOrEqual(FULL_REBASE_MAX_BYTES);
    expect(capped.map((message) => message.turnId)).toEqual([1, 1, 2, 2]);
    expect(serialized).not.toContain('MULTIBYTE-OLD-BEGIN');
    expect(serialized).toContain('user turn 2');
  });

  it('does not charge the current user payload against the prior-history byte budget', () => {
    const rows = fixtureRows(2);
    const current = rows.find((message) => message.id === CURRENT_ID)!;
    current.text = `CURRENT-LARGE-BEGIN ${'界'.repeat(FULL_REBASE_MAX_BYTES)} CURRENT-LARGE-END`;

    const expectedPriorHistory = buildGroupConversationHistory(rows, CURRENT_ID);
    const capped = projectFullRebaseMessages(rows, CURRENT_ID);
    expect(capped).toEqual(expectedPriorHistory);
    expect(JSON.stringify(capped)).not.toContain('CURRENT-LARGE-BEGIN');
    expect(JSON.stringify(capped)).not.toContain('Conversation context note');

    const session = new Session();
    session.replaceConversationHistory(capped, 'group-main-v4:large-current-turn');
    session.beginUserTurn([{ type: 'text', text: current.text }]);
    const liveUser = session.getMessages().at(-1);
    expect((liveUser?.content[0] as { text?: string })?.text).toBe(current.text);
  });

  it('omits one oversized newest prior turn whole and preserves the next live turn ordinal', () => {
    const rows = fixtureRows(1);
    rows[0].text = `OVERSIZED-BEGIN ${'x'.repeat(FULL_REBASE_MAX_BYTES + 1)} OVERSIZED-END`;

    const capped = projectFullRebaseMessages(rows, CURRENT_ID);
    expect(serializedBytes(capped)).toBeLessThanOrEqual(FULL_REBASE_MAX_BYTES);
    expect(capped).toHaveLength(2);
    expect(capped.map((message) => message.turnId)).toEqual([1, 1]);
    expect(JSON.stringify(capped)).not.toContain('OVERSIZED-BEGIN');
    expect(JSON.stringify(capped)).toContain('chat_history');

    const session = new Session();
    session.replaceConversationHistory(capped, 'group-main-v4:oversized');
    expect(session.beginUserTurn([{ type: 'text', text: 'current turn remains uncapped' }])).toBe(2);
  });

  it('combines the 40-turn and byte cuts into one note with stable global ordinals', () => {
    const rows = fixtureRows(FULL_REBASE_MAX_PRIOR_TURNS + 5);
    for (const row of rows) {
      if (row.from === 'user' && row.id !== CURRENT_ID) row.text += ` ${'z'.repeat(9_000)}`;
    }

    const capped = projectFullRebaseMessages(rows, CURRENT_ID);
    const serialized = JSON.stringify(capped);
    expect(serializedBytes(capped)).toBeLessThanOrEqual(FULL_REBASE_MAX_BYTES);
    expect(serialized.match(/Conversation context note/g)).toHaveLength(1);
    const omittedTurnId = capped[0]?.turnId ?? 0;
    expect(omittedTurnId).toBeGreaterThan(5);
    expect(capped[1]?.turnId).toBe(omittedTurnId);
    expect(capped[2]?.turnId).toBeGreaterThan(omittedTurnId);
    expect(capped.at(-1)?.turnId).toBe(FULL_REBASE_MAX_PRIOR_TURNS + 5);
  });

  it('leaves the retained replay eligible for the existing token compaction thresholds', () => {
    const rows = fixtureRows(40);
    for (const row of rows) {
      if (row.from === 'user' && row.id !== CURRENT_ID) row.text += ` ${'a'.repeat(5_000)}`;
    }
    const capped = projectFullRebaseMessages(rows, CURRENT_ID);
    expect(serializedBytes(capped)).toBeLessThanOrEqual(FULL_REBASE_MAX_BYTES);

    const session = new Session();
    session.replaceConversationHistory(capped, 'group-main-v4:token-interaction');
    const archive = session.getPendingHistoryArchive();
    expect(archive).not.toBeNull();
    expect(archive?.turnIds.length).toBeGreaterThan(0);
  });
});
