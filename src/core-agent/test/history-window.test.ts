import { describe, it, expect } from 'vitest';
import { Session } from '../src/agent/session.js';

function turn(session: Session, id: number, body = '') {
  session.beginUserTurn([{ type: 'text', text: `INPUT_${id} ${body}` }]);
  session.addAssistantMessage([{ type: 'text', text: `OUTPUT_${id}` }]);
  session.completeActiveTurn();
}
const text = (session: Session) => JSON.stringify(session.getMessagesForModel());

describe('bounded completed-history window', () => {
  it('identifies the dialogue-only projection even when all recent turns fit', () => {
    const session = new Session();
    session.beginUserTurn([{ type: 'text', text: 'Check Cedar' }]);
    session.addAssistantMessage([{ type: 'tool_use', id: 'check', name: 'bash', input: {} }]);
    session.addToolResult('check', 'CEDAR_PRIVATE_PROCESS_DETAIL');
    session.addAssistantMessage([{ type: 'text', text: 'Cedar check completed' }]);
    session.completeActiveTurn();
    session.beginUserTurn([{ type: 'text', text: 'Write the status' }]);
    expect(text(session)).toContain('Cedar check completed');
    expect(text(session)).not.toContain('CEDAR_PRIVATE_PROCESS_DETAIL');
    expect(text(session)).toContain('not a full execution transcript');
    expect(text(session)).toContain('public tool records may be available via chat_history');
    expect(text(session)).not.toContain('earlier completed turns through');
    expect(JSON.stringify(session.getMessages())).toContain('CEDAR_PRIVATE_PROCESS_DETAIL');
    expect(JSON.stringify(session.getMessages())).not.toContain('History window:');
  });

  it('does not invent archive state on the first user turn', () => {
    const session = new Session();
    session.beginUserTurn([{ type: 'text', text: 'Hello' }]);
    expect(session.getMessagesForModel()).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]);
    expect(session.estimateHistoryTokens()).toBe(0);
  });

  it('reserves at most 20% of available room and keeps history stable throughout a user turn', () => {
    const session = new Session();
    for (let i = 0; i < 7; i++) turn(session, i, '界'.repeat(1000));
    session.beginUserTurn([{ type: 'text', text: 'CURRENT' }]);
    session.configureHistoryBudget(24_000, 19_680, 5000);
    // The newest pair fits; the preceding input is clipped while its reply survives.
    expect(session.estimateHistoryTokens()).toBeLessThanOrEqual(2936);
    expect(text(session)).toContain('INPUT_6');
    expect(text(session)).not.toContain('INPUT_5');
    const history = session.getMessagesForModel().slice(0, -1);
    session.addAssistantMessage([{ type: 'tool_use', id: 'read', name: 'read', input: {} }]);
    session.addToolResult('read', '界'.repeat(1000));
    session.configureHistoryBudget(24_000, 19_680, 18_000);
    expect(session.getMessagesForModel().slice(0, history.length)).toEqual(history);
    // A larger model cannot resurrect omitted history midway through a turn.
    session.configureHistoryBudget(900_000, 738_000, 5000);
    expect(session.getMessagesForModel().slice(0, history.length)).toEqual(history);
    // A smaller resolved model tightens the budget and invalidates usage anchoring.
    const epoch = session.contentEpoch();
    session.configureHistoryBudget(8000, 6560, 5000);
    expect(session.estimateHistoryTokens()).toBeLessThanOrEqual(312);
    expect(text(session)).not.toContain('INPUT_6');
    expect(text(session)).toContain('CURRENT');
    expect(session.contentEpoch()).toBeGreaterThan(epoch);
    session.addAssistantMessage([{ type: 'text', text: 'DONE' }]);
    session.completeActiveTurn();
    session.beginUserTurn([{ type: 'text', text: 'NEXT' }]);
    session.configureHistoryBudget(900_000, 738_000, 5000);
    expect(text(session)).toContain('INPUT_6');
  });

  it.each([0, 5])('does not force an omission note into an exhausted history allowance (%s tokens)', (room) => {
    const session = new Session();
    turn(session, 0, 'historical evidence');
    session.beginUserTurn([{ type: 'text', text: 'CURRENT' }]);
    session.configureHistoryBudget(1000, 820, 820 - room);
    expect(session.estimateHistoryTokens()).toBe(0);
    expect(session.getMessagesForModel()).toEqual([{ role: 'user', content: [{ type: 'text', text: 'CURRENT' }] }]);
    expect(JSON.stringify(session.getMessages())).toContain('historical evidence');
  });

  it('removes inline image/video bytes before the history budget while preserving raw records and current input', () => {
    const session = new Session();
    const image = 'data:image/png;base64,' + 'AAAA'.repeat(100_000);
    const video = 'data:video/mp4;base64,' + 'BBBB'.repeat(100_000);
    session.beginUserTurn([{ type: 'text', text: `Review ${image} /work/chart.png` }]);
    session.addAssistantMessage([{ type: 'text', text: `Done ${video} /work/clip.mp4 FINAL_FACT` }]);
    session.completeActiveTurn();
    session.beginUserTurn([{ type: 'text', text: 'CURRENT data:image/png;base64,Q1VSUkVOVA==' }]);
    const view = text(session);
    expect(view).toContain('FINAL_FACT');
    expect(view).toContain('/work/chart.png');
    expect(view).toContain('/work/clip.mp4');
    expect(view).not.toContain('AAAA');
    expect(view).not.toContain('BBBB');
    expect(view).toContain('CURRENT data:image/png;base64,Q1VSUkVOVA==');
    expect(session.estimateHistoryTokens()).toBeLessThan(1000);
    expect(JSON.stringify(session.getMessages())).toContain(image);
    expect(JSON.stringify(session.getMessages())).toContain(video);
  });

  it('retains five completed human turns, independently of model/tool requests', () => {
    const session = new Session();
    for (let i = 0; i < 8; i++) turn(session, i);
    session.beginUserTurn([{ type: 'text', text: 'CURRENT' }]);
    const history = session.getMessagesForModel().slice(0, -1);
    for (let i = 0; i < 20; i++) {
      session.addAssistantMessage([{ type: 'tool_use', id: `call-${i}`, name: 'read', input: {} }]);
      session.addToolResult(`call-${i}`, `result-${i}`);
    }
    expect(session.getMessagesForModel().slice(0, history.length)).toEqual(history);
    for (let i = 0; i < 3; i++) expect(text(session)).not.toContain(`INPUT_${i}`);
    for (let i = 3; i < 8; i++) {
      expect(text(session)).toContain(`INPUT_${i}`);
      expect(text(session)).toContain(`OUTPUT_${i}`);
    }
    expect(text(session)).toContain('CURRENT');
    expect(text(session)).toContain('result-19');
    expect(session.getPendingHistoryArchive()).toBeNull();
  });

  it('clips the oldest boundary text at 30K and preserves its tail plus newer dialogue', () => {
    const session = new Session();
    for (let i = 0; i < 7; i++) turn(session, i, '界'.repeat(6_000) + ` END_${i}`);
    expect(session.estimateHistoryTokens()).toBeLessThanOrEqual(30_000);
    for (let i = 0; i < 4; i++) expect(text(session)).not.toContain(`INPUT_${i}`);
    for (let i = 3; i < 7; i++) expect(text(session)).toContain(`END_${i}`);
    expect(text(session)).toContain('[Earlier history text omitted]');
    expect(text(session)).toContain('chat_history');
    expect(session.getMessages().some(message => JSON.stringify(message).includes('INPUT_0'))).toBe(true);
  });

  it('retains the suffix of an oversized newest turn without backfilling or cutting active input', () => {
    const session = new Session();
    turn(session, 0, 'old small record');
    turn(session, 1, '界'.repeat(30_000) + ' LATEST_INPUT_TAIL');
    session.beginUserTurn([{ type: 'text', text: 'CURRENT_' + '界'.repeat(40_000) }]);
    expect(text(session)).not.toContain('INPUT_0');
    expect(text(session)).not.toContain('INPUT_1');
    expect(text(session)).toContain('through turn 1');
    expect(text(session)).toContain('LATEST_INPUT_TAIL');
    expect(text(session)).toContain('OUTPUT_1');
    expect(text(session)).toContain('[Earlier history text omitted]');
    expect(text(session)).toContain('CURRENT_' + '界'.repeat(40_000));
    expect(session.estimateHistoryTokens()).toBeLessThanOrEqual(30_000);
    expect(session.estimateHistoryTokens()).toBeGreaterThan(29_900);
  });

  it('keeps legacy metadata readable without injecting summaries/facts or creating new ones', () => {
    const session = new Session();
    turn(session, 0);
    const state = session.getSerializedContextState()!;
    state.historySummary = 'LEGACY_SUMMARY';
    state.historyExactFacts = ['LEGACY_FACT'];
    state.completedTurns![0].archived = true;
    session.restoreContextState(state);
    expect(session.getSerializedContextState()?.historySummary).toBe('LEGACY_SUMMARY');
    expect(text(session)).toContain('INPUT_0');
    expect(text(session)).not.toContain('LEGACY_');
    expect(session.getPersistentBlockShrinkCandidate()).toBeNull();
    expect(session.getPendingHistoryArchive()).toBeNull();
  });

  it('does not resurrect older turns after emergency history reduction', () => {
    const session = new Session();
    for (let i = 0; i < 15; i++) turn(session, i);
    session.beginUserTurn([{ type: 'text', text: 'CURRENT' }]);
    session.applyEmergencyHistoryFold('unused legacy notice', session.getArchivableHistoryTurns());
    expect(text(session)).not.toContain('INPUT_');
    expect(text(session)).toContain('CURRENT');
    expect(text(session)).toContain('chat_history');
  });

  it('applies the same window after incremental canonical replacements', () => {
    const session = new Session();
    const pair = (id: number) => [
      { role: 'user' as const, turnId: id, content: [{ type: 'text' as const, text: `USER_${id}` }] },
      { role: 'assistant' as const, turnId: id, content: [{ type: 'text' as const, text: `ANSWER_${id}` }] },
    ];
    session.replaceConversationHistory(pair(1), 'canonical');
    for (let id = 2; id <= 20; id++) {
      session.replaceConversationHistory([...pair(id - 1), ...pair(id)], 'canonical', { replaceFromTurnId: id - 1 });
      expect((text(session).match(/USER_\d+/g) || []).length).toBe(Math.min(5, id));
    }
    expect(text(session)).not.toContain('USER_15');
    expect(text(session)).toContain('USER_16');
    expect(text(session)).toContain('ANSWER_20');
  });
});
