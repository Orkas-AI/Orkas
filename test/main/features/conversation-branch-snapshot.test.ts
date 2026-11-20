import { describe, expect, it } from 'vitest';
import type { GroupMessage } from '../../../src/main/features/group_chat/visibility';
import { buildConversationBranchSnapshot } from '../../../src/main/features/conversation-branch-snapshot';

const user = (id: string, text = id, extra: Partial<GroupMessage> = {}): GroupMessage => ({
  id, ts: '2026-11-02T00:00:00Z', from: 'user', to: ['commander'], text, ...extra,
});
const answer = (id: string, source: string, text = id, extra: Partial<GroupMessage> = {}): GroupMessage => ({
  id, ts: '2026-11-02T00:00:01Z', from: 'commander', to: ['user'], text,
  source_message_id: source, display_phase: 'final_answer', ...extra,
});
const history = () => [user('u1'), answer('a1', 'u1'), user('u2'), answer('a2', 'u2'),
  user('u3'), answer('a3', 'u3')];
function build(messages: readonly GroupMessage[], target = 'u2') {
  return buildConversationBranchSnapshot({
    conversationId: 'source-chat', messages, complete: true, processing: false,
  }, target, { maxMessages: 100, maxTextBytes: 4096 });
}

describe('text snapshots for a conversation branch', () => {
  it.each([
    ['u1', ['u1', 'a1']],
    ['u2', ['u1', 'a1', 'u2', 'a2']],
    ['u3', ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']],
  ])('retains the complete prefix through %s and excludes later turns', (target, ids) => {
    const result = build(history(), target as string);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot).toMatchObject({ sourceConversationId: 'source-chat', throughUserMessageId: target });
    expect(result.snapshot.messages.map(m => m.sourceMessageId)).toEqual(ids);
  });

  it('keeps visible text and provenance without copying execution or model-only state', () => {
    const rows = [user('u1', 'routed text', { display_text: '@Commander hello', client_msg_id: 'optimistic' }),
      answer('hidden', 'u1', 'internal dispatch', { dispatch: true }),
      answer('a1', 'u1', 'Final **answer**', { turn_id: 'running-session', task_id: 'task-board-row',
        model_text: 'private model instruction', process: [{ type: 'progress', text: 'tool details' }] })];
    const before = JSON.stringify(rows);
    for (const row of rows) Object.freeze(row);
    Object.freeze(rows);
    const result = build(rows, 'u1');
    expect(result).toEqual({ ok: true, snapshot: {
      sourceConversationId: 'source-chat', throughUserMessageId: 'u1', messages: [
        { sourceMessageId: 'u1', ts: '2026-11-02T00:00:00Z', from: 'user', text: '@Commander hello' },
        { sourceMessageId: 'a1', ts: '2026-11-02T00:00:01Z', from: 'commander', text: 'Final **answer**' },
      ],
    } });
    if (result.ok) result.snapshot.messages[0].text = 'edited snapshot';
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('retains multiple visible actor replies and commentary in their original order', () => {
    const rows = [user('u1'), answer('comment', 'u1', 'Checking', { display_phase: 'commentary' }),
      answer('expert', 'u1', 'Expert result', { from: 'expert-agent' }), answer('final', 'u1')];
    const result = build(rows, 'u1');
    expect(result.ok && result.snapshot.messages.map(m => [m.sourceMessageId, m.from])).toEqual([
      ['u1', 'user'], ['comment', 'commander'], ['expert', 'expert-agent'], ['final', 'commander'],
    ]);
  });

  it('supports canonical legacy replies without an explicit display phase or causal id', () => {
    expect(build([user('u1'), answer('a1', 'u1', 'Legacy reply', {
      display_phase: undefined, source_message_id: undefined,
    })], 'u1').ok).toBe(true);
  });

  it('keeps replies caused by another actor in the same turn and tolerates empty optional lists', () => {
    const rows = [user('u1', 'Question', { attachments: [], references: [] }),
      answer('dispatch', 'u1', 'Internal', { dispatch: true }),
      answer('expert', 'dispatch', 'Expert result', { from: 'expert-agent' }),
      answer('final', 'expert', 'Final result')];
    const result = build(rows, 'u1');
    expect(result.ok && result.snapshot.messages.map(m => m.sourceMessageId)).toEqual(['u1', 'expert', 'final']);
  });

  it.each(['missing', 'a1', ''])('rejects an unavailable or non-user branch anchor: %s', target => {
    expect(build(history(), target)).toEqual({ ok: false, error: target ? 'turn_not_found' : 'invalid_request' });
  });

  it.each([{ complete: false }, { processing: true }])('requires a complete settled source: %j', flags => {
    expect(buildConversationBranchSnapshot({ conversationId: 'source', messages: history(),
      complete: true, processing: false, ...flags }, 'u1', { maxMessages: 20, maxTextBytes: 100 }))
      .toEqual({ ok: false, error: 'source_not_ready' });
  });

  it.each([
    [user('u1')],
    [user('u1'), answer('a1', 'u1', 'Still checking', { display_phase: 'commentary' })],
    [user('u1'), answer('a1', 'u1', '')],
  ])('does not treat a missing final reply as a completed turn', (...rows) => {
    expect(build(rows as GroupMessage[], 'u1')).toEqual({ ok: false, error: 'turn_incomplete' });
  });

  it('rejects pending display records even if the supplied processing flag is idle', () => {
    expect(build([user('u1'), answer('a1', 'u1', 'Unsettled', { display_phase: 'pending' })], 'u1'))
      .toEqual({ ok: false, error: 'source_not_ready' });
  });

  it('rejects duplicate message identities instead of selecting an ambiguous prefix', () => {
    expect(build([user('u1'), answer('a1', 'u1'), user('u1'), answer('a2', 'u1')], 'u1'))
      .toEqual({ ok: false, error: 'ambiguous_message' });
    expect(build([user('u1'), answer('u1', 'u1')], 'u1'))
      .toEqual({ ok: false, error: 'ambiguous_message' });
  });

  it('refuses a deleted prefix instead of silently changing the selected history', () => {
    const rows = history(); rows[0].deleted_at = '2026-11-02T01:00:00Z';
    expect(build(rows)).toEqual({ ok: false, error: 'unsupported_history' });
  });

  it.each([
    { attachments: ['input.txt'] }, { produced: ['/source/output.txt'] },
    { references: [{ source_cid: 'other', source_msg_id: 'm', text: 'quoted' }] },
    { artifacts: [{ id: 'app', title: 'App', agent_id: 'commander' }] },
    { use_selections: [{ kind: 'skill', id: 'example' }] },
    { form: { fields: [] } }, { cli_question: { questions: [] } },
    { system_kind: 'reply_interrupted' }, { failure_kind: 'model' }, { new_visible_payload: 'future format' },
  ])('refuses unsupported context rather than producing a lossy text branch: %j', extra => {
    const rows = history(); Object.assign(rows[1], extra);
    expect(build(rows)).toEqual({ ok: false, error: 'unsupported_history' });
  });

  it('does not require support for rich messages belonging only to later turns', () => {
    const rows = history(); rows[4].attachments = ['later.txt'];
    expect(build(rows, 'u1').ok).toBe(true);
  });

  it('refuses overlapping causal turns, including replies written after the cutoff', () => {
    expect(build([user('u1'), user('u2'), answer('a1', 'u1'), answer('a2', 'u2')], 'u2'))
      .toEqual({ ok: false, error: 'overlapping_turns' });
    expect(build([user('u1'), answer('a1', 'u1'), user('u2'), answer('late', 'u1')], 'u1'))
      .toEqual({ ok: false, error: 'overlapping_turns' });
  });

  it('counts UTF-8 bytes and fails at the caller budget without truncating text', () => {
    const source = { conversationId: 'source', messages: [user('u1', '中'), answer('a1', 'u1', '🌟')],
      complete: true, processing: false };
    expect(buildConversationBranchSnapshot(source, 'u1', { maxMessages: 2, maxTextBytes: 7 }).ok).toBe(true);
    expect(buildConversationBranchSnapshot(source, 'u1', { maxMessages: 2, maxTextBytes: 6 }))
      .toEqual({ ok: false, error: 'history_too_large' });
    expect(buildConversationBranchSnapshot(source, 'u1', { maxMessages: 1, maxTextBytes: 7 }))
      .toEqual({ ok: false, error: 'history_too_large' });
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects an invalid caller budget in either dimension: %s', limit => {
    for (const limits of [{ maxMessages: limit, maxTextBytes: 100 }, { maxMessages: 100, maxTextBytes: limit }]) {
      expect(buildConversationBranchSnapshot({ conversationId: 'source', messages: history(), complete: true,
        processing: false }, 'u1', limits)).toEqual({ ok: false, error: 'invalid_request' });
    }
  });
});
