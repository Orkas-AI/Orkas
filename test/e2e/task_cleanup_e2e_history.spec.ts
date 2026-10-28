import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/orkas';

test.describe('inline historical task cleanup', () => {
  test('shows remaining history after cleanup and requires a new selection', async ({ orkas }, testInfo) => {
    const cids: string[] = [];
    for (const title of ['Selected history', 'History left for review']) {
      cids.push((await orkas.invoke<any>('conversations.create', { title })).conversation.conversation_id);
    }
    const root = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats');
    const rows = JSON.parse(readFileSync(path.join(root, '_index.json'), 'utf8'));
    const old = '2020-01-01T00:00:00Z';
    for (const row of rows) {
      row.created_at = row.updated_at = old;
      writeFileSync(path.join(root, row.conversation_id, 'meta.json'), JSON.stringify(row));
      writeFileSync(path.join(root, `${row.conversation_id}.jsonl`), JSON.stringify({ id: 'request', from: 'user', content: row.title, ts: old }) + '\n');
    }
    writeFileSync(path.join(root, '_index.json'), JSON.stringify(rows));
    const page = await orkas.relaunch();
    await page.locator('#settings-btn').click();
    await page.locator('[data-settings-tab="data"]').click();
    const section = page.locator('#settings-task-cleanup');
    await section.locator('[data-cleanup-action="view"]').click();
    await section.locator(`[data-cleanup-cid="${cids[0]}"]`).check();
    await section.locator('[data-cleanup-action="prepare"]').click();
    await section.locator('[data-cleanup-action="confirm"]').click();
    await expect(section).toContainText('Still matching: 1. Review and select again to continue.');
    await expect(section.locator('[data-cleanup-action="prepare"]')).toBeDisabled();
    expect(existsSync(path.join(root, `${cids[0]}.jsonl`))).toBe(false);
    expect(existsSync(path.join(root, `${cids[1]}.jsonl`))).toBe(true);
    for (const [lang, width, height] of [['en', 1280, 900], ['zh', 1000, 720], ['en', 620, 780]] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async lang => { await (window as any).setLang(lang); }, lang);
      await section.screenshot({ path: testInfo.outputPath(`cleanup-remaining-${lang}-${width}.png`) });
      expect(await section.locator('[role="status"]').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
  });
  test('uses sidebar timestamps and retains tasks renamed before preview or confirmation', async ({ orkas }, testInfo) => {
    const cids: string[] = [];
    for (const title of ['Old task metadata', 'Rename before preview', 'Rename before confirmation']) {
      cids.push((await orkas.invoke<any>('conversations.create', { title })).conversation.conversation_id);
    }
    const root = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats');
    const indexFile = path.join(root, '_index.json');
    const rows = JSON.parse(readFileSync(indexFile, 'utf8'));
    const old = new Date(Date.now() - 37 * 86400000).toISOString();
    for (const cid of cids) {
      const row = rows.find((r: any) => r.conversation_id === cid);
      row.created_at = old; row.updated_at = old;
      writeFileSync(path.join(root, cid, 'meta.json'), JSON.stringify(row));
      writeFileSync(path.join(root, cid, 'state.json'), JSON.stringify({ status: 'idle', in_flight: [], last_active_at: old }));
      // Real rename IPC below advances metadata without changing these old messages.
      writeFileSync(path.join(root, `${cid}.jsonl`), [
        { id: 'reply', from: 'commander', content: 'Preserved response', ts: old },
        { id: 'request', from: 'user', content: 'Historical request', ts: old },
      ].map(row => JSON.stringify(row)).join('\n'));
    }
    writeFileSync(indexFile, JSON.stringify(rows));
    const original = cids.map(cid => readFileSync(path.join(root, `${cid}.jsonl`), 'utf8'));
    const page = await orkas.relaunch();
    const renamed = await orkas.invoke<any>('conversations.rename', { cid: cids[1], title: 'Updated before preview' });
    const sidebar = await orkas.invoke<any>('conversations.list', { mode: 'unprojected', offset: 0 });
    const sidebarTasks = sidebar.conversations.filter((row: any) => cids.includes(row.conversation_id));
    expect(sidebarTasks[0].conversation_id).toBe(cids[1]);
    // Legacy timestamps omit a zone; parse in the app's timezone, not the test host's.
    const renamedAt = await orkas.electronApp!.evaluate((_, ts) => Date.parse(ts), renamed.conversation.updated_at);
    expect(Date.parse(sidebarTasks[0].last_active_at)).toBe(renamedAt);
    await page.locator('#settings-btn').click();
    await page.locator('[data-settings-tab="data"]').click();
    const section = page.locator('#settings-task-cleanup');
    await section.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Over 14 days ago', exact: true }).click();
    await section.locator('[data-cleanup-action="view"]').click();
    await expect(section.locator('[data-cleanup-cid]')).toHaveCount(2);
    await expect(section.locator(`[data-cleanup-cid="${cids[0]}"]`)).toBeEnabled();
    await expect(section.locator(`[data-cleanup-cid="${cids[1]}"]`)).toHaveCount(0);
    await section.screenshot({ path: testInfo.outputPath('cleanup-14-day-metadata-age.png') });
    await section.locator('[data-cleanup-all]').check();
    await section.locator('[data-cleanup-action="prepare"]').click();
    await orkas.invoke<any>('conversations.rename', { cid: cids[2], title: 'Updated while confirming' });
    await section.locator('[data-cleanup-action="confirm"]').click();
    await expect(section).toContainText('Recycled 1 · Skipped 1 · Failed 0');
    await expect(section.locator(`[data-cleanup-cid="${cids[0]}"]`)).toHaveCount(0);
    expect(existsSync(path.join(root, `${cids[0]}.jsonl`))).toBe(false);
    expect(readFileSync(path.join(root, `${cids[1]}.jsonl`), 'utf8')).toBe(original[1]);
    expect(readFileSync(path.join(root, `${cids[2]}.jsonl`), 'utf8')).toBe(original[2]);
    expect((await orkas.invoke<any>('conversations.get', { cid: cids[2] })).conversation.title).toBe('Updated while confirming');
    const { batches } = await orkas.invoke<any>('recycle.list');
    expect(batches).toHaveLength(1);
    expect(await orkas.invoke<any>('recycle.restore', { id: batches[0].id })).toMatchObject({ ok: true, failed: 0, reactivated: 1 });
    expect(readFileSync(path.join(root, `${cids[0]}.jsonl`), 'utf8')).toBe(original[0]);
  });
  test('keeps only failed tasks selected after partial cleanup and cleans them without duplicate skips', async ({ orkas }, testInfo) => {
    const pid = (await orkas.invoke<any>('projects.create', { name: 'Partial cleanup project' })).project.project_id;
    const cids: string[] = [];
    for (const title of ['Completed cleanup', 'Retry cleanup']) {
      cids.push((await orkas.invoke<any>('conversations.create', { title, projectId: pid })).conversation.conversation_id);
    }
    const root = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'projects', pid, 'chats');
    const indexFile = path.join(root, '_index.json');
    const rows = JSON.parse(readFileSync(indexFile, 'utf8'));
    for (const row of rows) {
      row.created_at = row.updated_at = '2020-01-01T00:00:00Z';
      writeFileSync(path.join(root, row.conversation_id, 'meta.json'), JSON.stringify(row));
      writeFileSync(path.join(root, `${row.conversation_id}.jsonl`), JSON.stringify({ from: 'user', content: row.title, ts: row.created_at }) + '\n');
    }
    writeFileSync(indexFile, JSON.stringify(rows));
    const page = await orkas.relaunch();
    await orkas.electronApp!.evaluate(({ ipcMain }, failedCid) => {
      const original = (ipcMain as any)._invokeHandlers.get('orkas.invoke');
      let failed = false;
      ipcMain.removeHandler('orkas.invoke');
      ipcMain.handle('orkas.invoke', (event, request) => {
        if (request.channel === 'conversations.cleanup.remove' && request.payload.cid === failedCid && !failed) {
          failed = true;
          return { ok: false, error: 'cleanup_failed' };
        }
        return original(event, request);
      });
    }, cids[1]);
    await page.locator('#settings-btn').click();
    await page.locator('[data-settings-tab="data"]').click();
    const section = page.locator('#settings-task-cleanup');
    await section.locator('[data-cleanup-action="view"]').click();
    await section.locator('[data-cleanup-action="project"]').click();
    await section.locator('[data-cleanup-project]').check();
    await section.locator('[data-cleanup-action="prepare"]').click();
    await section.locator('[data-cleanup-action="confirm"]').click();
    await expect(section).toContainText('Recycled 1 · Skipped 0 · Failed 1');
    await expect(section.locator('[data-cleanup-action="prepare"]')).toHaveText('Clean up (1)');
    await expect(section.locator(`[data-cleanup-cid="${cids[0]}"]`)).toHaveCount(0);
    await expect(section.locator(`[data-cleanup-cid="${cids[1]}"]`)).toBeChecked();
    await expect(section.locator('.settings-cleanup-project-head')).toContainText('1 / 1');
    await section.screenshot({ path: testInfo.outputPath('cleanup-partial-success.png') });
    await section.locator('[data-cleanup-action="prepare"]').click();
    await section.locator('[data-cleanup-action="confirm"]').click();
    await expect(section).toContainText('Recycled 1 · Skipped 0 · Failed 0');
    await expect(section.locator('[data-cleanup-cid]')).toHaveCount(0);
    expect((await orkas.invoke<any>('recycle.list')).batches).toHaveLength(2);
  });
  test('opens personal and active project history from hover and keyboard actions without changing selection', async ({ orkas }, testInfo) => {
    const projectId = (await orkas.invoke<any>('projects.create', { name: 'Fixture project' })).project.project_id;
    const tasks: { cid: string; root: string; projectId: string; title: string }[] = [];
    const old = '2020-01-01T00:00:00Z';
    for (const pid of ['', projectId]) {
      const { conversation } = await orkas.invoke<any>('conversations.create', {
        title: pid ? '一个很长的项目任务标题，需要查看历史对话来确认任务为何无法选择'.repeat(3) : 'Personal task with a long title '.repeat(5), projectId: pid,
      });
      const cid = conversation.conversation_id;
      const root = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', ...(pid ? ['projects', pid] : []), 'chats');
      const indexFile = path.join(root, '_index.json');
      const rows = JSON.parse(readFileSync(indexFile, 'utf8'));
      const row = rows.find((item: any) => item.conversation_id === cid);
      row.created_at = old; row.updated_at = old;
      const dir = path.join(root, cid); mkdirSync(dir, { recursive: true });
      writeFileSync(indexFile, JSON.stringify(rows));
      writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(row));
      writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, status: 'idle', in_flight: [], last_active_at: old }));
      writeFileSync(path.join(root, `${cid}.jsonl`), JSON.stringify({ id: 'source', from: 'user', text: pid ? 'Project history to inspect' : 'Personal history to inspect', ts: old }) + '\n');
      tasks.push({ cid, root, projectId: pid, title: row.title });
    }
    const page = await orkas.relaunch();
    // Preserve an old queued record to exercise automatic stopping independently
    // of startup recovery; no model execution is started by this fixture.
    const blocked = tasks[1];
    writeFileSync(path.join(blocked.root, blocked.cid, 'tasks.json'), JSON.stringify([
      { task_id: 'queued', cid: blocked.cid, assignee: 'commander', instruction: 'Fixture only', status: 'queued', created_at: old },
    ]));
    await page.evaluate(cid => localStorage.setItem(`draft_${cid}`, JSON.stringify({ text: 'Unsent draft stays intact' })), blocked.cid);
    const section = page.locator('#settings-task-cleanup');
    const openSettings = async () => {
      await page.locator('#settings-btn').click();
      await page.locator('[data-settings-tab="data"]').click();
      await expect(section).toContainText('Clean up (0)');
      if (!await section.locator('[data-cleanup-project]').count()) await section.locator('[data-cleanup-action="view"]').click();
    };
    await openSettings();
    const personalOpen = section.locator(`[data-cleanup-action="open"][data-cleanup-owner="${tasks[0].cid}"]`);
    await expect(personalOpen).toHaveCount(1);
    await page.mouse.move(0, 0);
    await expect(personalOpen).toHaveCSS('opacity', '0');
    await personalOpen.locator('xpath=ancestor::*[contains(@class,"settings-cleanup-item")]').hover();
    await expect(personalOpen).toHaveCSS('opacity', '1');
    await expect(personalOpen).toHaveCSS('border-top-width', '0px');
    await personalOpen.click();
    await expect(page.locator('#panel-conversation')).toHaveClass(/active/);
    await expect(page.locator('#chat-history')).toContainText('Personal history to inspect');
    await expect(page.locator('#chat-header-title')).toHaveText(tasks[0].title);
    await expect(section.locator(`[data-cleanup-cid="${tasks[0].cid}"]`)).not.toBeChecked();
    const back = page.locator('#chat-cleanup-back');
    await expect(back).toBeVisible();
    await back.click();
    await expect(page.locator('#panel-settings')).toHaveClass(/active/);
    await expect(section.locator('[data-cleanup-action="view"]')).toHaveText('Collapse');
    await section.locator('[data-cleanup-action="project"]').click();
    const projectCheck = section.locator(`[data-cleanup-cid="${blocked.cid}"]`);
    const projectOpen = section.locator(`[data-cleanup-action="open"][data-cleanup-owner="${blocked.cid}"]`);
    await expect(projectCheck).toBeEnabled();
    await expect(section).not.toContainText('Stops on cleanup');
    await page.mouse.move(0, 0);
    await expect(projectOpen).toHaveCSS('opacity', '0');
    await projectOpen.focus();
    await expect(projectOpen).toHaveCSS('opacity', '1');
    for (const [lang, width, height] of [['en', 1280, 900], ['zh', 1000, 720], ['zh', 620, 780]] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(async lang => { await (window as any).setLang(lang); }, lang);
      await projectOpen.focus();
      const fits = await projectOpen.evaluate(el => {
        const row = el.closest('.settings-cleanup-item')!.getBoundingClientRect();
        const button = el.getBoundingClientRect();
        const time = el.nextElementSibling!.getBoundingClientRect();
        return button.left >= row.left && button.right <= time.left && time.right <= row.right;
      });
      expect(fits).toBe(true);
      await section.screenshot({ path: testInfo.outputPath(`cleanup-view-${lang}-${width}.png`) });
    }
    await projectCheck.check();
    const settingsScroll = await section.evaluate(el => el.closest('.settings-body')!.scrollTop);
    expect(await page.evaluate(cid => window.eval('conversations').some((row: any) => row.conversation_id === cid), blocked.cid)).toBe(false);
    await projectOpen.press('Enter');
    await expect(page.locator('#panel-conversation')).toHaveClass(/active/);
    await expect(page.locator('#chat-history')).toContainText('Project history to inspect');
    await expect(page.locator('#chat-header-title')).toHaveText(blocked.title);
    await expect(page.locator('#chat-header-meta')).toContainText('Fixture project');
    await expect(projectCheck).toBeChecked();
    await expect(back).toBeVisible();
    await expect(back).toHaveText('返回');
    await page.locator('#chat-header').screenshot({ path: testInfo.outputPath('cleanup-return-header-zh.png') });
    await back.click();
    await expect(page.locator('#panel-settings')).toHaveClass(/active/);
    await expect(page.locator('[data-settings-tab="data"]')).toHaveClass(/is-active/);
    await expect(projectCheck).toBeChecked();
    await expect(section).toContainText('清理 (1)');
    expect(await section.evaluate(el => el.closest('.settings-body')!.scrollTop)).toBe(settingsScroll);
    await page.evaluate(cid => window.eval(`setView('conversation', ${JSON.stringify(cid)})`), tasks[0].cid);
    await expect(back).toBeHidden();
    expect(await page.evaluate(cid => localStorage.getItem(`draft_${cid}`), blocked.cid)).toContain('Unsent draft stays intact');
    for (const task of tasks) expect(existsSync(path.join(task.root, `${task.cid}.jsonl`))).toBe(true);
  });
  test('stops a live model turn before recycling and can restore its stopped history', async ({ modelOrkas }, testInfo) => {
    const app = modelOrkas, page = app.page!;
    app.setModelMode('controlled-slow');
    await page.locator('#new-chat-input').fill('Write a short task cleanup fixture.');
    await page.locator('#new-chat-send-btn').click();
    await expect.poll(() => app.modelRequests.length).toBeGreaterThan(0);
    const cid = await page.evaluate(() => window.eval('currentCid'));
    expect((await app.invoke<any>('groupChat.runtimeStatus', { cid })).processing).toBe(true);
    const root = path.join(app.workspaceRoot, 'account-e2e', 'cloud', 'chats');
    const old = '2020-01-01T00:00:00Z';
    // Age all persisted activity while its real bus/model turn stays live.
    for (const file of [path.join(root, '_index.json'), path.join(root, cid, 'meta.json'), path.join(root, cid, 'state.json'), path.join(root, cid, 'tasks.json')]) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const rows = Array.isArray(data) ? data : [data];
      for (const row of rows) {
        if (row.conversation_id && row.conversation_id !== cid) continue;
        for (const field of ['created_at', 'updated_at', 'last_active_at', 'started_at', 'ended_at']) if (row[field]) row[field] = old;
      }
      writeFileSync(file, JSON.stringify(data));
    }
    const messageFile = path.join(root, `${cid}.jsonl`);
    writeFileSync(messageFile, readFileSync(messageFile, 'utf8').trim().split('\n')
      .map(line => JSON.stringify({ ...JSON.parse(line), ts: old })).join('\n') + '\n');
    await app.electronApp!.evaluate((_, chatsModule) => {
      (process as any).mainModule.require(chatsModule).invalidateConversationCaches('account-e2e');
    }, path.resolve(__dirname, '../../src/main/features/chats.ts'));
    await page.locator('#settings-btn').click();
    await page.locator('[data-settings-tab="data"]').click();
    const section = page.locator('#settings-task-cleanup');
    await section.locator('[data-cleanup-action="view"]').click();
    await section.locator(`[data-cleanup-cid="${cid}"]`).check();
    await section.locator('[data-cleanup-action="prepare"]').click();
    await expect(section).toContainText('Running tasks are stopped automatically before cleanup.');
    await section.screenshot({ path: testInfo.outputPath('cleanup-stop-confirm.png') });
    // Observe only the selected task's original IPC promises; never await a
    // replacement result, inspect metadata, or publish private request data.
    await app.electronApp!.evaluate(({ ipcMain }, selectedCid) => {
      const handlers = (ipcMain as any)._invokeHandlers as Map<string, Function>;
      const original = handlers.get('orkas.invoke')!;
      if (typeof original !== 'function') throw new Error('Cleanup evidence requires the real IPC handler');
      const state = { stage: 'cleanup', rows: [] as any[], overflow: 0, restored: false };
      const missing = (value: any) => value?.ok === false && (
        value.code === 'E_CONVERSATION_NOT_FOUND' || value.code === 'E_NOT_FOUND'
        || value.error === 'conversation not found');
      function observed(this: unknown, event: unknown, request: any) {
        const selected = request?.payload?.cid === selectedCid
          && ['conversations.history', 'groupChat.abort', 'videoStudio.reviewPanel'].includes(request?.channel);
        const returned = original.call(this, event, request);
        if (!selected) return returned;
        if (state.rows.length >= 64) { state.overflow++; return returned; }
        const row: any = { channel: request.channel, startStage: state.stage,
          settled: false, ok: null, knownMissing: false, missingCode: null, rejected: false, reviewEmpty: null };
        state.rows.push(row);
        const observe = (value: any, rejected: boolean) => {
          try {
            Object.assign(row, { endStage: state.stage, settled: true,
              ok: !rejected && value?.ok === true, knownMissing: !rejected && missing(value), rejected,
              missingCode: !rejected && missing(value)
                ? (['E_UNKNOWN', 'E_NOT_FOUND', 'E_CONVERSATION_NOT_FOUND'].includes(value.code) ? value.code : 'other') : null,
              reviewEmpty: request.channel === 'videoStudio.reviewPanel'
                ? Array.isArray(value?.panel?.compositions) && value.panel.compositions.length === 0 : null });
          } catch { /* Observation cannot alter the real response. */ }
        };
        // This non-async wrapper returns the exact original Promise/object.
        // Both side-observer callbacks are bounded and never rethrow.
        if (returned && typeof returned.then === 'function') void returned.then(
          (value: unknown) => observe(value, false), () => observe(null, true));
        else observe(returned, false);
        return returned;
      }
      ipcMain.removeHandler('orkas.invoke'); ipcMain.handle('orkas.invoke', observed as any);
      (globalThis as any).__cleanupLifetimeEvidence = { state, restore() {
        if (handlers.get('orkas.invoke') === observed) {
          ipcMain.removeHandler('orkas.invoke'); ipcMain.handle('orkas.invoke', original as any);
          state.restored = true;
        }
      } };
    }, cid);
    await page.evaluate(selectedCid => {
      const root = window as any, apiFetch = root.apiFetch, video = root.VideoReviewPanel;
      const rows: any[] = []; let overflow = 0;
      const push = (channel: string) => {
        if (rows.length >= 64) { overflow++; return; }
        const stack = String(new Error().stack || '');
        rows.push({ channel, historyLoader: stack.includes('loadConversationHistory'),
          missingRecovery: stack.includes('_recoverMissingConversation'),
          conversationModule: stack.includes('/modules/conversation.js') });
      };
      function observedFetch(this: unknown, url: unknown, ...args: any[]) {
        if (typeof url === 'string') {
          if (url.startsWith('/api/conversations/' + encodeURIComponent(selectedCid) + '/history?')) push('conversations.history');
          else if (url === '/api/conversations/' + selectedCid + '/abort') push('groupChat.abort');
        }
        return apiFetch.call(this, url, ...args);
      }
      const originals = { probe: video?.probe, notifyTurnEnd: video?.notifyTurnEnd };
      const wrappers: Record<string, Function> = {};
      for (const method of ['probe', 'notifyTurnEnd'] as const) if (typeof originals[method] === 'function') {
        wrappers[method] = function (this: unknown, owner: unknown, ...args: any[]) {
          if (owner === selectedCid) push('VideoReviewPanel.' + method);
          return originals[method].call(this, owner, ...args);
        };
        video[method] = wrappers[method];
      }
      root.apiFetch = observedFetch;
      root.__cleanupLifetimeEvidence = { rows, get overflow() { return overflow; }, restore() {
        if (root.apiFetch === observedFetch) root.apiFetch = apiFetch;
        for (const method of ['probe', 'notifyTurnEnd']) if (video?.[method] === wrappers[method]) video[method] = originals[method as keyof typeof originals];
      } };
    }, cid);
    const markStage = (stage: 'cleanup' | 'absence-check' | 'restore' | 'recovered') =>
      app.electronApp!.evaluate((_electron, stage) => { (globalThis as any).__cleanupLifetimeEvidence.state.stage = stage; }, stage);
    let evidence: any;
    try {
      await section.locator('[data-cleanup-action="confirm"]').click();
      await expect(section).toContainText('Recycled 1');
      await markStage('absence-check');
      expect(existsSync(path.join(root, `${cid}.jsonl`))).toBe(false);
      // A polling request can overlap the tombstone commit. Absence is the
      // required history result until the user explicitly restores this task.
      const missing = await app.invoke<any>('conversations.history', { cid });
      expect(missing).toMatchObject({ ok: false, error: 'conversation not found' });
      await testInfo.attach('deleted-history-receipt', {
        body: Buffer.from(JSON.stringify({ expectedAbsent: true, code: missing.code, deletedFileAbsent: true })),
        contentType: 'application/json',
      });
      app.releaseControlledModelChunk(); app.finishControlledModelStream();
      const { batches } = await app.invoke<any>('recycle.list');
      const batch = batches.find((entry: any) => entry.items.some((item: any) => item.path === `cloud/chats/${cid}.jsonl`));
      expect(batch).toBeTruthy();
      await markStage('restore');
      // Independent existing file-absence oracle at the actual restore boundary.
      // This one additional assertion read is separate from the zero-I/O observer.
      expect(existsSync(path.join(root, `${cid}.jsonl`))).toBe(false);
      expect((await app.invoke<any>('recycle.restore', { id: batch.id })).failed).toBe(0);
      await markStage('recovered');
      const history = readFileSync(path.join(root, `${cid}.jsonl`), 'utf8');
      expect(history).toContain('Write a short task cleanup fixture.');
      const restored = await app.invoke<any>('conversations.history', { cid });
      expect(restored.ok).toBe(true);
      expect(JSON.stringify(restored.history)).toContain('Write a short task cleanup fixture.');
      expect((await app.invoke<any>('groupChat.runtimeStatus', { cid })).processing).toBe(false);
      await expect.poll(() => app.electronApp!.evaluate(() =>
        (globalThis as any).__cleanupLifetimeEvidence.state.rows.every((row: any) => row.settled),
      )).toBe(true);
    } finally {
      const main = await app.electronApp!.evaluate(() => {
        const owner = (globalThis as any).__cleanupLifetimeEvidence;
        owner.restore();
        return owner.state;
      });
      const renderer = await page.evaluate(() => {
        const owner = (window as any).__cleanupLifetimeEvidence;
        owner.restore();
        return { rows: owner.rows, overflow: owner.overflow };
      });
      evidence = { main, renderer };
      await testInfo.attach('cleanup-lifetime-requests', {
        body: Buffer.from(JSON.stringify(evidence)), contentType: 'application/json',
      });
    }
    expect(evidence.main.restored).toBe(true);
    expect(evidence.main.overflow).toBe(0);
    expect(evidence.renderer.overflow).toBe(0);
    const reviewCalls = evidence.main.rows.filter((row: any) => row.channel === 'videoStudio.reviewPanel');
    expect(reviewCalls.every((row: any) => row.settled && row.ok && row.reviewEmpty)).toBe(true);
    const historyCalls = evidence.main.rows.filter((row: any) => row.channel === 'conversations.history');
    const failures = historyCalls.filter((row: any) => row.settled && !row.ok);
    expect(failures.every((row: any) => row.knownMissing && !row.rejected)).toBe(true);
    expect(failures.every((row: any) => row.startStage !== 'recovered')).toBe(true);
    const absenceCalls = historyCalls.filter((row: any) => row.startStage === 'absence-check');
    expect(absenceCalls.length).toBeGreaterThan(0);
    expect(absenceCalls.every((row: any) => row.settled && !row.ok && row.knownMissing)).toBe(true);
    expect(historyCalls.some((row: any) => row.startStage === 'recovered' && row.settled && row.ok)).toBe(true);
  });
  for (const inProject of [false, true]) test(`previews, cancels, excludes, cleans and restores ${inProject ? 'project' : 'personal'} history using real IPC and storage`, async ({ orkas }, testInfo) => {
    const projectId = inProject ? (await orkas.invoke<any>('projects.create', { name: 'Cleanup project' })).project.project_id : '';
    const { task: automation } = await orkas.invoke<any>('autoTasks.create', {
      title: 'Keep automation configuration', content: 'Fixture only', enabled: false,
      schedule: { type: 'daily', hour: 9, minute: 0 }, ...(projectId ? { project_id: projectId } : {}),
    });
    const dataRoot = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', ...(projectId ? ['projects', projectId] : []));
    const root = path.join(dataRoot, 'chats');
    const cids: string[] = [];
    for (const title of ['Old completed task', 'Keep this completed task', 'Old failed task', 'Old pinned task', 'Unread completed task', 'Draft task', 'Attachment-only draft']) {
      const { conversation } = await orkas.invoke<any>('conversations.create', { title, projectId });
      cids.push(conversation.conversation_id);
    }
    const old = '2020-01-01T00:00:00Z';
    const indexFile = path.join(root, '_index.json');
    const index = JSON.parse(readFileSync(indexFile, 'utf8'));
    for (const [i, cid] of cids.entries()) {
      const row = index.find((r: any) => r.conversation_id === cid);
      row.created_at = old; row.updated_at = old;
      if (i === 3) row.pinned_at = old;
      if (i === 2) row.origin_auto_task_id = automation.id;
      const dir = path.join(root, cid); mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(row));
      writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, status: 'idle', in_flight: [], last_active_at: old }));
      writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify([{ task_id: `t_${cid}`, cid, assignee: 'commander', instruction: 'Fixture task', created_by: 'user', source_msg_id: 'source', status: i === 2 ? 'failed' : 'done', created_at: old, ended_at: old }]));
      writeFileSync(path.join(root, `${cid}.jsonl`), JSON.stringify({ id: 'source', from: 'user', content: 'Preserved history', ts: old }) + '\n');
    }
    const projectBefore = projectId ? readFileSync(path.join(dataRoot, 'project.json'), 'utf8') : '';
    const attachment = (cid: string) => path.join(dataRoot, 'chat_attachments', cid, 'notes.txt');
    const nestedAttachment = path.join(dataRoot, 'chat_attachments', cids[6], 'folder', 'draft.txt');
    mkdirSync(path.dirname(nestedAttachment), { recursive: true });
    writeFileSync(nestedAttachment, 'Nested unsent attachment');
    for (const cid of [cids[0], cids[6]]) {
      mkdirSync(path.dirname(attachment(cid)), { recursive: true });
      writeFileSync(attachment(cid), 'Attachment contents');
    }
    writeFileSync(path.join(root, `${cids[0]}.jsonl`), JSON.stringify({ id: 'source', from: 'user', content: 'Preserved history', attachments: ['notes.txt'], ts: old }) + '\n');
    writeFileSync(indexFile, JSON.stringify(index));
    let standalone = '';
    const standaloneRoot = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats');
    if (projectId) {
      standalone = (await orkas.invoke<any>('conversations.create', { title: 'Top-level task' })).conversation.conversation_id;
      const standaloneIndex = path.join(standaloneRoot, '_index.json');
      const rows = JSON.parse(readFileSync(standaloneIndex, 'utf8'));
      const row = rows.find((item: any) => item.conversation_id === standalone);
      row.created_at = old; row.updated_at = old;
      writeFileSync(standaloneIndex, JSON.stringify(rows));
      const dir = path.join(standaloneRoot, standalone); mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(row));
      writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, status: 'idle', in_flight: [], last_active_at: old }));
      writeFileSync(path.join(standaloneRoot, `${standalone}.jsonl`), JSON.stringify({ id: 'personal', from: 'user', content: 'Keep top-level history', ts: old }) + '\n');
    }
    const page = await orkas.relaunch();
    // Create the missing-transcript shape after startup's one-time ghost
    // migration, matching unsent tasks encountered during an active session.
    rmSync(path.join(root, `${cids[6]}.jsonl`));
    await page.evaluate(([unread, draft, pid]) => {
      localStorage.setItem('task_unread_v1_account-e2e', JSON.stringify({ unread: [{ cid: unread, projectId: pid || null, finishedAt: Date.now(), status: 'completed' }], read: [] }));
      localStorage.setItem(`draft_${draft}`, JSON.stringify({ text: 'Keep this unsent draft' }));
    }, [cids[4], cids[5], projectId]);
    await page.reload();
    await page.evaluate(cid => {
      window.eval('_chatAttachments').set(cid, [{ name: 'notes.txt', dataUrl: URL.createObjectURL(new Blob(['Draft preview'])), status: 'ready' }]);
    }, cids[6]);
    await page.locator('#settings-btn').click();
    await page.locator('[data-settings-tab="data"]').click();
    const section = page.locator('#settings-task-cleanup');
    await expect(section).toContainText('Clean up (0)');
    await expect(section.getByRole('combobox')).toContainText('30');
    await expect(page.locator('#settings-section-local h2')).toHaveText('Data directory');
    await expect(page.locator('#settings-section-local .settings-row-title')).toHaveCount(0);
    await section.screenshot({ path: testInfo.outputPath('cleanup-preview.png') });
    await section.locator('[data-cleanup-action="view"]').click();
    if (projectId) {
      await expect(section.locator('[data-cleanup-project]')).toHaveCount(1);
      await section.locator('[data-cleanup-action="project"]').click();
      await expect(section.locator('.settings-cleanup-project-toggle [data-ui-icon]')).toHaveCount(2);
      await expect(section.locator(`.settings-cleanup-list > .settings-cleanup-item [data-cleanup-cid="${standalone}"]`)).toHaveCount(1);
      await expect(section.locator('.settings-cleanup-project .settings-cleanup-item.is-nested')).toHaveCount(7);
    } else await expect(section.locator('[data-cleanup-project]')).toHaveCount(0);
    await expect(section.locator('[data-cleanup-cid]')).toHaveCount(projectId ? 8 : 7);
    await expect(section.locator('.settings-cleanup-tag').filter({ hasText: 'Automation' })).toHaveCount(1);
    await section.locator('[data-cleanup-all]').check();
    if (standalone) await section.locator(`[data-cleanup-cid="${standalone}"]`).uncheck();
    await expect(section.locator(`[data-cleanup-cid="${cids[3]}"]`)).toBeChecked();
    await expect(section.locator(`[data-cleanup-cid="${cids[5]}"]`)).toBeChecked();
    await section.locator('[data-cleanup-action="prepare"]').click();
    await expect(section.locator('[data-cleanup-action="confirm"]')).toBeVisible();
    await section.locator('[data-cleanup-action="cancel"]').click();
    expect(existsSync(path.join(root, `${cids[0]}.jsonl`))).toBe(true);
    await section.locator(`[data-cleanup-cid="${cids[1]}"]`).uncheck();
    await section.locator('[data-cleanup-action="prepare"]').click();
    await page.setViewportSize({ width: 1000, height: 900 });
    expect(await section.locator('[data-cleanup-action="confirm"]').evaluate(el => {
      const row = el.closest('.settings-row')!.getBoundingClientRect();
      const button = el.getBoundingClientRect();
      return button.left >= row.left && button.right <= row.right;
    })).toBe(true);
    await section.screenshot({ path: testInfo.outputPath('cleanup-en.png') });
    await page.evaluate(async () => { await (window as any).setLang('zh'); });
    await section.screenshot({ path: testInfo.outputPath('cleanup-zh.png') });
    await page.setViewportSize({ width: 620, height: 780 });
    await expect(section.locator('[data-cleanup-action="confirm"]')).toHaveText('移入回收站（6）');
    await expect(section.getByRole('combobox')).toContainText('30 天以前');
    const geometry = await section.evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
    await section.screenshot({ path: testInfo.outputPath('cleanup-zh-narrow.png') });
    // Cleanup is maintenance, not task activity. Observe the real old history
    // throughout deletion so a transient promotion into Recent is not missed.
    await page.evaluate(async ({ ids, pid }) => {
      if (pid) await (window as any).loadConversationProject(pid, { reset: true });
      const recent = document.getElementById('today-list')!;
      const promoted = new Set<string>();
      const observer = new MutationObserver(() => {
        for (const row of recent.querySelectorAll<HTMLElement>('[data-cid]')) {
          if (ids.includes(row.dataset.cid!)) promoted.add(row.dataset.cid!);
        }
      });
      observer.observe(recent, { childList: true, subtree: true });
      (window as any).__cleanupRecentObservation = { promoted, observer };
    }, { ids: cids, pid: projectId });
    await expect(page.locator('#today-list [data-cid]')).toHaveCount(0);
    // Hold the second real deletion at IPC to inspect the first completed one.
    await orkas.electronApp!.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get('orkas.invoke');
      let removals = 0;
      ipcMain.removeHandler('orkas.invoke');
      ipcMain.handle('orkas.invoke', async (event, request) => {
        if (request.channel === 'conversations.cleanup.remove' && ++removals === 2) {
          ipcMain.removeHandler('orkas.invoke');
          ipcMain.handle('orkas.invoke', original);
          await new Promise<void>(resolve => ipcMain.once('cleanup-test-resume', () => resolve()));
        }
        const response = await original(event, request);
        if (request.channel === 'conversations.cleanup.remove' && removals === 1 && response.status === 'deleted') {
          (globalThis as any).__cleanupFirstRemovedCid = request.payload.cid;
        }
        return response;
      });
    });
    await section.locator('[data-cleanup-action="confirm"]').click();
    try {
      await expect(section.getByRole('status')).toHaveCount(1);
      await expect(section.getByRole('status')).toContainText('正在清理 1 / 6');
      const removed = await orkas.electronApp!.evaluate(() => (globalThis as any).__cleanupFirstRemovedCid);
      expect(cids).toContain(removed);
      await expect(page.locator(`.conv-item[data-cid="${removed}"]`)).toHaveCount(0);
      expect(await page.evaluate(cid => window.eval('conversations').some((row: any) => row.conversation_id === cid), removed)).toBe(false);
      await expect(page.locator('#today-list [data-cid]')).toHaveCount(0);
      await expect(section.locator('[data-cleanup-action="stop"]')).toBeEnabled();
      await section.screenshot({ path: testInfo.outputPath('cleanup-progress-zh.png') });
    } finally {
      await orkas.electronApp!.evaluate(({ ipcMain }) => { ipcMain.emit('cleanup-test-resume'); });
    }
    await expect(section).toContainText('已回收 6');
    expect(await page.evaluate(() => {
      const { observer, promoted } = (window as any).__cleanupRecentObservation;
      observer.disconnect();
      return Array.from(promoted);
    })).toEqual([]);
    expect(existsSync(path.join(root, `${cids[0]}.jsonl`))).toBe(false);
    expect(existsSync(attachment(cids[0]))).toBe(false);
    expect(existsSync(attachment(cids[6]))).toBe(false);
    expect(existsSync(path.join(root, `${cids[1]}.jsonl`))).toBe(true);
    for (const cid of cids.slice(2)) expect(existsSync(path.join(root, `${cid}.jsonl`))).toBe(false);
    expect(await page.evaluate(cid => localStorage.getItem(`draft_${cid}`), cids[5])).toBeNull();
    expect(await page.evaluate(cid => window.eval('_chatAttachments').has(cid), cids[6])).toBe(false);
    expect(await page.evaluate(cid => (window as any).TaskUnread.isUnread(cid), cids[4])).toBe(false);
    if (standalone) expect(existsSync(path.join(standaloneRoot, `${standalone}.jsonl`))).toBe(true);
    expect((await orkas.invoke<any>('autoTasks.list', { projectId: projectId || null })).tasks.some((task: any) => task.id === automation.id)).toBe(true);
    if (projectId) expect(readFileSync(path.join(dataRoot, 'project.json'), 'utf8')).toBe(projectBefore);
    const { batches } = await orkas.invoke<any>('recycle.list');
    expect(existsSync(nestedAttachment)).toBe(false);
    const draftBatch = batches.find((b: any) => b.display_items?.some((item: any) => item.id === cids[6]));
    expect(draftBatch).toBeTruthy();
    expect(draftBatch.display_items).toEqual([expect.objectContaining({ category: 'conversation', id: cids[6], title: 'Attachment-only draft' })]);
    expect(await orkas.invoke<any>('recycle.restore', { id: draftBatch.id })).toMatchObject({ ok: true, failed: 0, reactivated: 1 });
    expect(readFileSync(nestedAttachment, 'utf8')).toBe('Nested unsent attachment');
    expect(readFileSync(attachment(cids[6]), 'utf8')).toBe('Attachment contents');
    expect((await orkas.invoke<any>('conversations.get', { cid: cids[6] })).conversation).toMatchObject({ title: 'Attachment-only draft' });
    const prefix = projectId ? `cloud/projects/${projectId}` : 'cloud';
    const batch = batches.find((b: any) => b.items.some((item: any) => item.path === `${prefix}/chats/${cids[0]}.jsonl`));
    expect(batch).toBeTruthy();
    const recycle = page.locator('#settings-recycle-group');
    // The public build has one local list, including retained historical batches.
    await expect(recycle.locator('[data-recycle-source="local"]')).toBeVisible();
    await expect(recycle.locator('[data-recycle-tab]')).toHaveCount(0);
    await recycle.locator(`[data-recycle-restore="${batch.id}"]`).click();
    await page.evaluate(() => {
      const state = { samples: [] as unknown[], observer: null as MutationObserver | null };
      state.observer = new MutationObserver(() => {
        const toasts = Array.from(document.querySelectorAll('.ui-toast')).map((el) => ({
          text: el.textContent?.trim(), classes: el.className,
          visible: el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().width > 0
            && getComputedStyle(el).visibility === 'visible',
        }));
        if (state.samples.length < 30 && toasts.length) state.samples.push({ at: performance.now(), toasts });
      });
      state.observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      (window as any).__cleanupRestoreToasts = state;
    });
    try {
      await page.getByRole('dialog').getByRole('button', { name: '恢复', exact: true }).click();
      // Observe the real transient UI from before the action. A later polling
      // snapshot can miss a correctly displayed toast after it naturally closes.
      await expect.poll(() => page.evaluate(() => (window as any).__cleanupRestoreToasts.samples.some(
        (sample: any) => sample.toasts.some((toast: any) => toast.visible && /^已恢复 \d+ 个文件$/.test(toast.text)),
      ))).toBe(true);
    } finally {
      const diagnostics = await page.evaluate(() => {
        const state = (window as any).__cleanupRestoreToasts;
        state.observer.disconnect();
        return state.samples;
      }).catch(() => ({ unavailable: true }));
      await testInfo.attach('restore-toast-observations.json', {
        body: JSON.stringify(diagnostics), contentType: 'application/json',
      });
    }
    // History is restored before attachments and index reactivation. Wait for
    // the whole restore operation rather than treating its first file as done.
    await expect.poll(() => {
      if (!existsSync(attachment(cids[0]))) return false;
      const row = JSON.parse(readFileSync(indexFile, 'utf8')).find((item: any) => item.conversation_id === cids[0]);
      return !!row && !row.deleted_at;
    }).toBe(true);
    await expect.poll(() => existsSync(path.join(root, `${cids[0]}.jsonl`))).toBe(true);
    expect(readFileSync(path.join(root, `${cids[0]}.jsonl`), 'utf8')).toContain('Preserved history');
    expect(readFileSync(attachment(cids[0]), 'utf8')).toBe('Attachment contents');
    if (projectId) {
      const restored = JSON.parse(readFileSync(indexFile, 'utf8')).find((row: any) => row.conversation_id === cids[0]);
      expect(restored.project_id).toBe(projectId); expect(restored.deleted_at).toBeFalsy();
      expect(readFileSync(path.join(dataRoot, 'project.json'), 'utf8')).toBe(projectBefore);
    }
  });
});
