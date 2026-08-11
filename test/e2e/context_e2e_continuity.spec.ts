import { expect, test } from './fixtures/orkas';
import { contextBudget } from '../../src/core-agent/src/agent/context-budget';
import { estimateTextTokens } from '../../src/core-agent/src/agent/session';

/**
 * Fixture pressure is derived, not hand-tuned, because it sits between two
 * product limits that both move.
 *
 * Upper bound per file: a tool result over the per-result inline budget spills
 * to disk instead of entering the context, so an oversized fixture would build
 * no pressure at all.
 *
 * Lower bound in aggregate: the active-process trigger derives from the model
 * window, and the E2E model is Orkas LLM (1M), whose trigger saturates the
 * budget module's ceiling. The files must exceed that together or compaction
 * never fires — and a fixture that has quietly stopped applying pressure fails
 * as "0 compactions", which reads like a compaction bug rather than a sizing
 * problem. `assertFixturePressure` below turns that into a self-explaining
 * failure, and the counts are recomputed here whenever either limit changes.
 */

/** Mirrors `DEFAULT_INLINE_RESULT_TOKENS` in `src/main/util/tool-result-cap.ts`,
 *  which cannot be imported here: it pulls in the Electron logger. The pressure
 *  assertion below fails loudly if the real value ever drops below this. */
const PER_RESULT_INLINE_TOKENS = 12_500;
/** Stay under the spill line with room for the estimator's own error. */
const PER_FILE_TOKEN_TARGET = Math.floor(PER_RESULT_INLINE_TOKENS * 0.9);
/** Exceed the trigger by enough that a small threshold change does not silently
 *  drop the run below it. */
const AGGREGATE_PRESSURE_RATIO = 1.12;

/** The E2E model is Orkas LLM: a 1M window, and a fixed overhead large enough
 *  to be realistic without needing the real prompt here. */
const E2E_ACTIVE_TRIGGER = contextBudget({
  usableInputTokens: 1_048_576 - 8_192 - 2_048,
  fixedOverheadTokens: 30_000,
}).activeProcessTrigger;

const CONTEXT_PRESSURE_ROWS = pressureRowsFor(PER_FILE_TOKEN_TARGET);
const SOURCE_COUNT = Math.max(
  3,
  Math.ceil((E2E_ACTIVE_TRIGGER * AGGREGATE_PRESSURE_RATIO) / PER_FILE_TOKEN_TARGET),
);

/** Rows needed for one fixture to reach the per-file token target, measured
 *  with the same estimator the compaction triggers use. */
function pressureRowsFor(targetTokens: number): number {
  const sampleRow = pressureRow('SAMPLE', 0);
  const perRow = Math.max(1, estimateTextTokens(`${sampleRow}\n`));
  return Math.max(1, Math.floor(targetTokens / perRow));
}

function pressureRow(label: string, index: number): string {
  return `${label}-evidence-${String(index).padStart(3, '0')} `
    + 'synthetic observation retained only to create realistic active-turn context pressure';
}

/**
 * Fail with the real reason instead of a bare count mismatch.
 *
 * A fixture that no longer applies pressure and a compaction engine that no
 * longer runs produce the same symptom. Separating them here keeps a threshold
 * change from being investigated as a product regression.
 */
function assertFixturePressure(compactionCount: number): void {
  const perFile = estimateTextTokens(contextPressureFixture('KEEP01', 'E2E_CTX_KEEP01=ALPHA-1'));
  const aggregate = perFile * SOURCE_COUNT;
  const sizing = `per-file ~${perFile} tokens x ${SOURCE_COUNT} files = ~${aggregate}; `
    + `derived active trigger ${E2E_ACTIVE_TRIGGER}; per-result spill line ${PER_RESULT_INLINE_TOKENS}`;
  expect(
    perFile,
    `Fixture exceeds the per-result inline budget, so each read spills to disk and builds no context pressure (${sizing})`,
  ).toBeLessThan(PER_RESULT_INLINE_TOKENS);
  expect(
    aggregate,
    `Fixture no longer exceeds the derived active trigger, so compaction cannot fire (${sizing})`,
  ).toBeGreaterThan(E2E_ACTIVE_TRIGGER);
  expect(
    compactionCount,
    `Fixture pressure is sufficient but no compaction ran — this is a compaction failure, not fixture sizing (${sizing})`,
  ).toBeGreaterThanOrEqual(1);
}

function contextPressureFixture(label: string, fact: string): string {
  const rows = Array.from(
    { length: CONTEXT_PRESSURE_ROWS },
    (_, index) => pressureRow(label, index),
  );
  return [
    `BEGIN ${label} EVIDENCE`,
    fact,
    ...rows,
    `END ${label} EVIDENCE`,
  ].join('\n');
}

/** One fact per source, each unique so a summary that drops any of them fails. */
function contextSources(
  prefix: string,
  seeds: readonly string[],
): Array<{ label: string; fact: string }> {
  return Array.from({ length: SOURCE_COUNT }, (_, index) => {
    const label = `${prefix}${String(index + 1).padStart(2, '0')}`;
    const seed = seeds[index % seeds.length];
    return { label, fact: `E2E_CTX_${label}=${seed}-${index + 1}` };
  });
}

test.describe('long-task context continuity', () => {
  test('compacts real tool context, preserves exact facts, and restores one readable result', async ({
    modelOrkas,
  }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    let page = modelOrkas.page;
    const sources = contextSources('KEEP', ['ALPHA', 'BETA', 'GAMMA']).map(({ label, fact }) => ({
      path: modelOrkas.createWorkspaceFile(
        `context-pressure/${label.toLowerCase()}.txt`,
        contextPressureFixture(label, fact),
      ),
      fact,
    }));
    const finalReply = `Context survived: ${sources.map((source) => source.fact).join('; ')}`;
    modelOrkas.setContextCompactionScenario(sources, finalReply);

    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill(
      'Read every evidence file exactly once and return every E2E_CTX decision after the long task.',
    );
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);

    const liveReply = page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
    );
    await expect(liveReply.locator('[data-role="final"]')).toContainText(finalReply, {
      timeout: 30_000,
    });
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    const compactionRequests = modelOrkas.modelRequests.filter((request) => (
      JSON.stringify(request).includes('You are a context compaction engine.')
    ));
    assertFixturePressure(compactionRequests.length);
    const compactionCount = compactionRequests.length;
    const finalRequest = JSON.stringify(modelOrkas.modelRequests.at(-1));
    for (const source of sources) expect(finalRequest).toContain(source.fact);

    const liveProcess = liveReply.locator('.stream-process');
    await expect(liveProcess).toBeVisible();
    await liveProcess.locator('.stream-process-summary').click();
    await expect(liveProcess.locator('.stream-process-body')).toContainText(
      'Current task progress organized',
    );
    // One rendered line per compaction that actually ran: the process view must
    // neither drop nor duplicate them, whatever the thresholds make that number.
    await expect(liveProcess.locator('.stream-process-line', {
      hasText: /Current task progress organized/,
    })).toHaveCount(compactionCount);
    // Start and terminal events for one tool call are reconciled into one
    // localized row. Every evidence read stays visible without duplicate rows,
    // so compaction folded context without dropping steps.
    await expect(liveProcess.locator('.stream-process-line', {
      hasText: /^Read file\b/,
    })).toHaveCount(SOURCE_COUNT);

    const conversationId = await page.locator('#conversation-list .conv-item').first()
      .getAttribute('data-cid');
    expect(conversationId).toBeTruthy();
    const requestsBeforeRelaunch = modelOrkas.modelRequests.length;

    await page.evaluate(async () => {
      await (window as any).setLang('pt');
    });
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    page = await modelOrkas.relaunch();
    await page.locator(`.conv-item[data-cid="${conversationId}"]`).click();
    const restoredReply = page.locator(
      '#chat-history .chat-message.assistant[data-from-actor="commander"]',
      { hasText: finalReply },
    );
    await expect(restoredReply).toHaveCount(1);
    const restoredProcess = restoredReply.locator('.stream-process');
    await expect(restoredProcess).toBeVisible();
    await restoredProcess.locator('.stream-process-summary').click();
    await expect(restoredProcess.locator('.stream-process-line', {
      hasText: /Progresso da tarefa atual organizado/,
    })).toHaveCount(compactionCount);
    await expect(restoredProcess).not.toContainText('Current task progress organized');
    await expect(restoredProcess).not.toContainText('当前任务进展已整理');
    await expect(restoredProcess.locator('.stream-process-line', {
      hasText: /^Ler arquivo\b/,
    })).toHaveCount(SOURCE_COUNT);
    expect(modelOrkas.modelRequests).toHaveLength(requestsBeforeRelaunch);
  });

  test('stops a stalled context compaction without a late response or replay', async ({
    modelOrkas,
  }) => {
    if (!modelOrkas.page) throw new Error('Orkas renderer is unavailable');
    let page = modelOrkas.page;
    const sources = contextSources('STOP', ['cedar', 'iris', 'quartz']).map(({ label, fact }) => ({
      path: modelOrkas.createWorkspaceFile(
        `context-cancel/${label.toLowerCase()}.txt`,
        contextPressureFixture(label, fact),
      ),
      fact,
    }));
    const forbiddenFinal = 'This final response must never appear after cancellation.';
    modelOrkas.setContextCompactionScenario(sources, forbiddenFinal, {
      stallCompaction: true,
    });

    await page.locator('#new-chat-btn').click();
    await page.locator('#new-chat-input').fill(
      'Read all cancellation fixtures, then finish only after context compaction.',
    );
    await page.locator('#new-chat-send-btn').click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
    await expect.poll(() => modelOrkas.modelRequests.filter((request) => (
      JSON.stringify(request).includes('You are a context compaction engine.')
    )).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);

    const requestCountAtStop = modelOrkas.modelRequests.length;
    await page.locator('#chat-send-btn').click();
    await expect(page.locator('#chat-history .stream-aborted-note')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect.poll(() => modelOrkas.compactionRequestAborts, {
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(500);
    await expect(page.locator('#chat-history .chat-message.assistant')).not.toContainText(
      forbiddenFinal,
    );
    expect(modelOrkas.modelRequests).toHaveLength(requestCountAtStop);

    const conversationId = await page.locator('#conversation-list .conv-item').first()
      .getAttribute('data-cid');
    expect(conversationId).toBeTruthy();
    page = await modelOrkas.relaunch();
    await page.locator(`.conv-item[data-cid="${conversationId}"]`).click();
    await expect(page.locator('#chat-history .chat-message.user')).toHaveCount(1);
    await expect(page.locator('#chat-history .chat-message.assistant')).toContainText('(stopped)');
    await expect(page.locator('#chat-history .chat-message.assistant')).not.toContainText(
      forbiddenFinal,
    );
    expect(modelOrkas.modelRequests).toHaveLength(requestCountAtStop);
  });
});
