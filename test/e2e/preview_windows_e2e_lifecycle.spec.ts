import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures/orkas';

test('task previews share one native window while different applications remain open together', async ({ orkas }, info) => {
  const page = orkas.page!;
  const expectBackgroundWindows = async () => {
    if (process.env.PWDEBUG === '1' || process.env.ORKAS_E2E_SHOW_WINDOW === '1') return;
    const state = await orkas.electronApp!.evaluate(({ app, BrowserWindow }) => ({
      windows: BrowserWindow.getAllWindows().map(win => ({
        visible: win.isVisible(), focused: win.isFocused(), focusable: win.isFocusable(),
      })),
      dockVisible: process.platform === 'darwin' ? app.dock!.isVisible() : false,
    }));
    expect(state.dockVisible).toBe(false);
    expect(state.windows.length).toBeGreaterThan(1);
    for (const win of state.windows) expect(win).toEqual({ visible: false, focused: false, focusable: false });
  };
  const note = orkas.createWorkspaceFile('single-preview.md', '# Original');
  const next = orkas.createWorkspaceFile('next-preview.md', '# Next task');
  const image = orkas.createWorkspaceFile('single-preview.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100"/></svg>');
  const first: any = await orkas.invoke('conversations.create', { title: 'First' });
  const second: any = await orkas.invoke('conversations.create', { title: 'Second' });
  const openFile = (file: string, cid: string) => page.evaluate(args =>
    (window as any).openChatFileViewer(args.file, args.title, { cid: args.cid }), { file, cid, title: path.basename(file) });
  const preview = await orkas.openPreview(() => openFile(note, first.conversation.conversation_id));
  await expect(preview.locator('.chat-file-viewer-body')).toContainText('Original');
  await expectBackgroundWindows();
  const native = await orkas.electronApp!.browserWindow(preview);
  const id = await native.evaluate(w => w.id);
  await native.evaluate(w => w.setBounds({ x: 100, y: 100, width: 740, height: 540 }));
  await expect(preview).toHaveTitle('single-preview.md');
  await expect(preview.locator('.chat-file-viewer-title')).toBeHidden();
  await expect(preview.locator('.chat-file-viewer-close')).toBeHidden();
  expect((await preview.locator('.chat-file-viewer-body').boundingBox())!.y).toBe(0);
  await expect(preview.locator('.chat-file-viewer-actions')).toHaveCSS('position', 'absolute');
  await preview.screenshot({ path: info.outputPath('markdown-window.png') });
  await preview.locator('[data-mve-action="edit"]').click();
  await preview.locator('[data-mve-textarea]').fill('# Keep my edit');
  await openFile(image, first.conversation.conversation_id);
  let dialog = preview.locator('.ui-dialog-overlay:visible');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-act="cancel"]').click();
  await expect(preview.locator('[data-mve-textarea]')).toHaveValue('# Keep my edit');
  await openFile(image, first.conversation.conversation_id);
  dialog = preview.locator('.ui-dialog-overlay:visible');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-act="ok"]').click();
  await expect(preview.locator('.chat-lightbox-img')).toHaveAttribute('alt', 'single-preview.svg');
  await openFile(next, second.conversation.conversation_id);
  await expect(preview.locator('.chat-file-viewer-body')).toContainText('Next task');
  expect(await native.evaluate(w => w.id)).toBe(id);
  expect(await native.evaluate(w => w.getBounds())).toMatchObject({ x: 100, y: 100, width: 740, height: 540 });
  const appWindows = [];
  for (const title of ['One', 'Two']) {
    const entry = orkas.createWorkspaceFile(`app-${title}/index.html`, `<!doctype html><h1>${title}</h1>`);
    const app: any = await orkas.invoke('savedApps.saveFromPath', { path: entry, title });
    const appPage = await orkas.openPreview(() => page.evaluate(source =>
      (window as any).OrkasPreviewWindows.open(source), { kind: 'app', appId: app.id, title }));
    await expect(appPage.frameLocator('.saved-app-viewer-frame').locator('h1')).toHaveText(title);
    await expect(appPage).toHaveTitle(title);
    await expect(appPage.locator('.saved-app-viewer-share')).toHaveCount(0);
    expect((await appPage.locator('.saved-app-viewer-frame').boundingBox())!.y).toBe(0);
    await expect(appPage.locator('.saved-app-viewer-title')).toBeHidden();
    await expect(appPage.locator('.saved-app-viewer-close')).toBeHidden();
    await appPage.screenshot({ path: info.outputPath(`app-${title}-window.png`) });
    await expectBackgroundWindows();
    // Reopening an application reuses its native window without activating it.
    await page.evaluate(source => (window as any).OrkasPreviewWindows.open(source), { kind: 'app', appId: app.id, title });
    await expectBackgroundWindows();
    appWindows.push(appPage);
  }
  await openFile(note, first.conversation.conversation_id);
  await expect(preview.locator('.chat-file-viewer-body')).toContainText('Original');
  expect(orkas.electronApp!.windows().filter(p => p.url().endsWith('/preview.html'))).toHaveLength(3);
  await expectBackgroundWindows();
  for (const [i, app] of appWindows.entries()) {
    await expect(app.frameLocator('.saved-app-viewer-frame').locator('h1')).toHaveText(i ? 'Two' : 'One');
  }
});

test('image window keeps its original gallery after task switching and loads older images inside the window', async ({ orkas }, info) => {
  const page = orkas.page!;
  const created: any = await orkas.invoke('conversations.create', { title: 'Preview gallery' });
  const cid = created.conversation.conversation_id;
  const files: string[] = [];
  for (const name of ['first.svg', 'middle.svg', 'last.svg']) files.push(orkas.createWorkspaceFile(name,
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="steelblue"/></svg>'));
  const rows = Array.from({ length: 130 }, (_, i) => ({ id: `preview-${i}`, from: 'commander', to: ['user'],
    ts: new Date(Date.now() - (130 - i) * 1000).toISOString(),
    text: [0, 80, 129].includes(i) ? `![${i === 0 ? 'first' : i === 80 ? 'middle' : 'last'}](${files[i === 0 ? 0 : i === 80 ? 1 : 2]})` : 'A text-only history row.',
  }));
  appendFileSync(path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  await page.evaluate(async id => { await (window as any).loadConversations(); await (window as any).setView('conversation', id); }, cid);
  const preview = await orkas.openPreview(() => page.locator('#chat-history img.chat-md-img').last().click());
  const image = preview.locator('.chat-lightbox-img');
  await expect(image).toHaveAttribute('alt', 'last');
  await expect(preview.locator('.chat-lightbox-title')).toBeHidden();
  await expect(preview.locator('.chat-lightbox-close')).toBeHidden();
  await page.locator('#new-chat-btn').click();
  await expect(image).toHaveAttribute('alt', 'last');
  await preview.locator('.chat-lightbox-previous').click();
  await expect(image).toHaveAttribute('alt', 'middle');
  await preview.locator('.chat-lightbox-previous').click();
  await expect(image).toHaveAttribute('alt', 'first');
  await expect(preview.locator('.chat-lightbox-previous')).toBeDisabled();
  await preview.locator('.chat-lightbox-next').click();
  await expect(image).toHaveAttribute('alt', 'middle');
  await preview.locator('.chat-lightbox-next').click();
  await expect(image).toHaveAttribute('alt', 'last');
  const bounds = await preview.locator('.chat-lightbox-stage').boundingBox();
  for (const selector of ['.chat-lightbox-previous', '.chat-lightbox-next', '.chat-lightbox-actions']) {
    const rect = await preview.locator(selector).boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
  }
  await preview.keyboard.press('+');
  await expect(image).not.toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await preview.screenshot({ path: info.outputPath('image-window.png') });
  const win = await orkas.electronApp!.browserWindow(preview);
  await win.evaluate(w => w.setBounds({ x: 120, y: 100, width: 740, height: 540 }));
  expect(await win.evaluate(w => w.getBounds())).toMatchObject({ x: 120, y: 100, width: 740, height: 540 });
  await preview.locator('.chat-lightbox-share').click();
  await expect(preview.locator('.chat-share-overlay')).toBeVisible();
  await expect(page.locator('.chat-share-overlay')).toHaveCount(0);
  await win.evaluate(w => w.close());
  await expect.poll(() => preview.isClosed()).toBe(true);
  expect(page.isClosed()).toBe(false);
});

test('native close protects unsaved edits and saved files remain bound to the original preview', async ({ orkas }) => {
  const page = orkas.page!;
  const file = orkas.createWorkspaceFile('editable.md', '# Original\n');
  const preview = await orkas.openPreview(() => page.evaluate(file => (window as any).openChatFileViewer(file, 'editable.md'), file));
  await expect(preview.locator('.chat-file-viewer-body')).toContainText('Original');
  await preview.locator('[data-mve-action="edit"]').click();
  await preview.locator('[data-mve-textarea]').fill('# Unsaved edit\n');
  const win = await orkas.electronApp!.browserWindow(preview);
  await win.evaluate(w => w.close());
  const dialog = preview.locator('.ui-dialog-overlay:visible');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-act="cancel"]').click();
  expect(preview.isClosed()).toBe(false);
  await expect(preview.locator('[data-mve-textarea]')).toHaveValue('# Unsaved edit\n');
  await preview.locator('[data-mve-action="save"]').click();
  await expect(preview.locator('.chat-file-viewer-body')).toContainText('Unsaved edit');
  await orkas.closePreview(preview);
  await expect.poll(() => preview.isClosed()).toBe(true);
  const reopened = await orkas.openPreview(() => page.evaluate(file => (window as any).openChatFileViewer(file, 'editable.md'), file));
  await expect(reopened.locator('.chat-file-viewer-body')).toContainText('Unsaved edit');
  // Account-root cleanup destroys windows before the old account loses scope.
  await orkas.electronApp!.evaluate((_electron, module) => {
    (process as any).mainModule.require(module).notifyUserSwitch('account-e2e', 'another-user');
  }, path.resolve(__dirname, '../../src/main/features/user-switch-hooks.ts'));
  await expect.poll(() => reopened.isClosed()).toBe(true);
});

test('legacy application results return to their original task after main-window navigation', async ({ orkas }) => {
  const page = orkas.page!;
  const created: any = await orkas.invoke('conversations.create', { title: 'Application result destination' });
  const cid = created.conversation.conversation_id;
  const artifact: any = await orkas.electronApp!.evaluate((_electron, args) => {
    return (process as any).mainModule.require(args.module).createArtifact('account-e2e', args.cid, 'commander', {
      title: 'Choice', files: [{ path: 'index.html', content: '<!doctype html><button onclick="parent.postMessage({__orkasArtifact:true,type:\'submit\',payload:{choice:7}},\'*\')">Submit choice</button>' }],
    });
  }, { module: path.resolve(__dirname, '../../src/main/features/chat_artifacts.ts'), cid });
  expect(artifact.ok).toBe(true);
  const preview = await orkas.openPreview(() => page.evaluate(async args => {
    await (window as any).loadConversations();
    await (window as any).setView('conversation', args.cid);
    (window as any).submissions = [];
    (window as any).sendInCurrentConversation = async (text: string, _extra: unknown, options: any) => {
      (window as any).submissions.push({ cid: (window as any).eval('currentCid'), text });
      options?.onStarted();
      return { started: true };
    };
    (window as any).openChatArtifactViewer(args);
  }, { cid, artifactId: artifact.artifactId, title: 'Choice', agentId: 'commander' }));
  await page.locator('#new-chat-btn').click();
  await expect(preview.locator('.chat-artifact-viewer-title')).toBeHidden();
  await expect(preview.locator('.chat-artifact-viewer-close')).toBeHidden();
  await expect(preview.locator('.chat-artifact-viewer-save')).toBeVisible();
  await preview.frameLocator('.chat-artifact-viewer-frame').getByRole('button', { name: 'Submit choice' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).submissions.length)).toBe(1);
  const [submission] = await page.evaluate(() => (window as any).submissions);
  expect(submission.cid).toBe(cid);
  const encoded = submission.text.match(/<artifact-result\b[^>]*>\s*([\s\S]*?)\s*<\/artifact-result>/);
  expect(JSON.parse(encoded[1])).toEqual({ choice: 7 });
  expect(preview.isClosed()).toBe(false);
});

test('saving from an app preview retains its original bundle after task navigation and reports missing sources', async ({ orkas }, info) => {
  const page = orkas.page!;
  const created: any = await orkas.invoke('conversations.create', { title: 'App to keep' });
  const cid = created.conversation.conversation_id;
  const artifact: any = await orkas.electronApp!.evaluate((_electron, args) =>
    (process as any).mainModule.require(args.module).createArtifact('account-e2e', args.cid, 'commander', {
      title: 'Keep this app', files: [
        { path: 'index.html', content: '<!doctype html><h1>Original app</h1><script src="app.js"></script>' },
        { path: 'app.js', content: 'document.querySelector("h1").textContent = "Bundle loaded";' },
      ],
    }), { module: path.resolve(__dirname, '../../src/main/features/chat_artifacts.ts'), cid });
  expect(artifact.ok).toBe(true);
  const preview = await orkas.openPreview(() => page.evaluate(source =>
    (window as any).openChatArtifactViewer(source), { cid, artifactId: artifact.artifactId, title: 'Keep this app' }));
  await expect(preview.frameLocator('.chat-artifact-viewer-frame').locator('h1')).toHaveText('Bundle loaded');
  await page.evaluate(async () => { await (window as any).setView('apps'); });
  const save = preview.locator('.chat-artifact-viewer-save');
  await expect(save).toHaveAccessibleName('Save as app');
  await save.click();
  await expect(page.locator('.app-card-name')).toHaveText('Keep this app');
  const saved: any = await orkas.invoke('savedApps.list');
  expect(saved.apps).toHaveLength(1);
  const savedPreview = await orkas.openPreview(() => page.locator('.app-card').click());
  await expect(savedPreview.frameLocator('.saved-app-viewer-frame').locator('h1')).toHaveText('Bundle loaded');
  await preview.screenshot({ path: info.outputPath('artifact-save-window.png') });
  await orkas.electronApp!.evaluate((_electron, args) => {
    const artifacts = (process as any).mainModule.require(args.module);
    const resolved = artifacts.resolveArtifactDir('account-e2e', args.cid, args.artifactId);
    if (!resolved.ok) throw new Error('Fixture source missing');
    (process as any).mainModule.require('node:fs').rmSync(resolved.dirPath, { recursive: true });
  }, { module: path.resolve(__dirname, '../../src/main/features/chat_artifacts.ts'), cid, artifactId: artifact.artifactId });
  await save.click();
  await expect(preview.locator('.ui-dialog-overlay:visible')).toContainText('Could not save');
  await expect(save).toBeEnabled();
  expect((await orkas.invoke<any>('savedApps.list')).apps).toHaveLength(1);
});

test('video uses the full window and restores floating actions on pointer, keyboard and pause', async ({ orkas }, info) => {
  const page = orkas.page!;
  // Hidden windows may never paint captured canvas frames. Generate real local
  // media with the bundled encoder so playback remains part of the assertion.
  const file = path.join(orkas.userWorkspaceRoot, 'preview-motion.webm');
  await orkas.electronApp!.evaluate(async (_electron, args) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const { ffmpeg } = require(args.module).bundledFfmpegPaths();
    if (!ffmpeg) throw new Error('Bundled FFmpeg is required for the video preview fixture');
    await new Promise<void>((resolve, reject) => {
      require('node:child_process').execFile(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
        '-i', 'testsrc2=size=640x360:rate=10', '-t', '2', '-an',
        '-c:v', 'libvpx', '-threads', '1', args.file,
      ], { windowsHide: true, timeout: 30000 }, (error: Error | null) => error ? reject(error) : resolve());
    });
  }, { module: path.resolve(__dirname, '../../src/main/util/bundled-runtime.ts'), file });
  const preview = await orkas.openPreview(() => page.evaluate(file =>
    (window as any).openChatFileViewer(file, 'preview-motion.webm'), file));
  const video = preview.locator('video');
  await expect(video).toBeVisible();
  expect((await preview.locator('.chat-file-viewer-body').boundingBox())!.y).toBe(0);
  await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; element.loop = true; await element.play(); });
  const actions = preview.locator('.chat-file-viewer-actions');
  await expect(actions).toHaveCSS('opacity', '0');
  await preview.mouse.move(100, 100);
  await expect(actions).toHaveCSS('opacity', '0.5');
  await preview.screenshot({ path: info.outputPath('video-window.png') });
  await expect(actions).toHaveCSS('opacity', '0');
  await actions.locator('button:visible').first().focus();
  await expect(actions).toHaveCSS('opacity', '1');
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  await video.focus();
  await expect(actions).toHaveCSS('opacity', '0.5');
  await orkas.closePreview(preview);
});

test('presentation fills the native window and retains its slide content on resize', async ({ orkas }, info) => {
  const file = path.join(orkas.userWorkspaceRoot, 'preview-deck.pptx');
  await orkas.electronApp!.evaluate(async (_electron, args) => {
    const engine = (process as any).mainModule.require(args.module);
    const options = { cwd: args.cwd };
    try {
      await engine.runOfficeCli(['create', args.file, '--force', '--json'], options);
      await engine.runOfficeCli(['batch', args.file, '--stop-on-error', '--json'], {
        ...options, stdin: JSON.stringify([
          { command: 'add', parent: '/', type: 'slide', props: { title: 'Quarterly review', text: 'Progress and next steps' } },
          { command: 'add', parent: '/', type: 'slide', props: { title: 'Next steps', text: 'Review the proposed changes' } },
        ]),
      });
    } finally { await engine.closeOfficeFile(args.file, args.cwd); }
  }, { module: path.resolve(__dirname, '../../src/main/features/office/office_engine.ts'), file, cwd: orkas.userWorkspaceRoot });
  const preview = await orkas.openPreview(() => orkas.page!.evaluate(file =>
    (window as any).openChatFileViewer(file, 'preview-deck.pptx'), file));
  const frame = preview.locator('.chat-file-viewer-office');
  await expect(frame).toBeVisible();
  await expect(frame.contentFrame().locator('body')).toContainText('Quarterly review');
  await expect(frame.contentFrame().locator('body')).toContainText('Next steps');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  const native = await orkas.electronApp!.browserWindow(preview);
  for (const width of [960, 480]) {
    await native.evaluate((win, width) => win.setSize(width, 600), width);
    await expect.poll(async () => {
      const box = (await frame.boundingBox())!;
      const viewport = await preview.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }));
      // Native window sizes can round to fractional CSS pixels at Windows DPI
      // scales. Require full coverage within one physical pixel.
      return Math.max(Math.abs(box.y), Math.abs(viewport.width - box.width), Math.abs(viewport.height - box.height)) * viewport.scale;
    }).toBeLessThanOrEqual(1);
    const actions = (await preview.locator('.chat-file-viewer-actions').boundingBox())!;
    expect(actions.x).toBeGreaterThanOrEqual(0);
    expect(actions.x + actions.width).toBeLessThanOrEqual(width);
    await preview.screenshot({ path: info.outputPath(`ppt-window-${width}.png`) });
  }
  await orkas.closePreview(preview);
});
