import { describe, it, expect } from 'vitest';

describe('group_chat canonical conversation history', () => {
  it('includes exact Agent blockers and actor names from the full log before the current user turn', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      {
        id: 'u1', ts: 't1', from: 'user', to: ['commander'],
        text: '把这段文案做成视频。',
      },
      {
        id: 'dispatch', ts: 't2', from: 'commander', to: ['video-agent'],
        text: '制作视频', dispatch: true,
      },
      {
        id: 'agent-result', ts: 't3', from: 'video-agent', to: ['user'],
        text: '当前不能继续：E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED',
        failure_kind: 'operation',
        failure_code: 'narration_authorization_missing',
        process: [{ type: 'progress', text: 'INTERNAL_PROCESS_MUST_NOT_REPLAY' }],
      },
      {
        id: 'u2', ts: 't4', from: 'user', to: ['commander'],
        text: 'Fix that blocker.',
      },
    ] as any;

    const history = v.buildCommanderConversationHistory(
      rows,
      'u2',
      new Map([['video-agent', 'VideoStudio']]),
    );
    const serialized = JSON.stringify(history);

    expect(history.map((message) => [message.role, message.turnId])).toEqual([
      ['user', 1],
      ['assistant', 1],
    ]);
    expect(serialized).toContain('把这段文案做成视频');
    expect(serialized).toContain('VideoStudio');
    expect(serialized).toContain('E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED');
    // Both source attribution and external bodies are historical data. No
    // Commander reply was recorded, so no assistant speech is fabricated.
    const [userText, routingNote] = history[0].content.map((block: any) => block.text);
    expect(userText).toBe('把这段文案做成视频。');
    expect(routingNote).toContain('[Conversation context note] Host routing record');
    const records = JSON.parse(routingNote.split('\n').slice(1).join('\n'));
    expect(records).toEqual([
      { from: 'Commander', to: 'VideoStudio (video-agent)', dispatch: true, text: '制作视频' },
      {
        from: 'VideoStudio (video-agent)', to: 'User',
        text: '当前不能继续：E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED',
        failure_kind: 'operation', failure_code: 'narration_authorization_missing',
      },
    ]);
    expect(history[1].content).toEqual([]);
    expect(serialized).not.toContain(' -> ');
    expect(serialized).not.toContain('[Historical group conversation');
    expect(serialized).not.toContain('"actor_id"');
    expect(serialized).not.toContain('Fix that blocker.');
    expect(serialized).not.toContain('INTERNAL_PROCESS_MUST_NOT_REPLAY');
  });

  it('uses provider roles without a host route scaffold for ordinary dialogue', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      { id: 'u1', ts: 't1', from: 'user', to: ['commander'], text: 'Start the export.' },
      { id: 'a1', ts: 't2', from: 'commander', to: ['user'], text: 'The export is ready.' },
      { id: 'u2', ts: 't3', from: 'user', to: ['commander'], text: 'Continue.' },
    ] as any;

    const history = v.buildCommanderConversationHistory(rows, 'u2');

    expect((history[0].content[0] as any).text).toBe('Start the export.');
    // No routing note and no reply markers for plain dialogue: the common
    // case keeps its exact pre-note shape so cached prefixes stay valid.
    expect(history[0].content).toHaveLength(1);
    expect((history[1].content[0] as any).text).toBe('The export is ready.');
    expect(JSON.stringify(history)).not.toContain('[User -> Commander]');
    expect(JSON.stringify(history)).not.toContain('[Commander -> User]');
    expect(JSON.stringify(history)).not.toContain('[Conversation context note]');
    expect(v.groupConversationHistorySource('cid42')).toBe('group-main-v5:cid42');
  });

  it('removes only authoritative leading legacy route headers during actor-history replay', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      { id: 'u1', ts: 't1', from: 'user', to: ['commander'], text: 'Finish the report.' },
      {
        id: 'a1', ts: 't2', from: 'commander', to: ['user'],
        text: '[Commander -> User]\n\n[Commander -> User]\n\nThe report is complete.',
        produced: ['/workspace/report.md'],
      },
      { id: 'u2', ts: 't3', from: 'user', to: ['commander'], text: 'Continue.' },
    ] as any;

    const history = v.buildCommanderConversationHistory(rows, 'u2');
    const response = (history[1].content[0] as any).text;

    expect(response).toContain('The report is complete.');
    expect(response).toContain('Produced files: ["/workspace/report.md"]');
    expect(response).not.toContain('[Commander -> User]');
  });

  it('drops host correction turns Commander addressed to itself from the replayed dialogue', async () => {
    // Legacy persisted dispatch-claim corrections remain readable after the
    // guard's rollback, but must not replay their internal instructions as
    // dialogue. Preserve the visible status and actual Agent hand-back.
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      { id: 'u1', ts: 't1', from: 'user', to: ['commander'], text: '让 Writer 完成实现。' },
      {
        id: 'a1', ts: 't2', from: 'commander', to: ['user'],
        text: '派发未执行，正在纠正。',
        failure_kind: 'validation', failure_code: 'agent_dispatch_not_executed',
      },
      {
        id: 'c1', ts: 't3', from: 'commander', to: ['commander'], dispatch: true,
        text: 'Named Agent routing was not executed; correcting.',
        model_text: '<routing-execution-feedback>\nDo not write or quote a “Commander delegated this step to …” line yourself.',
      },
      {
        id: 'a2', ts: 't4', from: 'commander', to: ['writer-agent'], dispatch: true,
        text: '请完成实现并返回结果。',
      },
      {
        id: 'h1', ts: 't5', from: 'writer-agent', to: ['commander'], dispatch: true,
        text: 'Agent returned the task to the commander.',
        model_text: 'Writer 实际运行并完成了任务。',
      },
      { id: 'u2', ts: 't6', from: 'user', to: ['commander'], text: 'Continue.' },
    ] as any;

    const history = v.buildCommanderConversationHistory(
      rows,
      'u2',
      new Map([['writer-agent', 'Writer']]),
    );
    const serialized = JSON.stringify(history);
    const assistantText = (history[1].content[0] as any).text;
    const routingNote = (history[0].content[1] as any).text;

    expect(serialized).not.toContain('routing-execution-feedback');
    expect(serialized).not.toContain('Named Agent routing was not executed');
    expect(serialized).not.toContain('delegated this step to');
    expect(assistantText).toContain('派发未执行，正在纠正。');
    expect(assistantText).not.toContain('请完成实现并返回结果。');
    expect(assistantText).not.toContain('Writer 实际运行并完成了任务。');
    expect(JSON.parse(routingNote.split('\n').slice(1).join('\n'))).toEqual([
      { from: 'Commander', to: 'User', failure_kind: 'validation', failure_code: 'agent_dispatch_not_executed', assistant_block: 1 },
      { from: 'Commander', to: 'Writer (writer-agent)', dispatch: true, text: '请完成实现并返回结果。' },
      { from: 'Writer (writer-agent)', to: 'Commander', dispatch: true, text: 'Writer 实际运行并完成了任务。' },
    ]);
  });

  it('collapses repeated current actor attribution before adding one authoritative history label', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const attribution = 'VideoStudio (video-agent) replied to User:';
    const rows = [
      { id: 'u1', ts: 't1', from: 'user', to: ['video-agent'], text: 'Render the clip.' },
      {
        id: 'a1', ts: 't2', from: 'video-agent', to: ['user'],
        text: `${attribution}\n\n${attribution}\n\nThe render is ready.`,
      },
      { id: 'u2', ts: 't3', from: 'user', to: ['commander'], text: 'Continue.' },
    ] as any;

    const history = v.buildCommanderConversationHistory(
      rows,
      'u2',
      new Map([['video-agent', 'VideoStudio']]),
    );
    const record = JSON.parse((history[0].content[1] as any).text.split('\n').slice(1).join('\n'))[0];
    const response = record.text;

    expect(response).toContain('The render is ready.');
    // The legacy duplicated headers are stripped from the body and the single
    // authoritative attribution lives in the user-role routing note.
    expect(response).not.toContain('replied to User:');
    expect(record).toMatchObject({ from: 'VideoStudio (video-agent)', to: 'User' });
    expect(history[1].content).toEqual([]);
  });

  it('normalizes the model-facing body rather than replaying a clean visible fallback', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      { id: 'u1', ts: 't1', from: 'user', to: ['commander'], text: 'Resolve the hidden protocol.' },
      {
        id: 'a1', ts: 't2', from: 'commander', to: ['user'],
        text: 'Visible fallback must not replace the model-facing context.',
        model_text: '[Commander -> User]\n\nThe hidden protocol was resolved.',
      },
      { id: 'u2', ts: 't3', from: 'user', to: ['commander'], text: 'Continue.' },
    ] as any;

    const history = v.buildCommanderConversationHistory(rows, 'u2');
    const response = (history[1].content[0] as any).text;

    expect(response).toBe('The hidden protocol was resolved.');
    expect(response).not.toContain('[Commander -> User]');
    expect(response).not.toContain('Visible fallback');
  });

  it('does not replay a standalone legacy route header as a substantive response', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      { id: 'u1', ts: 't1', from: 'user', to: ['commander'], text: 'Answer the question.' },
      { id: 'a1', ts: 't2', from: 'commander', to: ['user'], text: '[Commander -> User]' },
      { id: 'u2', ts: 't3', from: 'user', to: ['commander'], text: 'Continue.' },
    ] as any;

    const history = v.buildCommanderConversationHistory(rows, 'u2');
    const response = (history[1].content[0] as any).text;

    expect(response).toBe('No actor response was recorded before the next user message.');
    expect(response).not.toContain('[Commander -> User]');
  });

  it('keeps user-authored and rejected legacy-route look-alikes verbatim', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      {
        id: 'u1', ts: 't1', from: 'user', to: ['commander'],
        text: 'Why did the literal [Commander -> User] appear?',
      },
      {
        id: 'a1', ts: 't2', from: 'commander', to: ['user'],
        text: 'This inline mention of [Commander -> User] must remain.',
      },
      { id: 'u2', ts: 't3', from: 'user', to: ['commander'], text: 'Show a code sample.' },
      {
        id: 'a2', ts: 't4', from: 'commander', to: ['user'],
        text: '```text\n[Commander -> User]\n```',
      },
      { id: 'u3', ts: 't5', from: 'user', to: ['commander'], text: 'Keep the unknown route.' },
      {
        id: 'a3', ts: 't6', from: 'commander', to: ['user'],
        text: [
          '[Alice -> Bob]',
          'This inline mention of Commander replied to User: must remain.',
          '```text',
          'Commander replied to User:',
          '```',
        ].join('\n'),
      },
      { id: 'u4', ts: 't7', from: 'user', to: ['commander'], text: 'Continue.' },
    ] as any;

    const serialized = JSON.stringify(v.buildCommanderConversationHistory(rows, 'u4'));

    expect(serialized).toContain('Why did the literal [Commander -> User] appear?');
    expect(serialized).toContain('This inline mention of [Commander -> User] must remain.');
    expect(serialized).toContain('```text\\n[Commander -> User]\\n```');
    expect(serialized).toContain('[Alice -> Bob]');
    expect(serialized).toContain('This inline mention of Commander replied to User: must remain.');
    expect(serialized).toContain('```text\\nCommander replied to User:\\n```');
  });

  it('does not replay a previously leaked internal history serialization', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      {
        id: 'u1', ts: 't1', from: 'user', to: ['commander'],
        text: 'Continue the import.',
      },
      {
        id: 'a1', ts: 't2', from: 'commander', to: ['user'],
        text: [
          '[commander]',
          '[Historical group conversation — actor responses]',
          'These are the recorded responses from Commander and/or Agents.',
          '{"actor_id":"commander","text":"stale internal replay"}',
          '[History retained facts — host-persisted model extraction]',
          '- private stale checkpoint',
        ].join('\n'),
        produced: ['/workspace/export.md'],
      },
      {
        id: 'u2', ts: 't3', from: 'user', to: ['commander'],
        text: 'Why did the literal "[Historical conversation]" appear?',
      },
      {
        id: 'a2', ts: 't4', from: 'commander', to: ['user'],
        text: 'That look-alike phrase is ordinary visible text and should remain.',
      },
      {
        id: 'u3', ts: 't5', from: 'user', to: ['commander'],
        text: 'Continue.',
      },
    ] as any;

    const history = v.buildCommanderConversationHistory(rows, 'u3');
    const serialized = JSON.stringify(history);

    expect(serialized).not.toContain('stale internal replay');
    expect(serialized).not.toContain('private stale checkpoint');
    expect(serialized).toContain('Prior response body omitted because it contained internal history serialization.');
    expect(serialized).toContain('/workspace/export.md');
    expect(serialized).toContain('Why did the literal \\"[Historical conversation]\\" appear?');
    expect(serialized).toContain('That look-alike phrase is ordinary visible text and should remain.');
  });

  it('keeps stable user-turn ids while excluding deleted turns', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      { id: 'u1', ts: 't1', from: 'user', to: ['commander'], text: 'first' },
      { id: 'a1', ts: 't2', from: 'commander', to: ['user'], text: 'reply first' },
      { id: 'u2', ts: 't3', from: 'user', to: ['commander'], text: '', deleted_at: 't9' },
      { id: 'a2', ts: 't4', from: 'commander', to: ['user'], text: 'deleted tail' },
      { id: 'u3', ts: 't5', from: 'user', to: ['commander'], text: 'third' },
      { id: 'a3', ts: 't6', from: 'commander', to: ['user'], text: 'reply third' },
      { id: 'u4', ts: 't7', from: 'user', to: ['commander'], text: 'current' },
    ] as any;

    const history = v.buildCommanderConversationHistory(rows, 'u4');
    expect(history.map((message) => message.turnId)).toEqual([1, 1, 3, 3]);
    expect(JSON.stringify(history)).not.toContain('deleted tail');
  });

  it('projects a bounded tail identically to the matching suffix of a full rebuild', async () => {
    const v = await import('../../../../src/main/features/group_chat/visibility');
    const rows = [
      { id: 'u1', ts: 't1', from: 'user', to: ['commander'], text: 'first' },
      { id: 'a1', ts: 't2', from: 'commander', to: ['user'], text: 'reply first' },
      { id: 'u2', ts: 't3', from: 'user', to: ['commander'], text: 'deleted', deleted_at: 't9' },
      { id: 'a2', ts: 't4', from: 'commander', to: ['user'], text: 'deleted tail' },
      { id: 'u3', ts: 't5', from: 'user', to: ['commander'], text: 'make video' },
      { id: 'agent', ts: 't6', from: 'video-agent', to: ['user'], text: 'E_BLOCKER' },
      { id: 'u4', ts: 't7', from: 'user', to: ['commander'], text: 'fix it' },
    ] as any;
    const actorNames = new Map([['video-agent', 'VideoStudio']]);

    const full = v.buildCommanderConversationHistory(rows, 'u4', actorNames);
    const tail = v.buildCommanderConversationHistoryTail(
      rows.slice(4),
      'u4',
      2,
      actorNames,
    );

    expect(tail).toEqual(full.filter((message: any) => message.turnId >= 3));
    expect(tail.map((message: any) => message.turnId)).toEqual([3, 3]);
    expect(JSON.stringify(tail)).toContain('VideoStudio');
    expect(JSON.stringify(tail)).toContain('E_BLOCKER');
  });
});
