import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import {
  AgentRunner,
  createConfig,
  ProviderRegistry,
  Session,
  type AgentRunEvent,
  type CompletionParams,
  type LLMProvider,
  type Message,
  type SharedHistorySummaryCache,
} from '#core-agent';
import { CONTEXT_COMPACTION_SYSTEM_PROMPT } from '../../../../src/core-agent/src/agent/runner';
import {
  appendJsonl,
  writeTextAtomicSync,
} from '../../../../src/main/storage';
import { conversationMessageFile } from '../../../../src/main/util/project-layout';
import {
  clearConversationHistorySummary,
  createConversationHistorySummaryCache,
} from '../../../../src/main/features/group_chat/history-summary-cache';

async function collectRunEvents(runner: AgentRunner, message: string): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of runner.runStream({ message })) events.push(event);
  return events;
}

async function seedLongCanonicalHistory(
  uid: string,
  cid: string,
): Promise<Message[]> {
  const file = conversationMessageFile(uid, cid);
  const messages: Message[] = [];
  for (let turnId = 1; turnId <= 15; turnId++) {
    const userText = `Canonical user ${turnId} ${'request '.repeat(400)}`;
    const assistantText = `Canonical answer ${turnId} ${'response '.repeat(400)}`;
    await appendJsonl(file, {
      id: `user-message-${turnId}`,
      ts: `2026-01-01T00:00:${String(turnId).padStart(2, '0')}`,
      from: 'user',
      to: ['commander'],
      text: userText,
    });
    await appendJsonl(file, {
      id: `assistant-message-${turnId}`,
      ts: `2026-01-01T00:01:${String(turnId).padStart(2, '0')}`,
      from: 'commander',
      to: ['user'],
      text: assistantText,
    });
    messages.push(
      { role: 'user', turnId, content: [{ type: 'text', text: userText }] },
      { role: 'assistant', turnId, content: [{ type: 'text', text: assistantText }] },
    );
  }
  return messages;
}

function sessionWithCanonicalHistory(messages: Message[], source: string): Session {
  const session = new Session();
  session.replaceConversationHistory(messages, source);
  return session;
}

async function writeSummary(
  cache: SharedHistorySummaryCache,
  summary: string,
  throughTurnId: number,
): Promise<void> {
  const release = await cache.acquire();
  try {
    await cache.write({ summary, throughTurnId });
  } finally {
    release();
  }
}

describe('conversation history summary cache', () => {
  it('cancels a queued lock wait without leaking the mutex', async () => {
    const uid = `summary-lock-user-${Date.now()}`;
    const cid = `summarylock${Date.now()}`;
    const source = `group-main-v1:${cid}`;
    const cache = createConversationHistorySummaryCache({ uid, cid, source })!;
    const firstRelease = await cache.acquire();
    const controller = new AbortController();
    const waiting = cache.acquire(controller.signal);

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    firstRelease();

    const nextRelease = await cache.acquire();
    nextRelease();
  });

  it('persists the canonical message boundary and stays valid across appends', async () => {
    const uid = `summary-cache-user-${Date.now()}`;
    const cid = `summarycache${Date.now()}`;
    const source = `group-main-v1:${cid}`;
    const canonicalFile = conversationMessageFile(uid, cid);
    await appendJsonl(canonicalFile, {
      id: 'user-message-1', ts: '2026-01-01T00:00:00', from: 'user', to: ['commander'], text: 'one',
    });
    await appendJsonl(canonicalFile, {
      id: 'assistant-message-1', ts: '2026-01-01T00:00:01', from: 'commander', to: ['user'], text: 'answer one',
    });
    await appendJsonl(canonicalFile, {
      id: 'user-message-2', ts: '2026-01-01T00:00:02', from: 'user', to: ['commander'], text: 'two',
    });
    const cache = createConversationHistorySummaryCache({ uid, cid, source });
    expect(cache).toBeTruthy();

    const release = await cache!.acquire();
    const saved = await cache!.write({ summary: 'summary through two', throughTurnId: 2 });
    release();
    expect(saved).toEqual({
      summary: 'summary through two',
      throughTurnId: 2,
      throughMessageId: 'user-message-2',
    });

    await appendJsonl(canonicalFile, {
      id: 'user-message-3', ts: '2026-01-01T00:00:03', from: 'user', to: ['commander'], text: 'three',
    });
    expect(await cache!.read()).toEqual(saved);

    await clearConversationHistorySummary(uid, cid);
    expect(await cache!.read()).toBeNull();
  });

  it('rejects a summary after canonical history is atomically rewritten', async () => {
    const uid = `summary-rewrite-user-${Date.now()}`;
    const cid = `summaryrewrite${Date.now()}`;
    const source = `group-main-v1:${cid}`;
    const canonicalFile = conversationMessageFile(uid, cid);
    await appendJsonl(canonicalFile, {
      id: 'rewrite-user-1', ts: '2026-01-01T00:00:00', from: 'user', to: ['commander'], text: 'before',
    });
    const cache = createConversationHistorySummaryCache({ uid, cid, source })!;
    const release = await cache.acquire();
    await cache.write({ summary: 'stale after rewrite', throughTurnId: 1 });
    release();

    const rows = fs.readFileSync(canonicalFile, 'utf8')
      .replace('rewrite-user-1', 'rewrite-user-2');
    writeTextAtomicSync(canonicalFile, rows);

    expect(await cache.read()).toBeNull();
  });

  it('single-flights first use across independent Agents and lets a later Agent reuse it', async () => {
    const nonce = `${Date.now()}${process.pid}`;
    const uid = `summary-multi-agent-user-${nonce}`;
    const cid = `summarymultiagent${nonce}`;
    const source = `group-main-v1:${cid}`;
    const messages = await seedLongCanonicalHistory(uid, cid);
    const cacheA = createConversationHistorySummaryCache({ uid, cid, source })!;
    const cacheB = createConversationHistorySummaryCache({ uid, cid, source })!;
    let summaryCalls = 0;
    let ordinaryCalls = 0;
    const ordinaryInputs: Message[][] = [];
    const provider: LLMProvider = {
      id: 'mock',
      name: 'Mock',
      async complete() {
        throw new Error('unexpected non-streaming model call');
      },
      async *stream(params: CompletionParams) {
        const summarizing = params.systemPrompt === CONTEXT_COMPACTION_SYSTEM_PROMPT;
        if (summarizing) {
          summaryCalls++;
          await new Promise((resolve) => setTimeout(resolve, 20));
        } else {
          ordinaryCalls++;
          ordinaryInputs.push(params.messages);
        }
        const text = summarizing ? 'shared canonical model summary' : 'agent continued';
        yield { type: 'message_start' as const };
        yield { type: 'text_delta' as const, text };
        yield {
          type: 'message_end' as const,
          stopReason: 'end_turn' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          content: [{ type: 'text' as const, text }],
          model: 'mock-model',
        };
      },
      async validateAuth() { return true; },
    };
    const providers = new ProviderRegistry();
    providers.registerFactory('mock', () => provider);
    const config = createConfig({ agent: { defaultProvider: 'mock', defaultModel: 'mock-model' } });
    const sessionA = sessionWithCanonicalHistory(messages, source);
    const sessionB = sessionWithCanonicalHistory(messages, source);
    const runnerA = new AgentRunner({
      config, providers, session: sessionA, tools: [], sharedHistorySummaryCache: cacheA,
    });
    const runnerB = new AgentRunner({
      config, providers, session: sessionB, tools: [], sharedHistorySummaryCache: cacheB,
    });

    const [eventsA, eventsB] = await Promise.all([
      collectRunEvents(runnerA, 'agent A request'),
      collectRunEvents(runnerB, 'agent B request'),
    ]);

    const firstCheckpoint = await cacheA.read();
    expect(summaryCalls).toBe(1);
    expect(ordinaryCalls).toBe(2);
    expect([eventsA, eventsB].every((events) => events.some((event) => (
      event.type === 'done' && event.result.text === 'agent continued'
    )))).toBe(true);
    expect(firstCheckpoint).not.toBeNull();
    expect(firstCheckpoint?.throughTurnId).toBeGreaterThan(0);
    expect(firstCheckpoint?.throughMessageId)
      .toBe(`user-message-${firstCheckpoint?.throughTurnId}`);
    expect(sessionA.getSerializedContextState()?.summaryThroughMessageId)
      .toBe(firstCheckpoint?.throughMessageId);
    expect(sessionB.getSerializedContextState()?.summaryThroughMessageId)
      .toBe(firstCheckpoint?.throughMessageId);

    const cacheC = createConversationHistorySummaryCache({ uid, cid, source })!;
    const sessionC = sessionWithCanonicalHistory(messages, source);
    const runnerC = new AgentRunner({
      config, providers, session: sessionC, tools: [], sharedHistorySummaryCache: cacheC,
    });
    const eventsC = await collectRunEvents(runnerC, 'later agent request');

    expect(summaryCalls).toBe(1);
    expect(ordinaryCalls).toBe(3);
    expect(eventsC.some((event) => (
      event.type === 'context_status'
      && event.phase === 'history_summary_done'
      && event.data?.reused === true
    ))).toBe(true);
    expect(eventsC.some((event) => event.type === 'compaction')).toBe(false);
    expect(sessionC.getSerializedContextState()?.summaryThroughMessageId)
      .toBe(firstCheckpoint?.throughMessageId);
    expect(JSON.stringify(ordinaryInputs.at(-1))).toContain('shared canonical model summary');
    expect(JSON.stringify(ordinaryInputs.at(-1))).not.toContain('Canonical user 1 request ');
  });

  it('isolates summaries across both account and conversation boundaries', async () => {
    const nonce = `${Date.now()}${process.pid}`;
    const uidA = `summary-isolation-user-a-${nonce}`;
    const uidB = `summary-isolation-user-b-${nonce}`;
    const cidX = `summaryisolationx${nonce}`;
    const cidY = `summaryisolationy${nonce}`;
    const scopes = [
      { uid: uidA, cid: cidX, summary: 'account A conversation X' },
      { uid: uidA, cid: cidY, summary: 'account A conversation Y' },
      { uid: uidB, cid: cidX, summary: 'account B conversation X' },
    ];

    for (const [index, scope] of scopes.entries()) {
      await appendJsonl(conversationMessageFile(scope.uid, scope.cid), {
        id: `isolation-user-${index + 1}`,
        ts: '2026-01-01T00:00:00',
        from: 'user',
        to: ['commander'],
        text: scope.summary,
      });
      const cache = createConversationHistorySummaryCache({
        uid: scope.uid,
        cid: scope.cid,
        source: `group-main-v1:${scope.cid}`,
      })!;
      await writeSummary(cache, scope.summary, 1);
    }

    const readScope = (scope: typeof scopes[number]) => (
      createConversationHistorySummaryCache({
        uid: scope.uid,
        cid: scope.cid,
        source: `group-main-v1:${scope.cid}`,
      })!.read()
    );
    await expect(readScope(scopes[0])).resolves.toMatchObject({ summary: scopes[0].summary });
    await expect(readScope(scopes[1])).resolves.toMatchObject({ summary: scopes[1].summary });
    await expect(readScope(scopes[2])).resolves.toMatchObject({ summary: scopes[2].summary });

    await clearConversationHistorySummary(uidA, cidX);

    await expect(readScope(scopes[0])).resolves.toBeNull();
    await expect(readScope(scopes[1])).resolves.toMatchObject({ summary: scopes[1].summary });
    await expect(readScope(scopes[2])).resolves.toMatchObject({ summary: scopes[2].summary });
  });
});
