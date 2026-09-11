import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerCliAsyncInput, closeCliAsyncInputs, finishCliAsyncInputs, registerCliAsyncInput } from '../../../../src/main/features/group_chat/cli_async_input';

const uid = 'question-user';
const cid = 'question-chat';
afterEach(() => { closeCliAsyncInputs(uid, cid); vi.useRealTimers(); });

function setup() {
  const submit = vi.fn(async () => ({ mode: 'steered' as const }));
  const message = { id: 'reply', ts: '2026-09-09T10:00:00Z', from: 'user', to: ['agent'], text: 'Which folder?\nCurrent' };
  const save = vi.fn(async () => message);
  let active = true;
  registerCliAsyncInput({ uid, cid, turnId: 'turn', messageId: 'question', inputId: 'reply', questions: [{ title: 'Which folder?' }], ingress: () => active ? { submit } : null, save });
  return { submit, save, message, finish: () => { active = false; closeCliAsyncInputs(uid, cid, 'turn'); } };
}

describe('native async question replies', () => {
  it('keeps an unanswered question available beyond ten minutes while its CLI turn accepts input', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const h = setup();
    vi.setSystemTime(1_201_000);
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(await answerCliAsyncInput(uid, cid, 'question', ['Current'])).toEqual({ ok: true, message: h.message });
    expect(h.submit).toHaveBeenCalledOnce();
  });
  it('delivers one user-authored answer to the owning turn and saves it once for concurrent clicks', async () => {
    const h = setup();
    const results = await Promise.all([answerCliAsyncInput(uid, cid, 'question', ['Current']), answerCliAsyncInput(uid, cid, 'question', ['Current'])]);
    expect(results).toEqual([{ ok: true, message: h.message }, { ok: true, message: h.message }]);
    expect(h.submit).toHaveBeenCalledExactlyOnceWith({ id: 'reply', text: 'Which folder?\nCurrent' });
    expect(h.save).toHaveBeenCalledExactlyOnceWith('Which folder?\nCurrent', ['Current'], 'reply');
    expect(await answerCliAsyncInput(uid, cid, 'question', ['All'])).toEqual({ ok: false, error: 'already_answered' });
  });

  it('retains an accepted answer through a failed save and task completion without resending it', async () => {
    const h = setup();
    h.save.mockRejectedValueOnce(new Error('injected write failure'));
    expect(await answerCliAsyncInput(uid, cid, 'question', ['Current'])).toEqual({ ok: false, error: 'save_failed' });
    h.finish();
    expect(await answerCliAsyncInput(uid, cid, 'question', ['Current'])).toEqual({ ok: true, message: h.message });
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.save).toHaveBeenCalledTimes(2);
  });

  it('waits for an in-flight answer to be saved before finishing the original turn', async () => {
    const h = setup();
    let delivered!: (value: { mode: 'steered' }) => void;
    let saved!: (value: typeof h.message) => void;
    h.submit.mockImplementationOnce(() => new Promise(resolve => { delivered = resolve; }));
    h.save.mockImplementationOnce(() => new Promise(resolve => { saved = resolve; }));
    const answer = answerCliAsyncInput(uid, cid, 'question', ['Current']);
    let finished = false;
    const finish = finishCliAsyncInputs(uid, cid, 'turn').then(() => { finished = true; });
    delivered({ mode: 'steered' });
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    saved(h.message);
    expect(await answer).toEqual({ ok: true, message: h.message });
    await finish;
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(await answerCliAsyncInput(uid, cid, 'question', ['Current'])).toEqual({ ok: false, error: 'expired' });
  });

  it('keeps failed delivery retryable and refuses another account, incomplete answers, and a closed turn', async () => {
    const h = setup();
    h.submit.mockResolvedValueOnce({ mode: 'queued_followup' } as any);
    expect(await answerCliAsyncInput(uid, cid, 'question', ['Current'])).toEqual({ ok: false, error: 'delivery_failed' });
    expect(h.save).not.toHaveBeenCalled();
    expect(await answerCliAsyncInput('other', cid, 'question', ['Current'])).toEqual({ ok: false, error: 'expired' });
    expect(await answerCliAsyncInput(uid, cid, 'question', [''])).toEqual({ ok: false, error: 'invalid_answers' });
    h.finish();
    expect(await answerCliAsyncInput(uid, cid, 'question', ['Current'])).toEqual({ ok: false, error: 'expired' });
    expect(h.submit).toHaveBeenCalledTimes(1);
  });
});
