import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, test, type OrkasTestApp } from './fixtures/orkas';
import { trayMenu, selectTrayItem } from './fixtures/desktop-tray';

const closeDialog = (app: OrkasTestApp) => app.page!.locator('.ui-dialog-overlay').filter({ has: app.page!.locator('[data-id="background"]') });
const records = (file: string): any[] => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const toolReceipts = (rows: any[]) => rows.flatMap(row => row.process || []).filter(item => item.event?.stream === 'tool'
  && item.event.data?.phase === 'end' && item.event.data?.id === 'call-e2e-commentary-1');

async function closeToBackground(app: OrkasTestApp) {
  const native = await app.electronApp!.browserWindow(app.page!);
  await native.evaluate(win => { (win as any).__shows = 0; win.on('show', () => { (win as any).__shows++; }); win.close(); });
  await expect(closeDialog(app)).toHaveCount(0);
  await expect.poll(() => native.evaluate(win => win.isVisible())).toBe(false);
  return native;
}
async function pausedTask(app: OrkasTestApp) {
  const input = app.createWorkspaceFile('lifecycle-proof.txt', 'BACKGROUND_TASK_FACT=retained\n');
  await app.setChatCommentaryScenario({ reads: [{ path: input, commentary: 'Checking the task information.' }], finalText: 'Background task completed.' });
  const page = app.page!;
  await page.locator('#new-chat-btn').click(); await page.locator('#new-chat-input').fill('Read the task information and report the result.');
  await page.locator('#new-chat-send-btn').click();
  await expect.poll(() => app.commentaryStage, { timeout: 30_000 }).toBe(1); app.releaseCommentaryStage();
  await expect.poll(() => app.commentaryStage, { timeout: 30_000 }).toBe(2);
  const cid = await page.evaluate<string>('currentCid');
  return { cid, file: path.join(app.workspaceRoot, 'account-e2e/cloud/chats', `${cid}.jsonl`) };
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

test('a task completes and an automation fires exactly once after the user closes to background', async ({ modelOrkas: app }, info) => {
  test.setTimeout(90_000);
  const task = await pausedTask(app);
  // The user schedules work before closing; the real scheduler must admit it
  // after the window is closed, without a renderer creating the task then.
  const at = new Date(Date.now() + 10_000).toISOString();
  const enabled = await app.invoke<any>('autoTasks.create', { title: 'Background enabled automation', content: 'Summarize the task information.', enabled: true, schedule: { type: 'one_time', at } });
  const disabled = await app.invoke<any>('autoTasks.create', { title: 'Background disabled automation', content: 'This task is disabled.', enabled: false, schedule: { type: 'one_time', at } });
  const mainPid = app.electronApp!.process().pid;
  const native = await closeToBackground(app);
  // Hidden-at-launch E2E has no physical show-to-hide transition. Feed the
  // native lifecycle event through the shipped presentation listener, keeping
  // every real window hidden while testing suspended transcript recovery.
  await native.evaluate(win => win.emit('hide'));
  await expect.poll(() => app.page!.evaluate<boolean>('_conversationWindowActive')).toBe(false);
  expect(alive(mainPid!)).toBe(true);
  app.releaseCommentaryStage();
  await expect.poll(() => records(task.file).some(row => row.text === 'Background task completed.'), { timeout: 20_000 }).toBe(true);
  expect(toolReceipts(records(task.file))).toHaveLength(1);
  expect(records(task.file).filter(row => row.system_kind === 'reply_interrupted')).toHaveLength(0);
  app.clearModelToolScenario(); app.setModelTextReplies(['Background automation completed.']);
  await expect.poll(async () => {
    const result = await app.invoke<any>('autoTasks.list');
    return result.tasks.find((row: any) => row.id === enabled.task.id)?.last_run?.status;
  }, { timeout: 30_000 }).toBe('completed');
  const list = await app.invoke<any>('conversations.list');
  const fired = list.conversations.filter((row: any) => row.origin_auto_task_id === enabled.task.id);
  expect(fired).toHaveLength(1);
  expect(list.conversations.filter((row: any) => row.origin_auto_task_id === disabled.task.id)).toHaveLength(0);
  const automatedFile = path.join(app.workspaceRoot, 'account-e2e/cloud/chats', `${fired[0].conversation_id}.jsonl`);
  expect(records(automatedFile).filter(row => row.text === 'Background automation completed.')).toHaveLength(1);
  const tasks = (await app.invoke<any>('autoTasks.list')).tasks;
  expect(tasks.find((row: any) => row.id === enabled.task.id)).toMatchObject({ enabled: false, run_count: 1 });
  expect(tasks.find((row: any) => row.id === disabled.task.id).last_run).toBeUndefined();
  expect(app.modelRequests).toHaveLength(3);
  expect(await native.evaluate(win => ({ destroyed: win.isDestroyed(), visible: win.isVisible(), shows: (win as any).__shows }))).toEqual({ destroyed: false, visible: false, shows: 0 });
  expect(app.electronApp!.process().pid).toBe(mainPid);
  expect((await trayMenu(app.electronApp!)).map(item => item.label)).toEqual(['Open', 'Quit']);
  await selectTrayItem(app.electronApp!, 0);
  await native.evaluate(win => win.emit('show'));
  await expect(app.page!.locator('#chat-history .chat-message.assistant')).toContainText('Background task completed.');
  await app.page!.evaluate(cid => (window as any).setView('conversation', cid), fired[0].conversation_id);
  await expect(app.page!.locator('#chat-history .chat-message.assistant')).toContainText('Background automation completed.');
  expect(app.modelRequests).toHaveLength(3);
  expect(await native.evaluate(win => win.isVisible())).toBe(false);
  await info.attach('background-execution-proof', { body: JSON.stringify({ sameProcess: true, taskReceiptCount: 1, automationCompleted: 1, disabledRuns: 0, nativeShows: 0 }), contentType: 'application/json' });
});

for (const entry of ['user task', 'automation'] as const) {
test(`a ${entry} fills and navigates its browser after closing without waking windows or duplicating website actions`, async ({ modelOrkas: app }, info) => {
  test.setTimeout(90_000);
  const submissions: Array<{ path: string; value: string; trusted: boolean }> = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { submissions.push({ path: req.url!, ...JSON.parse(body) }); res.end('ok'); });
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Background report</title><label>Report<input id="report"></label>
      <button id="save">Save report</button><p id="state">Pending</p><script>
      save.onclick=async event=>{await fetch(location.pathname,{method:'POST',body:JSON.stringify({value:report.value,trusted:event.isTrusted})});state.textContent='Saved '+report.value};
      </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    let task: { cid: string; file: string } | undefined;
    let automationId: string | undefined;
    if (entry === 'user task') task = await pausedTask(app);
    else {
      const input = app.createWorkspaceFile('automation-browser-proof.txt', 'BACKGROUND_BROWSER_FACT=retained\n');
      await app.setChatCommentaryScenario({ reads: [{ path: input, commentary: 'Checking the automation information.' }], finalText: 'Background task completed.' });
      const scheduled = await app.invoke<any>('autoTasks.create', { title: 'Unattended browser task', content: 'Prepare the report.', enabled: true,
        schedule: { type: 'one_time', at: new Date(Date.now() + 1500).toISOString() } });
      automationId = scheduled.task.id;
    }
    const native = await closeToBackground(app);
    await native.evaluate(win => win.emit('hide'));
    await expect.poll(() => app.page!.evaluate<boolean>('_conversationWindowActive')).toBe(false);
    if (entry === 'automation') {
      await expect.poll(() => app.commentaryStage, { timeout: 30_000 }).toBe(1); app.releaseCommentaryStage();
      await expect.poll(() => app.commentaryStage, { timeout: 30_000 }).toBe(2);
      const list = await app.invoke<any>('conversations.list');
      const fired = list.conversations.filter((row: any) => row.origin_auto_task_id === automationId);
      expect(fired).toHaveLength(1);
      task = { cid: fired[0].conversation_id, file: path.join(app.workspaceRoot, 'account-e2e/cloud/chats', `${fired[0].conversation_id}.jsonl`) };
    }
    const currentTask = task!;
    const root = path.resolve(__dirname, '../..');
    // Capture the real bus-owned task lifetime; no fake browser run is begun.
    await app.electronApp!.evaluate(async (_e, args) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      const req = (process as any).mainModule.require;
      (globalThis as any).__closedTaskBrowser = req(args.root + '/src/main/features/group_chat/browser_tool.ts')
        .buildConversationBrowserTool('account-e2e', args.cid);
    }, { root, cid: currentTask.cid });
    const call = (input: Record<string, unknown>) => app.electronApp!.evaluate(async (_e, input) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return JSON.parse((await (globalThis as any).__closedTaskBrowser.execute(input, {})).content);
    }, input);
    const opened = await call({ operation: 'open', url: origin + '/first' });
    expect(opened).toMatchObject({ ok: true });
    const tab_id = opened.active_tab_id;
    const act = async (label: string, page_action: string, text?: string) => {
      const observed = await call({ operation: 'observe', tab_id });
      expect(observed).toMatchObject({ ok: true });
      const element = observed.elements.find((row: any) => row.label === label);
      expect(element).toBeTruthy();
      const input = { operation: 'act', tab_id, page_id: observed.page_id, element_ref: element.ref, page_action, ...(text === undefined ? {} : { text }) };
      expect(await call(input)).toMatchObject({ ok: true });
      return input;
    };
    for (const [route, value] of [['first', '后台报告一'], ['second', 'Background report two']]) {
      expect(await call({ operation: 'wait', tab_id })).toMatchObject({ ok: true });
      await act('Report', 'fill', value);
      const previousClick = await act('Save report', 'click');
      expect(await call({ operation: 'wait', tab_id, wait_condition: 'text', text: 'Saved ' + value })).toMatchObject({ ok: true });
      expect(submissions).toHaveLength(route === 'first' ? 1 : 2);
      expect(submissions.at(-1)).toEqual({ path: '/' + route, value, trusted: true });
      if (route === 'first') {
        expect(await call({ operation: 'navigate', tab_id, navigation: 'goto', url: origin + '/second' })).toMatchObject({ ok: true });
        expect(await call({ operation: 'wait', tab_id })).toMatchObject({ ok: true });
        // A stale snapshot must not repeat a website write after navigation.
        expect(await call(previousClick)).toMatchObject({ ok: false });
        expect(submissions).toHaveLength(1);
      }
      expect(await native.evaluate(win => ({ visible: win.isVisible(), focused: win.isFocused(), shows: (win as any).__shows })))
        .toEqual({ visible: false, focused: false, shows: 0 });
      expect(await app.electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(win => win.isVisible()))).toBe(false);
    }
    app.releaseCommentaryStage();
    await expect.poll(() => records(currentTask.file).some(row => row.text === 'Background task completed.'), { timeout: 20_000 }).toBe(true);
    expect(toolReceipts(records(currentTask.file))).toHaveLength(1);
    await expect.poll(async () => (await call({ operation: 'tabs' })).code).toBe('task_run_ended');
    if (automationId) {
      await expect.poll(async () => (await app.invoke<any>('autoTasks.list')).tasks.find((row: any) => row.id === automationId))
        .toMatchObject({ enabled: false, run_count: 1, last_run: { status: 'completed' } });
    }
    expect(app.modelRequests).toHaveLength(2);
    await info.attach('closed-browser-execution-proof', { body: JSON.stringify({ nativeShows: 0, submissions, taskReceipts: 1, endedToolRevoked: true }), contentType: 'application/json' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
}

for (const entry of ['tray-exit', 'native-quit'] as const) {
  test(`${entry} terminates the real main/helper processes and archives active task evidence`, async ({ modelOrkas: app }, info) => {
    test.setTimeout(90_000);
    await closeToBackground(app);
    const task = await pausedTask(app);
    await app.invoke('autoTasks.create', { title: 'Future automation at exit', content: 'Prepare a report.', enabled: true,
      schedule: { type: 'one_time', at: '2099-12-01T10:00:00.000Z' } });
    const deviceFile = path.join(app.workspaceRoot, 'device.json');
    const beforeDevice = JSON.parse(readFileSync(deviceFile, 'utf8'));
    if (entry === 'tray-exit') expect((await trayMenu(app.electronApp!)).map(item => item.label)).toEqual(['Open', 'Quit']);
    const electron = app.electronApp!;
    const child = electron.process();
    const pids = await electron.evaluate(({ app }) => [...new Set([process.pid, ...app.getAppMetrics().map(row => row.pid)])]);
    if (entry === 'native-quit' && process.platform === 'darwin') {
      // Native Dock Quit and application-menu Quit both enter Electron's app.quit.
      expect(await electron.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items[0].submenu?.items.some(item => item.role === 'quit'))).toBe(true);
    }
    await app.prepareForNativeShutdown();
    const closed = app.page!.waitForEvent('close');
    const exitStarted = Date.now();
    if (entry === 'tray-exit') await selectTrayItem(electron, 1);
    else await electron.evaluate(({ app }) => { setImmediate(() => app.quit()); });
    await closed;
    await expect.poll(() => child.exitCode, { timeout: 15_000 }).toBe(0);
    const exitMs = Date.now() - exitStarted;
    await expect.poll(() => pids.filter(alive), { timeout: 10_000 }).toEqual([]);
    const rows = records(task.file);
    expect(toolReceipts(rows)).toHaveLength(1);
    expect(rows.filter(row => row.system_kind === 'reply_interrupted')).toHaveLength(1);
    const device = JSON.parse(readFileSync(path.join(app.workspaceRoot, 'device.json'), 'utf8'));
    expect(device).toEqual(beforeDevice);
    expect(app.modelRequests).toHaveLength(2);
    await info.attach('exit-process-proof', { body: JSON.stringify({ entry, exitMs, exitCode: child.exitCode, ownedProcessesExited: pids.length, archivedReceipts: 1, interruptedTurns: 1 }), contentType: 'application/json' });
  });
}
