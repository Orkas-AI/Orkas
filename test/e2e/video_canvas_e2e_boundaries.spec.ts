import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, OrkasTestApp, test } from './fixtures/orkas';


async function createTask(app: OrkasTestApp, title: string, studio = true) {
  const { conversation } = await app.invoke<any>('conversations.create', { title });
  const cid = conversation.conversation_id as string;
  const workspace = await app.electronApp!.evaluate(async (_electron, args) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    if (args.studio) await require(args.chats).bumpConversationActivity('account-e2e', args.cid, new Date().toISOString(), {
      senderKind: 'agent', senderId: '79df9cc89f5f',
    });
    return require(args.workspace).getConversationWorkspacePath('account-e2e', args.cid);
  }, {
    cid, studio,
    chats: path.resolve(__dirname, '../../src/main/features/chats.ts'),
    workspace: path.resolve(__dirname, '../../src/main/features/group_chat/conv_workspace.ts'),
  });
  return { cid, workspace };
}

function writeVideo(workspace: string, title: string, dir = 'campaign') {
  const folder = path.join(workspace, dir, 'videos', 'main');
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'manifest.json');
  writeFileSync(file, JSON.stringify({
    schema_version: 3, id: 'main', label: title,
    canvas: { width: 540, height: 960, fps: 30 },
    scenes: [{ id: 'opening', duration: 3, text: { headline: { value: title } } }],
  }));
  return file;
}

async function enter(app: OrkasTestApp, cid: string) {
  await app.page!.evaluate(async cid => {
    const runtime = window as any;
    await runtime.loadConversations({ fresh: true });
    runtime.setView('conversation', cid);
    await runtime.loadConversationHistory(cid);
    await runtime.VideoCanvas.probe(cid);
  }, cid);
}

// Hold real read responses after Main has read the fixture's files. This controls
// completion order without replacing the renderer or manufacturing its result.
async function controlReads(app: OrkasTestApp) {
  await app.electronApp!.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers?.get('orkas.invoke');
    if (typeof original !== 'function') throw new Error('Native IPC fixture seam unavailable');
    let held: { claimed: boolean; ready: boolean; release: () => void; wait: Promise<void> } | null = null;
    let fault = '';
    const control = {
      hold() {
        let release = () => {};
        const wait = new Promise<void>(resolve => { release = resolve; });
        held = { claimed: false, ready: false, release, wait };
      },
      ready: () => !!held?.ready,
      release() { held?.release(); held = null; },
      fail: (mode: string) => { fault = mode; },
      restore() {
        control.release();
        ipcMain.removeHandler('orkas.invoke');
        ipcMain.handle('orkas.invoke', original);
      },
    };
    ipcMain.removeHandler('orkas.invoke');
    ipcMain.handle('orkas.invoke', async (event, request) => {
      if (request?.channel !== 'videoCanvas.read') return original(event, request);
      const mode = fault;
      fault = '';
      if (mode === 'refused') return { ok: false, code: 'unreadable' };
      if (mode === 'missing') return null;
      const gate = held && !held.claimed ? held : null;
      if (gate) gate.claimed = true;
      const response = await original(event, request);
      if (gate) {
        gate.ready = true;
        await gate.wait;
      }
      return response;
    });
    (globalThis as any).__canvasReadControl = control;
  });
  return {
    hold: () => app.electronApp!.evaluate(() => (globalThis as any).__canvasReadControl.hold()),
    wait: () => expect.poll(() => app.electronApp!.evaluate(() => (globalThis as any).__canvasReadControl.ready())).toBe(true),
    release: () => app.electronApp!.evaluate(() => (globalThis as any).__canvasReadControl.release()),
    fail: (mode: string) => app.electronApp!.evaluate((_electron, mode) => (globalThis as any).__canvasReadControl.fail(mode), mode),
    restore: () => app.electronApp!.evaluate(() => (globalThis as any).__canvasReadControl.restore()),
  };
}

for (const opened of [false, true]) {
  test(`a late older read cannot replace newer canvas content while ${opened ? 'open' : 'closed'}`, async ({ orkas: app }) => {
    const task = await createTask(app, 'Ordered canvas reads', opened);
    writeVideo(task.workspace, 'Initial version');
    await enter(app, task.cid);
    const page = app.page!;
    const toggle = page.locator('#video-canvas-toggle');
    const dot = toggle.locator('.task-unread-dot');
    const title = page.locator('.video-canvas-card.is-video .video-canvas-card-title');
    if (opened) await toggle.click();
    const control = await controlReads(app);
    try {
      writeVideo(task.workspace, 'Older result');
      await control.hold();
      const older = page.evaluate(() => (window as any).VideoCanvas.refresh());
      await control.wait();
      // A first VideoStudio result can arrive while a read still says the task
      // has no canvas. That late absence must not hide the newly available entry.
      if (!opened) await app.electronApp!.evaluate(async (_electron, args) => {
        const require = (process as any).mainModule.require.bind((process as any).mainModule);
        await require(args.chats).bumpConversationActivity('account-e2e', args.cid, new Date().toISOString(), {
          senderKind: 'agent', senderId: '79df9cc89f5f',
        });
      }, { cid: task.cid, chats: path.resolve(__dirname, '../../src/main/features/chats.ts') });
      writeVideo(task.workspace, 'Newest result');
      await page.evaluate(() => (window as any).VideoCanvas.refresh());
      await control.release();
      await older;
      if (opened) {
        await expect(title).toHaveText('Newest result');
        await expect(dot).toBeHidden();
        await page.locator('#video-canvas-close').click();
        await page.evaluate(() => (window as any).VideoCanvas.refresh());
        await expect(dot).toBeHidden();
      } else {
        await expect(toggle).toBeVisible();
        await expect(dot).toBeVisible();
        await toggle.click();
        await expect(title).toHaveText('Newest result');
        await expect(dot).toBeHidden();
      }
    } finally { await control.restore(); }
  });
}

test('closing during an opening read keeps the canvas closed and its update unread', async ({ orkas: app }) => {
  const task = await createTask(app, 'Cancel opening');
  writeVideo(task.workspace, 'Before');
  await enter(app, task.cid);
  const page = app.page!;
  writeVideo(task.workspace, 'Unseen result');
  await page.evaluate(() => (window as any).VideoCanvas.refresh());
  const dot = page.locator('#video-canvas-update-dot');
  await expect(dot).toBeVisible();
  const control = await controlReads(app);
  try {
    await control.hold();
    const opening = page.evaluate(cid => (window as any).VideoCanvas.open(cid), task.cid);
    await control.wait();
    await page.evaluate(() => (window as any).VideoCanvas.close());
    await control.release();
    await opening;
    await expect(page.locator('#video-canvas-panel')).toBeHidden();
    await expect(page.locator('#video-canvas-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(dot).toBeVisible();
    await page.locator('#video-canvas-toggle').click();
    await expect(page.locator('.video-canvas-card.is-video .video-canvas-card-title')).toHaveText('Unseen result');
    await expect(dot).toBeHidden();
  } finally { await control.restore(); }
});

test('a late opening read cannot reveal another task or leak its reminder after navigation', async ({ orkas: app }) => {
  const first = await createTask(app, 'First task');
  const second = await createTask(app, 'Second task');
  writeVideo(first.workspace, 'First task video');
  writeVideo(second.workspace, 'Second task video');
  await enter(app, first.cid);
  const page = app.page!;
  const control = await controlReads(app);
  try {
    await control.hold();
    const opening = page.evaluate(cid => (window as any).VideoCanvas.open(cid), first.cid);
    await control.wait();
    await enter(app, second.cid);
    await control.release();
    await opening;
    await expect(page.locator('#video-canvas-panel')).toBeHidden();
    await expect(page.locator('#video-canvas-update-dot')).toBeHidden();
    await page.locator('#video-canvas-toggle').click();
    await expect(page.locator('.video-canvas-card.is-video .video-canvas-card-title')).toHaveText('Second task video');
    await expect(page.locator('#video-canvas-update-dot')).toBeHidden();
  } finally { await control.restore(); }
});

for (const mode of ['refused', 'missing']) {
  test(`a ${mode} read preserves visible content and unread updates until a successful recovery`, async ({ orkas: app }) => {
    const task = await createTask(app, 'Read recovery');
    writeVideo(task.workspace, 'Known content');
    await enter(app, task.cid);
    const page = app.page!;
    await page.locator('#video-canvas-toggle').click();
    const title = page.locator('.video-canvas-card.is-video .video-canvas-card-title');
    const dot = page.locator('#video-canvas-update-dot');
    const control = await controlReads(app);
    try {
      writeVideo(task.workspace, 'Recovered content');
      await control.fail(mode);
      await page.evaluate(() => (window as any).VideoCanvas.refresh());
      await expect(title).toHaveText('Known content');
      await expect(page.locator('#video-canvas-panel')).toBeVisible();
      await expect(dot).toBeHidden();
      await page.locator('#video-canvas-close').click();
      await page.evaluate(() => (window as any).VideoCanvas.refresh());
      await expect(dot).toBeVisible();
      await control.fail(mode);
      await page.evaluate(() => (window as any).VideoCanvas.refresh());
      await expect(dot).toBeVisible();
      await page.locator('#video-canvas-toggle').click();
      await expect(title).toHaveText('Recovered content');
      await expect(dot).toBeHidden();
    } finally { await control.restore(); }
  });
}

test('timestamp reordering is not new content and removal falls back to remaining work then an empty canvas', async ({ orkas: app }, testInfo) => {
  const task = await createTask(app, 'Multiple productions');
  const alpha = writeVideo(task.workspace, 'Alpha video', 'alpha');
  const beta = writeVideo(task.workspace, 'Beta video', 'beta');
  const time = Date.now() / 1000;
  utimesSync(alpha, time - 10, time - 10);
  utimesSync(beta, time, time);
  await enter(app, task.cid);
  const page = app.page!;
  const toggle = page.locator('#video-canvas-toggle');
  const dot = page.locator('#video-canvas-update-dot');
  const title = page.locator('.video-canvas-card.is-video .video-canvas-card-title');
  await expect(dot).toBeHidden();
  utimesSync(alpha, time + 10, time + 10);
  await page.evaluate(() => (window as any).VideoCanvas.refresh());
  await expect(dot).toBeHidden();
  await toggle.click();
  await expect(title).toHaveText('Alpha video');
  await expect(page.locator('#video-canvas-production')).toBeVisible();
  utimesSync(beta, time + 20, time + 20);
  await page.evaluate(() => (window as any).VideoCanvas.refresh());
  await expect(title).toHaveText('Alpha video');
  await expect(dot).toBeHidden();
  rmSync(path.join(task.workspace, 'alpha'), { recursive: true });
  await page.evaluate(() => (window as any).VideoCanvas.refresh());
  await expect(title).toHaveText('Beta video');
  await expect(page.locator('#video-canvas-production')).toBeHidden();
  await page.locator('#video-canvas-close').click();
  rmSync(path.join(task.workspace, 'beta'), { recursive: true });
  await page.evaluate(() => (window as any).VideoCanvas.refresh());
  await expect(dot).toBeVisible();
  await toggle.click();
  await expect(page.locator('#video-canvas-empty')).toBeVisible();
  await expect(page.locator('.video-canvas-card')).toHaveCount(0);
  await expect(dot).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('canvas-removed-all.png') });
  writeVideo(task.workspace, 'New work');
  await page.evaluate(() => (window as any).VideoCanvas.refresh());
  await expect(title).toHaveText('New work');
  await expect(page.locator('#video-canvas-empty')).toBeHidden();
  await expect(dot).toBeHidden();
});
