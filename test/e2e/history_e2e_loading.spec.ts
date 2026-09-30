import { expectComposerText } from './fixtures/composer';
import path from 'node:path';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createPackageWithOptions } from '@electron/asar';
import { expect, test, OrkasTestApp } from './fixtures/orkas';
import { analyzeWebAppLogs } from './fixtures/web-app-log-analysis';

const pcRoot = path.resolve(__dirname, '../..');
let previousKeepLogs: string | undefined;
test.beforeEach(() => {
  previousKeepLogs = process.env.ORKAS_E2E_KEEP_LOGS;
  process.env.ORKAS_E2E_KEEP_LOGS = '1';
});
test.afterEach(async ({}, info) => {
  if (previousKeepLogs === undefined) delete process.env.ORKAS_E2E_KEEP_LOGS;
  else process.env.ORKAS_E2E_KEEP_LOGS = previousKeepLogs;
  const file = info.outputPath('electron-main.log');
  expect(existsSync(file), 'Retain all main, renderer and cleanup logs on success too').toBe(true);
  const raw = readFileSync(file, 'utf8');
  let debuggerDisconnects = 0;
  const classified = raw.split(/\r?\n/).map(line => {
    // dispose() has already verified process exit. This exact Playwright
    // debugger lifecycle line is not an application error; raw logs stay intact.
    if (line === '[main:stderr] Waiting for the debugger to disconnect...') {
      debuggerDisconnects++;
      return '[main:stdout] [playwright-debugger] disconnect';
    }
    // Explicit fixture events are stdout, not continuations of preceding stderr.
    if (line.startsWith('[fixture-cleanup] ')) return `[main:stdout] ${line}`;
    return line;
  }).join('\n');
  const analysis = { ...analyzeWebAppLogs(classified), phase: 'history-loading', debuggerDisconnects };
  writeFileSync(info.outputPath('log-analysis.json'), JSON.stringify(analysis, null, 2));
  expect(analysis.passed, 'Review log-analysis.json for errors or incomplete coverage').toBe(true);
  if (analysis.requiresReview) console.warn('History E2E log warnings:', JSON.stringify(analysis.findings));
});


test('pages a long transcript without unloading bodies or replacing formulas and selects unread pages completely', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const app = new OrkasTestApp(testInfo, { configuredModel: false });
  try {
    await app.launch();
    const created = await app.invoke<any>('conversations.create', { title: 'Windowed history' });
    const cid = created.conversation.conversation_id;
    await app.electronApp!.evaluate(async (_electron, input) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const fs = require('node:fs');
      const uid = require(`${input.root}/src/main/features/users.ts`).getActiveUserId();
      const file = require(`${input.root}/src/main/util/project-layout.ts`).conversationMessageReadFile(uid, input.cid);
      const rows = Array.from({ length: 130 }, (_, i) => ({ id: `window-${i}`, from: 'commander', to: ['user'],
        ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        text: `Window ${i}: \\(x^2+y^2=z^2\\)\n\n` + Array.from({ length: 5 }, (_, n) => `Paragraph ${n} for message ${i}.`).join('\n\n'),
        ...(i === 1 ? { text: '', artifacts: [{ id: 'fixture-app', title: 'History application' }] } : {}),
      }));
      fs.writeFileSync(file, rows.map((row: unknown) => JSON.stringify(row)).join('\n') + '\n');
    }, { root: pcRoot, cid });
    const page = app.page!;
    await page.evaluate(async cid => { const w = window as any; await w.loadConversations(); w.setView('conversation', cid); }, cid);
    await expect(page.locator('[data-msg-id="window-129"] mjx-container')).toHaveCount(1);
    await page.evaluate(() => {
      const w = window as any;
      const row = document.querySelector('[data-msg-id="window-129"]')!;
      row.scrollIntoView({ block: 'center' });
      const math = row.querySelector('mjx-container')!;
      const rect = math.getBoundingClientRect();
      w.windowFormula = math;
      w.windowFormulaRect = { top: rect.top, height: rect.height };
      w.formulaFrames = { count: 0, unstable: 0, running: true };
      const frame = () => {
        if (!w.formulaFrames.running) return;
        w.formulaFrames.count++;
        const box = math.getBoundingClientRect();
        if (!math.isConnected || box.height < 1 || Math.abs(box.height - rect.height) > 1 || Math.abs(box.top - rect.top) > 2) w.formulaFrames.unstable++;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await page.evaluate(async cid => {
      const w = window as any;
      for (let n = 0; n < 9; n++) {
        const row = document.querySelector('.chat-history-load-earlier') as HTMLElement;
        await w._loadOlderConversationHistory(cid, Number(row.dataset.cursor));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
    }, cid);
    const mounted = await page.evaluate(() => {
      const w = window as any;
      w.formulaFrames.running = false;
      return { ...w.formulaFrames,
        rows: document.querySelectorAll('#chat-history .chat-message').length,
        bodies: document.querySelectorAll('#chat-history .chat-message > .chat-bubble').length,
        descendants: document.querySelectorAll('#chat-history *').length,
        retainedMath: Array.from(w.MathJax.startup.document.math).length,
      };
    });
    expect(mounted.count).toBeGreaterThan(10);
    expect(mounted.unstable).toBe(0);
    expect(mounted.rows).toBe(100);
    expect(mounted.bodies).toBe(100);
    // Already loaded messages keep their actual nodes when scrolled away and
    // back. Sampling each frame rejects a blank body or raw-TeX flash.
    const revisit = await page.evaluate(async () => {
      const w = window as any;
      const frames = [];
      for (const id of ['window-40', 'window-129']) {
        const row = document.querySelector(`[data-msg-id="${id}"]`)!;
        const math = row.querySelector('mjx-container')!;
        const size = math.getBoundingClientRect();
        row.scrollIntoView({ block: 'center', behavior: 'instant' });
        for (let i = 0; i < 4; i++) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const clone = row.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('mjx-container').forEach(node => node.remove());
          const box = math.getBoundingClientRect();
          frames.push({ sameNode: row.querySelector('mjx-container') === math && math.isConnected,
            latestRetained: w.windowFormula.isConnected,
            stableSize: box.height > 0 && Math.abs(box.height - size.height) < 1 && Math.abs(box.width - size.width) < 1,
            rawMath: clone.textContent!.includes('x^2+y^2=z^2'),
            body: clone.textContent!.includes('Paragraph 4') });
        }
      }
      return frames;
    });
    expect(revisit).toHaveLength(8);
    for (const frame of revisit) expect(frame).toEqual({ sameNode: true, latestRetained: true,
      stableSize: true, rawMath: false, body: true });
    // Select-all reads records independently of the mounted window.
    const selection = await page.evaluate(async () => {
      const w = window as any;
      const before = document.querySelectorAll('#chat-history .chat-message').length;
      w._enterMessageSelection(document.querySelector('#chat-history .chat-message'));
      await w._toggleAllMessageSelection();
      const payloads = await w._selectedMessagePayloads();
      return { before, after: document.querySelectorAll('#chat-history .chat-message').length,
        references: payloads.map((p: any) => p.reference.msgId),
        texts: payloads.map((p: any) => p.reference.text),
        completeBodies: payloads.filter((p: any) => p.reference.text.includes('Paragraph 4')).length };
    });
    expect(selection.after).toBe(selection.before);
    expect(selection.references).toEqual(Array.from({ length: 130 }, (_, i) => `window-${i}`));
    expect(selection.texts).toHaveLength(130);
    expect(selection.texts[0]).toContain('Window 0:');
    expect(selection.texts[129]).toContain('Window 129:');
    expect(selection.completeBodies).toBe(129);
    expect(selection.texts[1]).toContain('History application');
    await page.evaluate(() => (window as any)._exitMessageSelection());
    // An old search target initially reads one page; both directions remain reachable.
    await page.evaluate(async cid => (window as any).loadConversationHistory(cid, {
      searchTarget: { msgId: 'window-23', msgIndex: 23 },
    }), cid);
    await expect(page.locator('#chat-history .chat-message')).toHaveCount(10);
    await expect(page.locator('[data-msg-id="window-23"]')).toHaveClass(/search-flash/);
    await expect(page.locator('#chat-history-latest')).toBeVisible();
    await page.evaluate(async cid => (window as any)._loadNewerConversationHistory(cid), cid);
    await expect(page.locator('[data-msg-id="window-39"]')).toHaveCount(1);
    await page.locator('#chat-history-latest').click();
    await expect(page.locator('[data-msg-id="window-129"]')).toHaveCount(1);
    await expect(page.locator('#chat-history .chat-message')).toHaveCount(10);
    writeFileSync(testInfo.outputPath('history-window-evidence.json'), JSON.stringify({ mounted, revisit, selected: selection.references.length }));
  } finally { await app.dispose(); }
});

// A real search, wheel and composer journey. Only the model endpoint and the
// delivery timing of a real history request are controlled; IPC, persistence,
// live events and rendering use the production paths in an isolated workspace.
test('scrolls forward from a search hit and keeps a sent reply reachable when a history page arrives late', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const app = new OrkasTestApp(testInfo, { modelStub: true });
  try {
    await app.launch();
    const cid = (await app.invoke<any>('conversations.create', { title: 'Search then send' })).conversation.conversation_id;
    await app.electronApp!.evaluate(async (_electron, input) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const uid = require(`${input.root}/src/main/features/users.ts`).getActiveUserId();
      const file = require(`${input.root}/src/main/util/project-layout.ts`).conversationMessageReadFile(uid, input.cid);
      require('node:fs').writeFileSync(file, Array.from({ length: 35 }, (_, i) => JSON.stringify({
        id: `search-send-${i}`, from: 'commander', to: ['user'],
        ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        text: `${i === 23 ? 'middlepageanchor' : `History ${i}`} \\(x^2+y^2=z^2\\)\n\n`
          + Array.from({ length: 5 }, (_, n) => `Paragraph ${n} in message ${i}.`).join('\n\n'),
      })).join('\n') + '\n');
      await require(`${input.root}/src/main/features/search/indexer.ts`).reconcileChatsIndex(uid);
    }, { root: pcRoot, cid });
    const page = app.page!;
    await page.evaluate(() => (window as any).loadConversations());
    const openSearchHit = async () => {
      await page.locator('#sidebar-search-btn').click();
      await page.locator('#search-input').fill('middlepageanchor');
      const hit = page.locator('#search-body .search-result').filter({ hasText: 'middlepageanchor' });
      await expect(hit).toHaveCount(1);
      await hit.click();
      await expect(page.locator('[data-msg-id="search-send-23"]')).toHaveClass(/search-flash/);
      await expect(page.locator('#chat-history .chat-message')).toHaveCount(10);
    };
    const history = page.locator('#chat-history');
    const wheelToBottom = async () => {
      await history.hover({ position: { x: 40, y: 80 } });
      await page.mouse.wheel(0, 100_000);
    };
    await openSearchHit();
    await wheelToBottom();
    await expect(page.locator('[data-msg-id="search-send-34"]')).toHaveCount(1);
    await expect(page.locator('.chat-history-load-newer')).toHaveCount(0);
    expect(await history.locator('.chat-message').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.msgId)))
      .toEqual(Array.from({ length: 15 }, (_, i) => `search-send-${i + 20}`));

    await openSearchHit();
    await page.evaluate(() => {
      const w = window as any;
      const original = w.apiFetch;
      const gate = new Promise<void>(resolve => { w.releaseForwardHistory = resolve; });
      w.forwardHistoryHeld = false;
      w.apiFetch = async (url: string, options: unknown) => {
        if (url.includes('/history?') && url.includes('&after=')) {
          w.forwardHistoryHeld = true;
          await gate;
        }
        return original(url, options);
      };
    });
    await wheelToBottom();
    await expect.poll(() => page.evaluate(() => (window as any).forwardHistoryHeld)).toBe(true);
    app.setModelMode('controlled-slow');
    const prompt = 'Continue this conversation from the historical search result.';
    await page.locator('#chat-input').fill(prompt);
    await page.locator('#chat-input').press('Enter');
    const sent = history.locator('.chat-message.user').filter({ hasText: prompt });
    await expect(sent).toHaveCount(1);
    await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);
    app.releaseControlledModelChunk();
    const reply = history.locator('.chat-message.assistant').filter({ hasText: 'Hello from the local E2E model.' });
    await expect(reply).toHaveCount(1);
    await wheelToBottom();
    await expect(reply).toBeInViewport();
    await expect.poll(() => history.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(2);
    // The user's wheel must release the send-time pin before stream completion.
    expect(await history.evaluate(el => !!(el as any)._scrollPinActive)).toBe(false);
    app.finishControlledModelStream();
    await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
    await expect(reply).toHaveAttribute('data-msg-id', /.+/);
    await wheelToBottom();
    await expect.poll(() => history.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(2);
    const replyTop = await reply.evaluate(el => el.getBoundingClientRect().top);
    await page.evaluate(() => (window as any).releaseForwardHistory());
    await expect(page.locator('.chat-history-load-newer')).toHaveCount(0);
    await expect(sent).toHaveCount(1);
    await expect(reply).toHaveCount(1);
    await expect(reply).toBeInViewport();
    await expect.poll(() => history.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(2);
    const ids = await history.locator('.chat-message[data-msg-id]').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.msgId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 15)).toEqual(Array.from({ length: 15 }, (_, i) => `search-send-${i + 20}`));
    const persisted = await app.invoke<any>('conversations.history', { cid, limit: 10 });
    expect(persisted.history.filter((row: any) => row.from === 'user' && row.text === prompt)).toHaveLength(1);
    expect(persisted.history.filter((row: any) => row.text === 'Hello from the local E2E model.')).toHaveLength(1);
    writeFileSync(testInfo.outputPath('search-send-evidence.json'), JSON.stringify({ ids, replyTop, persisted: true }));
  } finally { await app.dispose(); }
});

test('joins native turns across forward pages while new replies remain beyond the history gap', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const app = new OrkasTestApp(testInfo, { configuredModel: false });
  try {
    await app.launch();
    const cid = (await app.invoke<any>('conversations.create', { title: 'Segment window' })).conversation.conversation_id;
    await app.electronApp!.evaluate(async (_electron, input) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const uid = require(`${input.root}/src/main/features/users.ts`).getActiveUserId();
      const file = require(`${input.root}/src/main/util/project-layout.ts`).conversationMessageReadFile(uid, input.cid);
      const rows = Array.from({ length: 30 }, (_, i) => ({ id: `segment-${i}`, to: ['user'],
        from: i >= 8 && i <= 14 ? 'codex-fixture' : 'commander',
        ...(i >= 8 && i <= 14 ? { turn_id: 'native-window', seg: i - 8 } : {}),
        ts: new Date(1_700_000_000_000 + i * 1000).toISOString(), text: `Segment ${i}: \\(x^2\\)`
          + ((i < 8 || (i > 14 && i < 29)) ? '\n\n' + 'A paragraph for scrolling.\n\n'.repeat(6) : '') }));
      require('node:fs').writeFileSync(file, rows.map((row: unknown) => JSON.stringify(row)).join('\n') + '\n');
    }, { root: pcRoot, cid });
    const page = app.page!;
    await page.evaluate(async cid => { const w = window as any; await w.loadConversations(); w.setView('conversation', cid); }, cid);
    await expect(page.locator('[data-msg-id="segment-29"]')).toHaveCount(1);
    await page.evaluate(async cid => (window as any).loadConversationHistory(cid, {
      searchTarget: { msgId: 'segment-9', msgIndex: 9 },
    }), cid);
    await expect(page.locator('[data-msg-id="segment-9"] mjx-container')).toHaveCount(1);
    await page.evaluate(() => {
      const w = window as any;
      w.segmentMath = document.querySelector('[data-msg-id="segment-9"] mjx-container');
      w.segmentFrames = { running: true, count: 0, invisible: 0 };
      const frame = () => {
        if (!w.segmentFrames.running) return;
        w.segmentFrames.count++;
        if (!w.segmentMath.isConnected || w.segmentMath.getBoundingClientRect().height < 1) w.segmentFrames.invisible++;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await page.evaluate(async cid => (window as any)._loadNewerConversationHistory(cid), cid);
    await expect(page.locator('#chat-history [data-turn-id="native-window"]')).toHaveCount(1);
    await expect(page.locator('[data-msg-id="segment-14"]')).toContainText('Segment 14:');
    expect(await page.evaluate(() => (window as any).segmentMath.isConnected)).toBe(true);
    expect(await page.evaluate(() => (window as any).segmentMath.getBoundingClientRect().height)).toBeGreaterThan(0);
    const segmentFrames = await page.evaluate(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      (window as any).segmentFrames.running = false;
      return (window as any).segmentFrames;
    });
    expect(segmentFrames.count).toBeGreaterThan(1);
    expect(segmentFrames.invisible).toBe(0);
    for (let i = 8; i < 14; i++) await expect(page.locator(`[data-msg-id="segment-14"] .chat-turn-narration[data-narration-seg="${i - 8}"]`)).toContainText(`Segment ${i}:`);
    const referenceText = await page.evaluate(() => (window as any)._messageReferencePayload(
      document.querySelector('[data-msg-id="segment-14"]'),
    ).text);
    for (let i = 8; i <= 14; i++) expect(referenceText).toContain(`Segment ${i}:`);
    // Actual bus delivery while reading the old window: keep its gap boundary
    // and do not let the next page duplicate the arriving newest record.
    await page.evaluate(cid => {
      const w = window as any;
      const live = w._ensureActorPlaceholder(cid, 'commander', null, 'late-turn', '', 1_700_000_029_000, 0);
      w._streamingAppendFinalDelta(live, 'Segment 29: ');
      w._handleGroupBusEvent(cid, live, {
        type: 'message', turn_end: true, msg: { id: 'segment-29', from: 'commander', to: ['user'],
          turn_id: 'late-turn', seg: 0,
          ts: new Date(1_700_000_029_000).toISOString(), text: 'Segment 29: \\(x^2\\)' },
      });
    }, cid);
    expect(await page.evaluate(() => {
      const gap = document.querySelector('.chat-history-load-newer')!;
      const latest = document.querySelector('[data-msg-id="segment-29"]')!;
      return !!(gap.compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    // Exercise the event handler and observe its result. The production scroll
    // path also dispatches without awaiting the internal Promise; waiting on
    // that cross-realm Promise through CDP can lose its execution context.
    const beforeForward = await page.evaluate(() => performance.timeOrigin);
    await page.locator('.chat-history-load-newer').dispatchEvent('click');
    await expect(page.locator('[data-msg-id="segment-29"]')).toHaveCount(1);
    await expect(page.locator('.chat-history-load-newer')).toHaveCount(0);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(beforeForward);
    await page.evaluate(async () => {
      document.querySelector('[data-msg-id="segment-29"]')!.scrollIntoView({ block: 'end', behavior: 'instant' });
    });
    expect(await page.evaluate(() => (window as any).segmentMath.isConnected)).toBe(true);
    await page.evaluate(async () => {
      document.querySelector('[data-msg-id="segment-14"]')!.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await expect(page.locator('[data-msg-id="segment-14"] mjx-container')).toHaveCount(2);
    for (let i = 8; i < 14; i++) await expect(page.locator(`[data-msg-id="segment-14"] .chat-turn-narration[data-narration-seg="${i - 8}"]`)).toContainText(`Segment ${i}:`);
  } finally { await app.dispose(); }
});

test('opens large history through IPC, preserves formulas and expands complete tool output', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const app = new OrkasTestApp(testInfo, { configuredModel: false });
  try {
    await app.launch();
    const created = await app.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Large history fixture' });
    const cid = created.conversation.conversation_id;
    const evidence = await app.electronApp!.evaluate(async (_electron, input) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const fs = require('node:fs');
      const uid = require(`${input.root}/src/main/features/users.ts`).getActiveUserId();
      const file = require(`${input.root}/src/main/util/project-layout.ts`).conversationMessageReadFile(uid, input.cid);
      const rows = Array.from({ length: 30 }, (_, i) => ({ id: `history-${i}`, from: 'commander', to: ['user'],
        ts: new Date(1_700_000_000_000 + i * 1000).toISOString(), text: `History ${i}: \\(x^2+y^2=z^2\\)`,
        process: Array.from({ length: 80 }, (_, n) => ({ type: 'event', event: { stream: 'tool',
          data: { phase: 'end', id: `tool-${i}-${n}`, name: 'bash', output: `output-${i}-${n}\n` + 'x'.repeat(32768) } } })) }));
      fs.writeFileSync(file, rows.map((r: unknown) => JSON.stringify(r)).join('\n') + '\n');
      const cache = require(`${input.root}/src/main/features/conversation_history_cache.ts`);
      let last = performance.now(), gap = 0;
      const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 2);
      await new Promise(r => setTimeout(r, 10));
      const start = performance.now();
      const latest = await cache.readConversationHistoryPage(uid, file, 10);
      await new Promise(r => setTimeout(r, 10));
      clearInterval(timer);
      const first = latest.records[0].process[0].event.data;
      return { elapsed: performance.now() - start, gap, ids: latest.records.map((r: any) => r.id),
        lazyComplete: fs.readFileSync(first.result_path, 'utf8') === 'output-20-0\n' + 'x'.repeat(32768) };
    }, { root: pcRoot, cid });
    writeFileSync(testInfo.outputPath('history-performance.json'), JSON.stringify(evidence));
    await testInfo.attach('history-performance.json', { body: JSON.stringify(evidence), contentType: 'application/json' });
    expect(evidence.gap).toBeLessThan(150);
    expect(evidence.lazyComplete).toBe(true);
    expect(evidence.ids).toEqual(Array.from({ length: 10 }, (_, i) => `history-${i + 20}`));
    const result = await app.invoke<any>('conversations.history', { cid, limit: '10', live: '1' });
    expect(result.history.map((r: any) => r.id)).toEqual(evidence.ids);
    expect(result.live_display.turns).toEqual([]);
    const older = await app.invoke<any>('conversations.history', { cid, limit: '10', before: String(result.next_cursor) });
    expect(older.history.map((r: any) => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `history-${i + 10}`));
    const page = app.page!;
    await page.evaluate(async cid => { const w = window as any; await w.loadConversations(); w.setView('conversation', cid); }, cid);
    await expect(page.locator('#chat-history .chat-message')).toHaveCount(10);
    await expect(page.locator('#chat-history mjx-container')).toHaveCount(10);
    const last = page.locator('#chat-history .chat-message').last();
    await expect(last).toContainText('History 29:');
    // Opening a folded history process must materialize its rows, while math
    // already painted in the answer keeps its DOM node and geometry.
    await page.evaluate(() => {
      const w = window as any;
      const math = document.querySelector('#chat-history mjx-container')!;
      w.historyMath = math;
      w.historyMathSize = math.getBoundingClientRect().height;
      w.historyMathChanges = 0;
      w.historyObserver = new MutationObserver(() => {
        if (!math.isConnected || Math.abs(math.getBoundingClientRect().height - w.historyMathSize) > 1) w.historyMathChanges++;
      });
      w.historyObserver.observe(document.querySelector('#chat-history')!, { subtree: true, childList: true, attributes: true });
    });
    await last.locator('details.stream-process summary').click();
    await expect(last.locator('.stream-process-body')).not.toBeEmpty();
    expect(await page.evaluate(() => { const w = window as any; w.historyObserver.disconnect(); return w.historyMathChanges; })).toBe(0);
    expect(app.modelRequests).toHaveLength(0);
  } finally { await app.dispose(); }
});

test('loads and projects history from ASAR with the shipped dependency layout', async ({}, testInfo) => {
  const app = new OrkasTestApp(testInfo, { configuredModel: false });
  try {
    const source = path.join(app.root, 'package-source');
    const archive = path.join(app.root, 'fixture.asar');
    const pkg = JSON.parse(readFileSync(path.join(pcRoot, 'package.json'), 'utf8'));
    mkdirSync(source, { recursive: true });
    cpSync(path.join(pcRoot, 'src/main'), path.join(source, 'src/main'), { recursive: true });
    for (const file of ['package.json', 'tsconfig.json']) cpSync(path.join(pcRoot, file), path.join(source, file));
    for (const name of ['tsx', 'get-tsconfig', 'resolve-pkg-maps', 'esbuild', `@esbuild/${process.platform}-${process.arch}`,
      'electron-log', 'async-mutex', 'tslib']) {
      cpSync(path.join(pcRoot, 'node_modules', name), path.join(source, 'node_modules', name), { recursive: true, dereference: true });
    }
    const unpack = pkg.build.asarUnpack.map((p: string) => path.join(source, p).replaceAll('\\', '/'));
    await createPackageWithOptions(source, archive, { unpack: `{${unpack.join(',')}}` });
    const esbuild = path.join(`${archive}.unpacked`, 'node_modules', '@esbuild', `${process.platform}-${process.arch}`,
      ...(process.platform === 'win32' ? ['esbuild.exe'] : ['bin', 'esbuild']));
    await app.launch();
    const result = await app.electronApp!.evaluate(async (_electron, input) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const old = process.env.ESBUILD_BINARY_PATH;
      process.env.ESBUILD_BINARY_PATH = input.esbuild;
      const { ConversationHistoryWorker } = require(`${input.archive}/src/main/features/conversation-history-client.ts`);
      const fs = require('node:fs');
      const file = require('node:path').join(input.root, 'packaged-history.jsonl');
      fs.writeFileSync(file, JSON.stringify({ id: 'saved', text: 'packaged history', process: [{ type: 'event', event: {
        stream: 'tool', data: { phase: 'end', name: 'bash', output: 'z'.repeat(4096) } } }] }) + '\n');
      const worker = new ConversationHistoryWorker();
      let workerFailure = '';
      (worker as any).worker.once('error', (error: Error) => { workerFailure = error.message; });
      try {
        const page = await worker.request({ kind: 'page', userId: 'packaged-fixture', sourceFile: file, limit: 10 });
        const { appendJsonlAtomic } = require(`${input.archive}/src/main/storage.ts`);
        const msg = { id: 'packaged-user', from: 'user', text: 'packaged user message' };
        await appendJsonlAtomic(file, msg, true);
        const anchor = await worker.request({ kind: 'window', userId: 'packaged-fixture', sourceFile: file, start: 0, limit: 1 });
        const following = await worker.request({ kind: 'window', userId: 'packaged-fixture', sourceFile: file, start: 0,
          after: anchor.followingCursor, limit: 1 });
        const turns = await worker.request({ kind: 'turns', userId: 'packaged-fixture', cid: 'packaged-chat', sourceFile: file });
        const indexFile = require(`${input.archive}/src/main/paths.ts`).userConversationTurnIndexPath('packaged-fixture', 'packaged-chat');
        const indexPersisted = fs.existsSync(indexFile);
        await worker.request({ kind: 'turn-purge', userId: 'packaged-fixture', cid: 'packaged-chat', sourceFile: '' });
        return { turns: turns.turns, indexPersisted, indexPurged: !fs.existsSync(indexFile), text: page.records[0].text, output: fs.readFileSync(page.records[0].process[0].event.data.result_path, 'utf8'),
          windowIds: [...anchor.records, ...following.records].map((row: any) => row.id), followingCursor: following.followingCursor };
      } catch (error) {
        throw new Error(workerFailure || String(error));
      } finally {
        await worker.close();
        if (old === undefined) delete process.env.ESBUILD_BINARY_PATH;
        else process.env.ESBUILD_BINARY_PATH = old;
      }
    }, { archive, esbuild, root: app.root });
    expect(result).toEqual({ turns: [{ messageId: 'packaged-user', clientMessageId: '', messageIndex: 1,
      userPreview: 'packaged user message', assistantPreview: '', turnNo: 1 }], indexPersisted: true, indexPurged: true, text: 'packaged history', output: 'z'.repeat(4096),
      windowIds: ['saved', 'packaged-user'], followingCursor: null });
  } finally { await app.dispose(); }
});

test('builds cold turn navigation without flashing formulas, accepts input and jumps into older history', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const app = new OrkasTestApp(testInfo, { configuredModel: false });
  try {
    await app.launch();
    const { conversation } = await app.invoke<any>('conversations.create', { title: 'Cold turn navigation' });
    const cid = conversation.conversation_id;
    await app.electronApp!.evaluate(async (_electron, { root, cid }) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const uid = require(`${root}/src/main/features/users.ts`).getActiveUserId();
      const file = require(`${root}/src/main/util/project-layout.ts`).conversationMessageReadFile(uid, cid);
      const rows = Array.from({ length: 32 }, (_, i) => [
        { id: `u${i}`, from: 'user', text: `Question ${i}`, to: ['commander'] },
        { id: `a${i}`, from: 'commander', to: ['user'], text: i === 0 ? 'x'.repeat(8 * 1024 * 1024) : `Answer ${i}: \\(x^2+y^2=z^2\\)` },
      ]).flat().map((r, i) => ({ ...r, ts: new Date(1_700_000_000_000 + i * 1000).toISOString() }));
      require('node:fs').writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    }, { root: pcRoot, cid });
    const page = app.page!;
    await page.evaluate(async cid => { const w = window as any; await w.loadConversations(); w.setView('conversation', cid); }, cid);
    await expect(page.locator('#chat-history mjx-container')).toHaveCount(5);
    await expect(page.locator('#chat-turn-nav .chat-turn-nav-marker')).toHaveCount(15);
    // Force a real cold scan after the initial transcript is painted. No mocked
    // IPC/page loader: exercise the same client, entry and store as production.
    await app.electronApp!.evaluate(async (_electron, { root, cid }) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const uid = require(`${root}/src/main/features/users.ts`).getActiveUserId();
      await require(`${root}/src/main/features/chats.ts`).purgeConversationTurnIndex(uid, cid);
      let last = performance.now();
      const probe = (globalThis as any).turnProbe = { gap: 0, ticks: 0, timer: undefined as any };
      probe.timer = setInterval(() => { const now = performance.now(); probe.gap = Math.max(probe.gap, now - last); last = now; probe.ticks++; }, 2);
    }, { root: pcRoot, cid });
    await page.evaluate(cid => {
      const w = window as any;
      const math = Array.from(document.querySelectorAll('#chat-history mjx-container'));
      const sizes = math.map(node => node.getBoundingClientRect().height);
      const history = document.getElementById('chat-history')!;
      const probe = w.turnFrameProbe = { frames: 0, unstable: 0, removals: 0, running: true };
      const observer = new MutationObserver(() => {
        if (math.some(node => !node.isConnected)) probe.removals++;
      });
      observer.observe(history, { childList: true, subtree: true });
      w.turnFrameObserver = observer;
      const sample = () => {
        if (!probe.running) return;
        probe.frames++;
        if (math.some((node, i) => !node.isConnected || node.getBoundingClientRect().height < 1
          || Math.abs(node.getBoundingClientRect().height - sizes[i]) > 1)) probe.unstable++;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      w.coldTurnResult = w.orkas.invoke('conversations.turns', { cid });
    }, cid);
    await page.locator('#chat-input').fill('Draft during cold navigation 🌟');
    await expectComposerText(page.locator('#chat-input'), 'Draft during cold navigation 🌟');
    const result = await page.evaluate(async () => (window as any).coldTurnResult);
    expect(result.turns.map((t: any) => t.message_id)).toEqual(Array.from({ length: 15 }, (_, i) => `u${i + 17}`));
    expect(result.next_cursor).toBe(17);
    await expect.poll(() => page.evaluate(() => (window as any).turnFrameProbe.frames)).toBeGreaterThanOrEqual(4);
    const visual = await page.evaluate(() => {
      const w = window as any; w.turnFrameProbe.running = false; w.turnFrameObserver.disconnect(); return w.turnFrameProbe;
    });
    expect(visual.unstable).toBe(0);
    expect(visual.removals).toBe(0);
    const timing = await app.electronApp!.evaluate(() => {
      const probe = (globalThis as any).turnProbe; clearInterval(probe.timer); return { gap: probe.gap, ticks: probe.ticks };
    });
    expect(timing.ticks).toBeGreaterThan(0);
    expect(timing.gap).toBeLessThan(150);
    writeFileSync(testInfo.outputPath('turn-navigation-performance.json'), JSON.stringify({ ...timing, ...visual }));
    // This turn is outside the mounted latest ten messages. Clicking its real
    // rail marker must load an anchored window and render its exact formula.
    await page.locator('#chat-turn-nav [data-turn-key="m:u20"]').click();
    await expect(page.locator('#chat-history [data-msg-id="u20"]')).toContainText('Question 20');
    await expect(page.locator('#chat-history [data-msg-id="a20"] mjx-container')).toHaveCount(1);
    await expect(page.locator('#chat-turn-nav [aria-current="location"]')).toHaveAttribute('data-turn-key', 'm:u20');
    expect(app.modelRequests).toHaveLength(0);
  } finally { await app.dispose(); }
});
