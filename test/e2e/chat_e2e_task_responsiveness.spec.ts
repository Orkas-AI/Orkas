import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, OrkasTestApp, test } from './fixtures/orkas';
import { expectComposerText } from './fixtures/composer';
import { checkLatencyBudget, INTERACTIVE_MAIN_GAP_LIMIT_MS, LATENCY_LIMIT_MS } from '../helpers/latency-budget';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const variants: Array<{ tasks: number; stall: boolean; stop: boolean; rendererStall?: boolean }> = [
  { tasks: 1, stall: false, stop: false }, { tasks: 4, stall: false, stop: false },
  { tasks: 8, stall: false, stop: false }, { tasks: 4, stall: true, stop: false },
  { tasks: 4, stall: false, stop: true }, { tasks: 4, stall: false, stop: false, rendererStall: true },
];

// Real renderer IPC -> host admission -> SDK/local protocol -> file tools ->
// persistence. Only provider decisions/arrival barriers are scripted; native
// files, user interaction, cancellation and native receipts are independent oracles.
for (const variant of variants) test(`keeps foreground usable during ${variant.tasks} file tasks (stall=${variant.stall}, stop=${variant.stop}, rendererStall=${!!variant.rendererStall})`, async ({}, info) => {
  test.setTimeout(120_000);
  const app = new OrkasTestApp(info, { modelStub: true, marketplaceStub: true, seedLanguage: 'en' });
  const work = gate(), finish = gate(), stoppedResponse = gate();
  const parked = new Set<number>(), completed = new Set<number>();
  const confirmedWork = new Map<number, Set<string>>();
  let stopReady = false;
  const operations = 8, bytes = 64 * 1024;
  const payload = (task: number, step: number) => `${task}:${step}\n` + 'x'.repeat(bytes - `${task}:${step}\n`.length);
  const jobs: Array<{ cid: string; marker: string; directory: string }> = [];
  try {
    await app.launch();
    expect(await app.invoke('workspace.set', { path: app.userWorkspaceRoot })).toMatchObject({ ok: true });
    expect(await app.invoke('permissions.setLocalExecMode', { mode: 'all_files_auto' })).toMatchObject({ ok: true });
    const create = async (title: string) => (await app.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title })).conversation.conversation_id;
    const reading = await create('Performance reading target'), other = await create('Performance other target');
    const needle = 'PERF_READING_MARKER', searchNeedle = 'PERF_OTHER_MARKER';
    expect(await app.invoke('groupChat.send', { cid: reading, content: needle })).toMatchObject({ ok: true });
    await expect.poll(async () => (await app.invoke<any>('groupChat.runtimeStatus', { cid: reading })).processing).toBe(false);
    expect(await app.invoke('groupChat.send', { cid: other, content: searchNeedle })).toMatchObject({ ok: true });
    await expect.poll(async () => (await app.invoke<any>('groupChat.runtimeStatus', { cid: other })).processing).toBe(false);
    for (let task = 0; task < variant.tasks; task++) jobs.push({ cid: await create(`Performance task ${task}`),
      marker: `PERFORMANCE_FILE_TASK_${task}`, directory: path.join(app.userWorkspaceRoot, `task-${task}`) });
    const page = app.page!;
    await page.evaluate(async () => (window as any).loadConversations());
    await page.locator(`#conversation-list .conv-item[data-cid="${reading}"]`).click();
    await expect(page.locator('#chat-history')).toContainText(needle);
    // Keep driver/actionability time separate from browser input-to-paint time.
    // The same idle operation is a diagnostic reference, not a subtracted budget.
    const measureInput = async (text: string, stallMs = 0) => {
      await page.evaluate(stallMs => {
        const editor = document.querySelector('.chat-rich-editor[data-rich-input-id="chat-input"]')!;
        const probe = { started: performance.now(), beforeInput: -1, input: -1, paint: -1 };
        const before = () => {
          if (probe.beforeInput >= 0) return;
          probe.beforeInput = performance.now();
          if (stallMs) { const until = performance.now() + stallMs; while (performance.now() < until) { /* bounded test fault */ } }
        };
        const input = () => { probe.input = performance.now(); requestAnimationFrame(() => { probe.paint = performance.now(); }); };
        editor.addEventListener('beforeinput', before); editor.addEventListener('input', input);
        (window as any).__inputProbe = { probe, cleanup() { editor.removeEventListener('beforeinput', before); editor.removeEventListener('input', input); } };
      }, stallMs);
      await page.locator('.chat-rich-editor[data-rich-input-id="chat-input"]').fill(text);
      return page.evaluate(async () => {
        const state = (window as any).__inputProbe;
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        state.cleanup(); delete (window as any).__inputProbe;
        const p = state.probe;
        if (p.beforeInput < 0 || p.input < 0 || p.paint < 0) throw new Error('Input/paint instrumentation did not observe the edit');
        return { driverMs: performance.now() - p.started, dispatchMs: p.beforeInput - p.started, eventToPaintMs: p.paint - p.input, beforeInputToPaintMs: p.paint - p.beforeInput };
      });
    };
    const idleInput = await measureInput('Idle input reference');
    await page.locator('.chat-rich-editor[data-rich-input-id="chat-input"]').fill('');
    // Warm only search's catalog/index readiness, outside the measured work.
    await page.locator('#sidebar-search-btn').click();
    await page.locator('#search-input').fill(needle);
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-body .search-result')).not.toHaveCount(0);
    await page.locator('#search-input').press('Escape');
    await expect(page.locator('#search-overlay')).not.toBeVisible();

    app.setModelRequestScript((request, tools) => {
      // Auxiliary summaries keep the fixture's ordinary text response. Main
      // requests can compact old receipts without resetting scripted progress.
      if (tools.size === 0) return undefined;
      const messages = request.messages as Array<{ role: string; content?: unknown; tool_call_id?: string }>;
      const messageText = (content: unknown) => typeof content === 'string' ? content
        : Array.isArray(content) ? content.map(block => block?.type === 'text' ? block.text : '').join('') : '';
      const task = jobs.findIndex(job => messages.some(m => m.role === 'user' && messageText(m.content).includes(job.marker)));
      if (task < 0) return undefined;
      const receipts = confirmedWork.get(task) ?? new Set<string>();
      for (const message of messages) {
        if (message.role === 'tool' && String(message.tool_call_id).startsWith(`work-${task}-`)) {
          receipts.add(String(message.tool_call_id));
        }
      }
      confirmedWork.set(task, receipts);
      const step = receipts.size;
      if (step === operations) { completed.add(task); return { text: `FILE_TASK_DONE_${task}`, waitFor: finish.promise }; }
      if (!tools.has('write_file')) return { calls: [{ callId: `load-${task}`, name: 'tool_load', args: { groups: ['workspace.write.output'] } }] };
      if (step === 2) parked.add(task);
      if (variant.stop && task === 0 && step === 4) stopReady = true;
      return { calls: [{ callId: `work-${task}-${step}`, name: 'write_file',
        args: { path: path.join(jobs[task].directory, `part-${step}.txt`), content: payload(task, step) } }],
        ...(step === 2 ? { waitFor: work.promise } : variant.stop && task === 0 && step === 4 ? { waitFor: stoppedResponse.promise } : {}) };
    });
    const sent = await Promise.all(jobs.map(job => app.invoke<any>('groupChat.send', { cid: job.cid, content: job.marker })));
    expect(sent.every(result => result.ok)).toBe(true);
    await expect.poll(() => parked.size, { timeout: 30_000 }).toBe(variant.tasks);
    for (const job of jobs) expect((await app.invoke<any>('groupChat.runtimeStatus', { cid: job.cid })).processing).toBe(true);

    const sessionFiles = await app.electronApp!.evaluate(({ app }, input) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule), root = app.getAppPath();
      const uid = req(`${root}/src/main/features/users`).getActiveUserId();
      const store = req(`${root}/src/main/model/core-agent/session-store`);
      const state = req(`${root}/src/main/features/group_chat/state`);
      const files = input.cids.map(cid => store.resolveSessionPath(uid, state.buildGconvSessionId(cid)));
      const fs = req('node:fs'), originals = { writeFileSync: fs.writeFileSync, renameSync: fs.renameSync };
      const metrics = { calls: 0, apiMs: 0, injected: false, injectedMs: 0, maxGapMs: 0, last: performance.now(),
        cpu: process.cpuUsage(), rssBefore: process.memoryUsage().rss, started: performance.now(), timer: null as any };
      const context = new Set(files.map(file => file + '.context.json.tmp'));
      for (const name of ['writeFileSync', 'renameSync']) fs[name] = function (...args: any[]) {
        const watched = typeof args[0] === 'string' && (args[0].startsWith(input.workspace + req('node:path').sep) || context.has(args[0]));
        if (!watched) return originals[name].apply(this, args);
        metrics.calls++;
        if (input.stall && !metrics.injected) {
          metrics.injected = true;
          const start = performance.now(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, input.stall);
          metrics.injectedMs = performance.now() - start;
        }
        const start = performance.now();
        try { return originals[name].apply(this, args); } finally { metrics.apiMs += performance.now() - start; }
      };
      metrics.timer = setInterval(() => { const now = performance.now(); metrics.maxGapMs = Math.max(metrics.maxGapMs, now - metrics.last - 10); metrics.last = now; }, 10);
      (globalThis as any).__taskPerformance = { metrics, restore() {
        clearInterval(metrics.timer); Object.assign(fs, originals);
        const cpu = process.cpuUsage(metrics.cpu);
        return { calls: metrics.calls, apiMs: metrics.apiMs, injected: metrics.injected, injectedMs: metrics.injectedMs,
          maxGapMs: metrics.maxGapMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
          rssBefore: metrics.rssBefore, rssAfter: process.memoryUsage().rss, elapsedMs: performance.now() - metrics.started };
      } };
      return files;
    }, { cids: jobs.map(j => j.cid), workspace: app.userWorkspaceRoot, stall: variant.stall ? LATENCY_LIMIT_MS + 100 : 0 });
    await page.evaluate(cids => {
      const w = window as any;
      const state = { samples: [] as number[], activeReplies: 0, stopped: false, overflow: false, pending: null as any,
        last: performance.now(), maxGapMs: 0, timer: null as any };
      state.timer = setInterval(() => { const now = performance.now(); state.maxGapMs = Math.max(state.maxGapMs, now - state.last - 10); state.last = now; }, 10);
      state.pending = (async () => {
        while (!state.stopped) {
          if (state.samples.length === 512) { state.overflow = true; break; }
          const start = performance.now();
          const status = await w.orkas.invoke('groupChat.runtimeStatus', { cid: cids[state.samples.length % cids.length] });
          state.samples.push(performance.now() - start); if (status.processing) state.activeReplies++;
          await new Promise(r => setTimeout(r, 10));
        }
      })();
      w.__taskProbe = state;
    }, jobs.map(j => j.cid));
    work.release();

    const draft = 'Keep this draft while background tasks write files.';
    const input = await measureInput(draft, variant.rendererStall ? LATENCY_LIMIT_MS + 100 : 0);
    const inputMs = input.driverMs;
    await expectComposerText(page.locator('#chat-input'), draft);
    await page.locator('#sidebar-search-btn').click();
    // A different result target prevents warmed/stale search DOM from passing.
    await page.evaluate(expected => {
      const input = document.getElementById('search-input')!;
      const state = { start: -1, paintMs: -1, observer: null as any };
      const key = (event: KeyboardEvent) => { if (event.key === 'Enter') state.start = performance.now(); };
      input.addEventListener('keydown', key as EventListener, true);
      state.observer = new MutationObserver(() => {
        if (state.start < 0 || !Array.from(document.querySelectorAll('#search-body .search-result')).some(node => node.textContent?.includes(expected))) return;
        state.observer.disconnect(); requestAnimationFrame(() => { state.paintMs = performance.now() - state.start; });
      });
      state.observer.observe(document.getElementById('search-body')!, { subtree: true, childList: true, characterData: true });
      (window as any).__searchProbe = { state, cleanup() { state.observer.disconnect(); input.removeEventListener('keydown', key as EventListener, true); } };
    }, searchNeedle);
    const searchStart = await page.evaluate(() => performance.now());
    await page.locator('#search-input').fill(searchNeedle);
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-body .search-result')).toContainText([searchNeedle]);
    await expect.poll(() => page.evaluate(() => (window as any).__searchProbe.state.paintMs)).toBeGreaterThanOrEqual(0);
    const search = await page.evaluate(start => {
      const probe = (window as any).__searchProbe; probe.cleanup(); delete (window as any).__searchProbe;
      return { driverMs: performance.now() - start, eventToPaintMs: probe.state.paintMs };
    }, searchStart);
    await page.locator('#search-input').press('Escape');
    const measureSwitch = async (cid: string, marker: string) => {
      await page.evaluate(({ cid, marker }) => {
        const row = document.querySelector(`#conversation-list .conv-item[data-cid="${cid}"]`)!;
        const state = { start: -1, paintMs: -1, observer: null as any };
        const click = () => { state.start = performance.now(); };
        row.addEventListener('click', click, true);
        state.observer = new MutationObserver(() => {
          if (state.start < 0 || !document.getElementById('chat-history')?.textContent?.includes(marker)) return;
          state.observer.disconnect(); requestAnimationFrame(() => { state.paintMs = performance.now() - state.start; });
        });
        state.observer.observe(document.getElementById('chat-history')!, { subtree: true, childList: true, characterData: true });
        (window as any).__switchProbe = { state, cleanup() { row.removeEventListener('click', click, true); state.observer.disconnect(); } };
      }, { cid, marker });
      await page.locator(`#conversation-list .conv-item[data-cid="${cid}"]`).click();
      await expect(page.locator('#chat-history')).toContainText(marker);
      await expect.poll(() => page.evaluate(() => (window as any).__switchProbe.state.paintMs)).toBeGreaterThanOrEqual(0);
      return page.evaluate(() => { const p = (window as any).__switchProbe; p.cleanup(); delete (window as any).__switchProbe; return p.state.paintMs as number; });
    };
    const switchMs = [await measureSwitch(other, searchNeedle), await measureSwitch(reading, needle)];
    await expectComposerText(page.locator('#chat-input'), draft);
    let stopMs: number | null = null;
    if (variant.stop) {
      await expect.poll(() => stopReady).toBe(true);
      await page.locator(`#conversation-list .conv-item[data-cid="${jobs[0].cid}"]`).click();
      await expect(page.locator('#chat-send-btn')).toHaveClass(/\bstreaming\b/);
      stopMs = await page.evaluate(async cid => {
        const w = window as any, start = performance.now(); document.getElementById('chat-send-btn')!.click();
        while ((await w.orkas.invoke('groupChat.runtimeStatus', { cid })).processing) await new Promise(r => setTimeout(r, 10));
        return performance.now() - start;
      }, jobs[0].cid);
      stoppedResponse.release();
    }
    await expect.poll(() => completed.size, { timeout: 30_000 }).toBe(variant.tasks - (variant.stop ? 1 : 0));
    finish.release();
    for (const job of jobs) await expect.poll(async () => (await app.invoke<any>('groupChat.runtimeStatus', { cid: job.cid })).processing).toBe(false);
    const foreground = await page.evaluate(async () => {
      const state = (window as any).__taskProbe; state.stopped = true; await state.pending; clearInterval(state.timer);
      delete (window as any).__taskProbe;
      return { samples: state.samples, activeReplies: state.activeReplies, overflow: state.overflow, maxGapMs: state.maxGapMs };
    });
    const main = await app.electronApp!.evaluate(async () => {
      await new Promise(r => setTimeout(r, 20));
      const value = (globalThis as any).__taskPerformance.restore(); delete (globalThis as any).__taskPerformance; return value;
    });
    expect(main.calls, 'The measured window must include real file/persistence work').toBeGreaterThan(0);
    expect(foreground.activeReplies).toBeGreaterThan(0); expect(foreground.overflow).toBe(false);
    for (let task = 0; task < jobs.length; task++) {
      const count = variant.stop && task === 0 ? 4 : operations;
      expect(readdirSync(jobs[task].directory).sort()).toEqual(Array.from({ length: count }, (_, n) => `part-${n}.txt`).sort());
      for (let step = 0; step < count; step++) expect(readFileSync(path.join(jobs[task].directory, `part-${step}.txt`))).toEqual(Buffer.from(payload(task, step)));
      const rows = readFileSync(sessionFiles[task], 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const calls = rows.flatMap(row => row.content.filter((c: any) => c.type === 'tool_use' && String(c.id).startsWith(`work-${task}-`)));
      const receipts = rows.flatMap(row => row.content.filter((c: any) => c.type === 'tool_result' && String(c.toolUseId).startsWith(`work-${task}-`)));
      // Responses SDK ids retain call_id|item_id. Protect the independently
      // scripted calls and exact native pairing without guessing item ids.
      expect(calls.map((c: any) => String(c.id).split('|')[0])).toEqual(Array.from({ length: count }, (_, step) => `work-${task}-${step}`));
      expect(calls.map((c: any) => ({ name: c.name, input: c.input }))).toEqual(Array.from({ length: count }, (_, step) => ({
        name: 'write_file', input: { path: path.join(jobs[task].directory, `part-${step}.txt`), content: payload(task, step) },
      })));
      expect(receipts.map((c: any) => c.toolUseId)).toEqual(calls.map((c: any) => c.id));
      expect(receipts.every((c: any) => !c.isError)).toBe(true);
      const history = await app.invoke<any>('conversations.history', { cid: jobs[task].cid, limit: 10 });
      expect(history.history.some((row: any) => row.text === `FILE_TASK_DONE_${task}`)).toBe(!(variant.stop && task === 0));
    }
    const evidence = { ...variant, operations, bytesPerOperation: bytes, inputMs, idleInput, input, search, switchMs, stopMs, foreground, main,
      scope: 'real Electron/IPC/host/SDK/file/persistence; warm setup, scripted local provider and arrival gates; endpoint RSS, no p95/physical-disk/child-memory claim' };
    writeFileSync(info.outputPath('task-performance.json'), JSON.stringify(evidence, null, 2));
    console.log('[task-responsiveness]', JSON.stringify({ ...evidence, foreground: { ...foreground, samples: foreground.samples.length, maxRoundTripMs: Math.max(...foreground.samples) } }));
    if (variant.stall) {
      expect(main.injected).toBe(true); expect(main.injectedMs).toBeGreaterThanOrEqual(LATENCY_LIMIT_MS + 100);
      expect(() => checkLatencyBudget('task main stall negative control', { elapsedMs: main.maxGapMs }, INTERACTIVE_MAIN_GAP_LIMIT_MS)).toThrow('budget');
      expect(() => checkLatencyBudget('task IPC stall negative control', { elapsedMs: Math.max(...foreground.samples) })).toThrow('budget');
    } else if (variant.rendererStall) {
      expect(main.injected).toBe(false);
      expect(input.beforeInputToPaintMs).toBeGreaterThanOrEqual(LATENCY_LIMIT_MS + 100);
      expect(() => checkLatencyBudget('renderer input stall negative control', { elapsedMs: input.beforeInputToPaintMs })).toThrow('budget');
      expect(() => checkLatencyBudget('renderer loop stall negative control', { elapsedMs: foreground.maxGapMs })).toThrow('budget');
    } else {
      checkLatencyBudget('foreground main loop during file tasks', { elapsedMs: main.maxGapMs }, INTERACTIVE_MAIN_GAP_LIMIT_MS);
      checkLatencyBudget('foreground IPC during file tasks', { elapsedMs: Math.max(...foreground.samples) });
      checkLatencyBudget('foreground renderer loop during file tasks', { elapsedMs: foreground.maxGapMs });
      checkLatencyBudget('foreground input event to paint', { elapsedMs: input.beforeInputToPaintMs });
      checkLatencyBudget('foreground search event to paint', { elapsedMs: search.eventToPaintMs });
      for (const elapsedMs of switchMs) checkLatencyBudget('foreground switch event to paint', { elapsedMs });
      if (stopMs !== null) checkLatencyBudget('stop file task', { elapsedMs: stopMs });
    }
  } finally {
    work.release(); finish.release(); stoppedResponse.release(); app.setModelRequestScript(null);
    await app.electronApp?.evaluate(() => { const p = (globalThis as any).__taskPerformance; if (p) p.restore(); delete (globalThis as any).__taskPerformance; }).catch(() => {});
    await app.dispose();
  }
});
