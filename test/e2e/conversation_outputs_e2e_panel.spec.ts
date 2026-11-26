// Real wiring for what a conversation produced, end to end.
//
// Two defects this pins, neither reachable from a unit test because both need
// the real IPC + renderer + `chat-app://` stack:
//
//   - a `create_artifact` bundle lives outside the workspace, so no listing saw
//     it and the app existed only inside the bubble that made it;
//   - presentation of generated media depended on the model pasting a
//     `chat-media://` link for its own output, so the same image showed a
//     player in one turn and a bare chip in the next.
//
// The first reply below deliberately does NOT paste a media link; the second
// one does, and must not gain a duplicate underneath it.
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { expect, test } from './fixtures/orkas';

/** A real decodable PNG rather than a pasted blob, so the preview under test
 *  has actual bytes and an intrinsic size. */
function pngBytes(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const px = rowStart + 1 + x * 3;
      raw[px] = 40 + Math.floor((x * 180) / width);
      raw[px + 1] = 90 + Math.floor((y * 120) / height);
      raw[px + 2] = 200;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A short, valid PCM WAV so Chromium has real metadata to distinguish the
 *  usable produced narration from the stale same-named reference. */
function wavBytes(): Buffer {
  const sampleRate = 8_000;
  const samples = 800;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((i / sampleRate) * Math.PI * 2 * 440) * 8_000), i * 2);
  }
  const out = Buffer.alloc(44 + pcm.length);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(pcm.length, 40);
  pcm.copy(out, 44);
  return out;
}

test.describe.configure({ timeout: 120_000 });

test('reopens a VideoStudio preview from the task workspace in a mixed Agent conversation', async ({ orkas }) => {
  const page = orkas.page!;
  const { conversation: { conversation_id: cid } } = await orkas.invoke<any>('conversations.create', {
    title: 'Mixed Agent video task',
  });
  const taskRoot = path.join(orkas.workspaceRoot, 'task-files');
  const taskDir = path.join(taskRoot, 'promo');
  const codingDir = path.join(orkas.workspaceRoot, 'code');
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(codingDir, { recursive: true });
  writeFileSync(path.join(taskDir, 'main-v6.mp4'), readFileSync(path.join(__dirname, 'fixtures/content-workbench-preview.mp4')));
  writeFileSync(path.join(codingDir, 'main-v6.mp4'), 'unrelated file with the same name');

  const { uid, videoStudioId } = await orkas.electronApp!.evaluate(async (_electron, input) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const uid = require(`${input.root}/features/users.ts`).getActiveUserId();
    const workspace = require(`${input.root}/features/user_workspace.ts`);
    if (!workspace.setWorkspacePath(uid, input.taskRoot).ok) throw new Error('Could not set task workspace');
    await require(`${input.root}/features/group_chat/state.ts`).setWorkspaceDirOnce(uid, input.cid, 'promo');
    require(`${input.root}/features/local_agents/project-directory.ts`).writeCodingDirectory(uid, input.cid, input.codingDir, true);
    const { VIDEO_STUDIO_AGENT_ID } = require(`${input.root}/model/core-agent/tool-catalog.ts`);
    return { uid, videoStudioId: VIDEO_STUDIO_AGENT_ID };
  }, { root: path.resolve(__dirname, '../../src/main'), cid, taskRoot, codingDir });
  const history = path.join(orkas.workspaceRoot, uid, 'cloud', 'chats', `${cid}.jsonl`);
  appendFileSync(history, JSON.stringify({
    id: 'legacy-video-reply', ts: '2026-11-26T15:34:26', from: videoStudioId, to: ['user'],
    text: 'A revised cut is pending. [Original v6](main-v6.mp4) is still available.',
  }) + '\n');

  await page.evaluate(async id => {
    await (window as any).loadConversations();
    await (window as any).setView('conversation', id);
  }, cid);
  const reply = page.locator('#chat-history .chat-message[data-msg-id="legacy-video-reply"]');
  const video = reply.locator('video');
  const expectPlayable = async () => {
    await expect(video).toHaveCount(1);
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBeGreaterThan(0);
    await expect(reply.locator('.chat-md-video-load-failure, .chat-md-video-missing')).toHaveCount(0);
  };
  await expectPlayable();
  await page.reload();
  await expectPlayable();
});

test('task attachments include early uploads beyond the history page and survive composer clearing', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  const cid = (await orkas.invoke<any>('conversations.create', { title: 'Complete attachment inventory' })).conversation.conversation_id;
  const oldName = 'Earlier-brief-历史附件-完整文件名称.txt';
  for (const [name, text] of [[oldName, 'Earlier attachment contents'], ['pending.txt', 'Pending contents']]) {
    await orkas.invoke('conversations.attachments.upload', { cid, name, data: Buffer.from(text).toString('base64') });
  }
  const chatFile = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`);
  appendFileSync(chatFile, [
    { role: 'user', text: 'Earlier upload', attachments: [oldName], time: '2026-11-01T00:00:00Z' },
    ...Array.from({ length: 25 }, (_, i) => ({ role: 'assistant', text: `Later reply ${i}`, time: '2026-11-02T00:00:00Z' })),
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  await page.evaluate(async id => {
    await (window as any).loadConversations();
    await (window as any).setView('conversation', id);
  }, cid);
  await page.locator('#conversation-info-toggle').click();
  const panel = page.locator('#conversation-info-panel');
  await panel.locator('[data-info-tab="attachments"]').click();
  await expect(panel.locator('.ci-attach-row')).toHaveCount(2);
  await expect(panel.locator('.ci-attach-row', { hasText: oldName })).toBeVisible();
  await expect(page.locator('#chat-attachments .chat-attach-label')).toHaveText(['pending.txt']);
  await expect(page.locator('#conversation-info-tab-count-attachments')).toHaveText('2');

  for (const [locale, width, height] of [['en', 1440, 900], ['zh', 800, 600]] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(lang => (window as any).setLang(lang), locale);
    await expect(panel.locator('.ci-attach-row', { hasText: oldName })).toBeInViewport();
    await panel.screenshot({ path: testInfo.outputPath(`attachment-inventory-${locale}.png`) });
  }
  const preview = await orkas.openPreview(() => panel.locator('.ci-attach-row', { hasText: oldName }).click());
  await expect(preview.locator('body')).toContainText('Earlier attachment contents');
  await orkas.closePreview(preview);

  appendFileSync(chatFile, JSON.stringify({ role: 'user', text: 'Sent pending', attachments: ['pending.txt'] }) + '\n');
  await page.evaluate(id => (window as any)._chatAttachClear(id), cid);
  await expect(panel.locator('.ci-attach-row')).toHaveCount(2);
  await expect(page.locator('#chat-attachments .chat-attach-label')).toHaveCount(0);
  await page.evaluate(id => (window as any).ConversationInfo.refreshAttachments(id), cid);
  await expect(panel.locator('.ci-attach-row')).toHaveCount(2);
});

test('task inventory keeps new files and attachments across full and partial refresh races', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  const cid = (await orkas.invoke<any>('conversations.create', { title: 'Refresh ordering' })).conversation.conversation_id;
  const listing = await orkas.invoke<{ root: string }>('conversations.files.list', { cid });
  const chat = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`);
  const addFile = (name: string) => {
    const file = path.join(listing.root, name);
    mkdirSync(listing.root, { recursive: true });
    writeFileSync(file, 'Current generated output');
    appendFileSync(chat, JSON.stringify({ id: 'output-' + name, ts: new Date().toISOString(),
      from: 'commander', to: ['user'], text: 'Generated output', produced: [file] }) + '\n');
  };
  addFile('original.txt');
  await orkas.invoke('conversations.attachments.upload', { cid, name: 'original.txt', data: Buffer.from('Original source').toString('base64') });
  await page.evaluate(async id => {
    await (window as any).loadConversations();
    await (window as any).setView('conversation', id);
  }, cid);
  await page.locator('#conversation-info-toggle').click();
  const panel = page.locator('#conversation-info-panel');
  await expect(panel.locator('.conversation-info-file')).toHaveCount(1);
  for (const resource of ['files', 'attachments'] as const) {
    await panel.locator(`[data-info-tab="${resource}"]`).click();
    for (const older of ['full', 'partial'] as const) {
      await page.evaluate(({ id, resource, older }) => {
        const win = window as any;
        const original = win.apiFetch;
        let held = false;
        win.__inventoryRace = { ready: false, original };
        win.apiFetch = async (url: string, ...args: any[]) => {
          const response = await original(url, ...args);
          if (!held && url.includes('/' + resource)) {
            held = true;
            const payload = await response.json();
            return new Promise(resolve => {
              win.__inventoryRace.release = () => resolve({ json: async () => payload });
              win.__inventoryRace.ready = true;
            });
          }
          return response;
        };
        const info = win.ConversationInfo;
        win.__inventoryRace.pending = older === 'full' ? info.refresh(id, { silent: true })
          : resource === 'files' ? info.refreshFiles(id, { silent: true }) : info.refreshAttachments(id);
      }, { id: cid, resource, older });
      await page.waitForFunction(() => (window as any).__inventoryRace?.ready === true);
      const name = `latest-${resource}-${older}.txt`;
      if (resource === 'files') addFile(name);
      else {
        const uploaded = await orkas.invoke<any>('conversations.attachments.upload', { cid, name, data: Buffer.from('Current source ' + name).toString('base64') });
        expect(uploaded.ok).toBe(true);
        expect(uploaded.info.name).toBe(name);
      }
      await page.evaluate(async ({ id, resource, older }) => {
        const win = window as any;
        const race = win.__inventoryRace;
        win.apiFetch = race.original;
        try {
          if (older === 'partial') await win.ConversationInfo.refresh(id, { silent: true });
          else if (resource === 'files') await win.ConversationInfo.refreshFiles(id, { silent: true });
          else await win.ConversationInfo.refreshAttachments(id);
        } finally {
          race.release();
          await race.pending;
          delete win.__inventoryRace;
        }
      }, { id: cid, resource, older });
      await expect(panel).toContainText(name);
    }
  }
  for (const [locale, width, height] of [['en', 1440, 900], ['zh', 800, 600]] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(lang => (window as any).setLang(lang), locale);
    await expect(panel.locator('.ci-attach-row')).toHaveCount(3);
    await panel.screenshot({ path: testInfo.outputPath(`inventory-race-${locale}.png`) });
  }
});

test('opens a confirmed attachment when task detail history is unavailable', async ({ orkas }) => {
  const page = orkas.page!;
  const cid = (await orkas.invoke<any>('conversations.create', { title: 'Attachment recovery' })).conversation.conversation_id;
  const attachment = { cid, name: 'brief.txt', data: Buffer.from('Saved brief contents').toString('base64') };
  expect(await orkas.invoke('conversations.attachments.upload', attachment)).toMatchObject({ ok: true });
  await page.evaluate(async id => {
    const win = window as any;
    await win.loadConversations();
    await win.setView('conversation', id);
    const originalFetch = win.apiFetch;
    win.apiFetch = (url: string, ...args: unknown[]) => url.includes('/history?limit=10')
      ? Promise.resolve({ json: async () => ({ ok: false, error: 'History unavailable' }) })
      : originalFetch(url, ...args);
  }, cid);

  await page.locator('#conversation-info-toggle').click();
  const panel = page.locator('#conversation-info-panel');
  await expect(panel.locator('.conversation-info-empty.is-error')).toBeVisible();
  await panel.locator('[data-info-tab="attachments"]').click();
  const row = panel.getByRole('button', { name: /brief\.txt/ });
  await expect(row).toBeVisible();
  await expect(page.locator('#conversation-info-tab-count-attachments')).toHaveText('1');
  const preview = await orkas.openPreview(() => row.click());
  await expect(preview.locator('body')).toContainText('Saved brief contents');
  await orkas.closePreview(preview);
});

test('task details remembers open and closed panels and each selected tab across navigation', async ({ orkas }) => {
  const page = orkas.page!;
  const first = (await orkas.invoke<any>('conversations.create', { title: 'Details state first' })).conversation.conversation_id;
  const second = (await orkas.invoke<any>('conversations.create', { title: 'Details state second' })).conversation.conversation_id;
  await page.evaluate(() => (window as any).loadConversations());
  const enter = (cid: string) => page.evaluate(id => (window as any).setView('conversation', id), cid);
  const panel = page.locator('#conversation-info-panel');
  const toggle = page.locator('#conversation-info-toggle');
  const tab = (name: string) => panel.locator(`[data-info-tab="${name}"]`);

  await enter(first);
  await expect(panel).toBeHidden();
  await toggle.click();
  await tab('attachments').click();
  await enter(second);
  await expect(panel).toBeHidden();
  await toggle.click();
  await expect(tab('files')).toHaveClass(/is-active/);
  await tab('browser').click();
  await expect(page.locator('.web-assist-shell')).toBeVisible();
  await enter(first);
  await expect(panel).toBeVisible();
  await expect(tab('attachments')).toHaveClass(/is-active/);
  await expect(page.locator('.web-assist-shell')).toBeHidden();
  await page.locator('#conversation-info-close').click();
  await enter(second);
  await expect(panel).toBeVisible();
  await expect(tab('browser')).toHaveClass(/is-active/);
  await expect(page.locator('.web-assist-shell')).toBeVisible();
  await enter(first);
  await expect(panel).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(tab('attachments')).toHaveClass(/is-active/);
  await page.evaluate(() => (window as any).setView('connectors'));
  await enter(first);
  await expect(panel).toBeVisible();
  await expect(tab('attachments')).toHaveClass(/is-active/);
  await toggle.click();
  await page.evaluate(() => (window as any).setView('connectors'));
  await enter(first);
  await expect(panel).toBeHidden();
});

test('lists nothing for a conversation that has not run, whatever else is in the workspace', async ({ orkas }) => {
  const page = orkas.page!;
  orkas.createWorkspaceFile('another-conversation/report.md', '# Not this one\n');
  const cid = (await orkas.invoke<any>('conversations.create', { title: 'Not run yet' })).conversation.conversation_id;
  await page.evaluate(async (id) => {
    await (window as any).loadConversations();
    (window as any).setView('conversation', id);
  }, cid);
  await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
  await page.locator('#conversation-info-toggle').click();
  const panel = page.locator('#conversation-info-panel');
  await expect(panel).toContainText('No files yet');
  await expect(panel.locator('.conversation-info-file')).toHaveCount(0);
  // Finish the cold derived turn index before the isolated fixture closes its worker.
  await page.evaluate(async id => {
    await (window as any).ConversationTurnNav.open({ cid: id,
      loadPage: (before: number | null) => (window as any)._loadConversationTurnNavigationPage(id, before) });
  }, cid);
});

test('surfaces produced files, outside files, and artifacts for one conversation', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  const diagnostics = orkas.rendererDiagnosticCheckpoint();
  const uid = 'account-e2e';
  const chatFile = (cid: string) => path.join(
    orkas.workspaceRoot, uid, 'cloud', 'chats', `${cid}.jsonl`,
  );

  const created = await orkas.invoke<{ conversation: { conversation_id: string } }>(
    'conversations.create',
    { title: 'Outputs check' },
  );
  const cid = created.conversation.conversation_id;

  // Each injected bad-media record belongs to one fault/recovery scenario.
  // Retire it only after its outcome and exact diagnostic were asserted, so
  // later independent history redraws cannot replay an earlier fixture fault.
  const retireFixtureFault = (id: string) => {
    const records = readFileSync(chatFile(cid), 'utf8').trim().split('\n').filter(Boolean);
    const kept = records.filter(line => JSON.parse(line).id !== id);
    expect(records.length - kept.length).toBe(1);
    writeFileSync(chatFile(cid), `${kept.join('\n')}\n`);
  };

  await page.evaluate(async (id) => {
    await (window as any).loadConversations();
    (window as any).setView('conversation', id);
  }, cid);
  await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
  const listing = await orkas.invoke<{ root: string }>('conversations.files.list', { cid });

  const wsDir = path.join(listing.root, 'reports');
  mkdirSync(wsDir, { recursive: true });
  const imagePath = path.join(wsDir, 'cover.png');
  writeFileSync(imagePath, pngBytes(64, 40));
  const notesPath = path.join(wsDir, 'summary.md');
  writeFileSync(notesPath, '# Summary\n');

  // Written somewhere the workspace scan cannot reach.
  const outsideDir = path.join(orkas.root, 'seo-review-20260817');
  mkdirSync(outsideDir, { recursive: true });
  const outsidePath = path.join(outsideDir, 'TARGETS.md');
  writeFileSync(outsidePath, '# Targets\n');

  // A create_artifact bundle in the pool the workspace scan can never reach.
  const artifactId = 'aRtIfAcT00001';
  const artifactDir = path.join(orkas.workspaceRoot, uid, 'cloud', 'chat_artifacts', cid, artifactId);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    path.join(artifactDir, 'index.html'),
    '<!doctype html><title>Pricing calculator</title><h1>Pricing calculator</h1>',
  );
  writeFileSync(
    path.join(artifactDir, '__orkas-meta.json'),
    JSON.stringify({
      title: 'Pricing calculator',
      agentId: 'commander',
      createdAt: new Date(0).toISOString(),
    }),
  );

  appendFileSync(chatFile(cid), `${JSON.stringify({
    id: 'm_outputs_user',
    ts: new Date(Date.now() - 2000).toISOString(),
    from: 'user',
    to: ['commander'],
    text: 'Make the cover and the target list.',
  })}\n${JSON.stringify({
    id: 'm_outputs_reply',
    ts: new Date(Date.now() - 1000).toISOString(),
    from: 'commander',
    to: ['user'],
    text: 'Done. The cover image, a summary, and the target list are ready.',
    produced: [imagePath, notesPath, outsidePath],
    artifacts: [{ id: artifactId, title: 'Pricing calculator', agent_id: 'commander' }],
  })}\n`, 'utf8');

  const reopen = async () => {
    await page.evaluate(async (id) => {
      (window as any).setView('new-chat');
      (window as any).setView('conversation', id);
    }, cid);
    await expect(page.locator('#panel-conversation')).toHaveClass(/\bactive\b/);
  };
  await reopen();

  const reply = page.locator('#chat-history .chat-message.assistant').last();
  // Every deliverable stays reachable, and the image the reply never embedded
  // is presented by the host.
  await expect(reply.locator('.chat-msg-produced-item')).toHaveCount(3);
  await expect(reply.locator('.chat-msg-produced-media img.chat-md-img')).toHaveCount(1);
  await expect(reply.locator('.chat-artifact-host')).toHaveCount(1);

  await page.locator('#conversation-info-toggle').click();
  const panel = page.locator('#conversation-info-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-info-tab]')).toHaveCount(3);
  await expect(panel.locator('[data-info-tab].is-active')).toHaveAttribute('data-info-tab', 'files');
  // Workspace files keep their tree position; the artifact and the stray file
  // get their own sections instead of being hung off the tree root.
  await expect(panel.locator('.conversation-info-dir-name')).toHaveText('reports');
  await expect(panel.locator('.conversation-info-file.is-outside')).toHaveCount(1);
  await expect(panel.locator('.conversation-info-file.is-outside')).toContainText('TARGETS.md');
  await expect(panel.locator('.conversation-info-file[data-artifact-id]')).toHaveCount(1);
  await expect(panel.locator('.conversation-info-file[data-artifact-id]')).toContainText('Pricing calculator');
  // The badge is the user's cue that the turn produced something; an artifact
  // is one of those things.
  await expect(page.locator('#conversation-info-tab-count-files')).toHaveText('4');

  // Revealing a file that has moved away explains the recovery in the UI language,
  // without the host reason or its local path. (UI review capture: zh, default window.)
  const movedNotes = `${notesPath}.moved`;
  const previousLang = await page.evaluate(() => (window as any).getLang());
  try {
    await page.evaluate(() => (window as any).setLang('zh'));
    const escapedNotesPath = await page.evaluate(value => CSS.escape(value), notesPath);
    const notesRow = panel.locator(`.conversation-info-file[data-file-path="${escapedNotesPath}"]`);
    await expect(notesRow).toHaveCount(1);
    const reports = panel.locator('details.conversation-info-dir');
    if (!await reports.evaluate(node => (node as HTMLDetailsElement).open)) await reports.locator('> summary').click();
    await notesRow.scrollIntoViewIfNeeded(); await notesRow.hover();
    await notesRow.locator('.conversation-info-file-menu-btn').click();
    renameSync(notesPath, movedNotes);
    await page.locator('.ctx-row-menu-item[data-action="reveal"]').click();
    const revealAlert = page.locator('.ui-dialog-overlay:visible');
    await expect(revealAlert.locator('.ui-dialog-message')).toHaveText('无法打开所在文件夹，文件可能已被移动或删除。');
    await expect(revealAlert).not.toContainText(listing.root);
    await revealAlert.locator('.ui-dialog').screenshot({ path: testInfo.outputPath('ui-review', '11-folder-reveal-failed.png') });
    await revealAlert.locator('[data-act="ok"]').click(); await expect(revealAlert).toHaveCount(0);
  } finally {
    try { renameSync(movedNotes, notesPath); } catch { /* not moved */ }
    await page.evaluate(lang => (window as any).setLang(lang), previousLang);
  }

  // Opening the artifact from the panel reaches the same frame the bubble uses.
  const artifactPreview = await orkas.openPreview(() => panel.locator('.conversation-info-file[data-artifact-id]').click());
  await expect(artifactPreview.locator('.chat-artifact-viewer.is-open')).toBeVisible();
  await orkas.closePreview(artifactPreview);
  await page.locator('#conversation-info-toggle').click();

  // A reply that embedded the media itself must not gain a second copy.
  const secondImage = path.join(wsDir, 'poster.png');
  writeFileSync(secondImage, pngBytes(64, 40));
  const mediaUrl = `chat-media://local/${
    secondImage.replace(/^\//, '').split('/').map(encodeURIComponent).join('/')
  }`;
  appendFileSync(chatFile(cid), `${JSON.stringify({
    id: 'm_outputs_reply_2',
    ts: new Date().toISOString(),
    from: 'commander',
    to: ['user'],
    text: `Here is the poster.\n\n![poster](${mediaUrl})`,
    produced: [secondImage],
  })}\n`, 'utf8');
  await reopen();

  const pasted = page.locator('#chat-history .chat-message.assistant').last();
  await expect(pasted.locator('.chat-msg-produced-item')).toHaveCount(1);
  await expect(pasted.locator('img.chat-md-img')).toHaveCount(1);
  await expect(pasted.locator('.chat-msg-produced-media')).toHaveCount(0);

  // A model can retain an earlier audition path while the completed turn
  // publishes a new same-named narration. The stale player reports 0:00 and
  // the host-rendered produced player works; once that failure is known, keep
  // only the usable narration rather than showing two indistinguishable cards.
  const narrationPath = path.join(wsDir, 'narration.wav');
  writeFileSync(narrationPath, wavBytes());
  const staleNarrationPath = path.join(listing.root, 'discarded-audition', 'narration.wav');
  const staleNarrationUrl = `chat-media://local/${
    staleNarrationPath.replace(/^\//, '').split('/').map(encodeURIComponent).join('/')
  }`;
  const staleNarrationDiagnostics = orkas.rendererDiagnosticCheckpoint();
  const staleNarrationResponse = page.waitForResponse(response => response.url() === staleNarrationUrl);
  appendFileSync(chatFile(cid), `${JSON.stringify({
    id: 'm_outputs_reply_stale_narration',
    ts: new Date().toISOString(),
    from: 'commander',
    to: ['user'],
    text: `Narration audition:\n\n[narration.wav](${staleNarrationUrl})`,
    produced: [narrationPath],
  })}\n`, 'utf8');
  await reopen();

  const narration = page.locator('#chat-history .chat-message.assistant').last();
  await expect(narration.locator('.chat-md-audio-card')).toHaveCount(1);
  await expect(narration.locator('.chat-msg-produced-media .chat-md-audio')).toHaveJSProperty('duration', 0.1);
  await expect(narration.locator('.chat-msg-produced-item')).toContainText('narration.wav');
  expect((await staleNarrationResponse).status()).toBe(404);
  await orkas.acknowledgeRendererFailure({ surface: page, after: staleNarrationDiagnostics, count: 1,
    detail: 'Failed to load resource: the server responded with a status of 404 (Not Found)' });
  retireFixtureFault('m_outputs_reply_stale_narration');

  // A model can copy a long delivery link wrong: on 2026-11-07 Luna's link broke the
  // percent-encoding of a Chinese folder name mid-character. Such a link names no file, so it
  // never plays and retrying cannot help. With the delivered file shown by the host in the same
  // reply, the reply keeps that one player; without it, the link becomes the missing-video chip.
  const deliveredPath = path.join(wsDir, 'main-v1.mp4');
  await orkas.electronApp!.evaluate(async (_electron, args) => {
    const require = (process as any).mainModule.require.bind((process as any).mainModule);
    const { ffmpeg } = require(args.module).bundledFfmpegPaths();
    if (!ffmpeg) throw new Error('Bundled FFmpeg is required for this fixture');
    await new Promise<void>((resolve, reject) => {
      require('node:child_process').execFile(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=s=320x568:r=30:d=1', '-c:v', 'libx264', '-preset', 'veryfast',
        '-pix_fmt', 'yuv420p', '-threads', '1', args.file],
      { windowsHide: true, timeout: 60000 }, (error: Error | null) => (error ? reject(error) : resolve()));
    });
  }, { module: path.resolve(__dirname, '../../src/main/util/bundled-runtime.ts'), file: deliveredPath });
  const encodedReports = wsDir.replace(/^\//, '').split(/[\\/]/).map(encodeURIComponent).join('/');
  const brokenDeliveryUrl = `chat-media://local/${encodedReports}/%E8%BF%99%E6%98%AF%E护眼台灯/main-v1.mp4?v=1-1-1`;
  const brokenDiagnostics = orkas.rendererDiagnosticCheckpoint();
  const brokenResponse = page.waitForResponse(response => response.url().startsWith(`chat-media://local/${encodedReports}/%E8%BF%99`));
  appendFileSync(chatFile(cid), `${JSON.stringify({
    id: 'm_outputs_reply_broken_delivery_link',
    ts: new Date().toISOString(),
    from: 'commander',
    to: ['user'],
    text: `[Download the video](${brokenDeliveryUrl}) The video is ready.`,
    produced: [deliveredPath],
  })}\n`, 'utf8');
  await reopen();
  const delivered = page.locator('#chat-history .chat-message.assistant').last();
  await expect(delivered.locator('.chat-msg-produced-media video')).toHaveCount(1);
  await expect(delivered.locator('video')).toHaveCount(1);
  await expect(delivered.locator('.chat-md-video-load-failure, .chat-md-video-missing')).toHaveCount(0);
  await expect.poll(() => delivered.locator('.chat-msg-produced-media video')
    .evaluate((video: HTMLVideoElement) => video.duration)).toBeGreaterThan(0.9);
  expect((await brokenResponse).status()).toBe(400);
  await orkas.acknowledgeRendererFailure({ surface: page, after: brokenDiagnostics, count: 1,
    detail: 'Failed to load resource: the server responded with a status of 400 (Bad Request)' });
  retireFixtureFault('m_outputs_reply_broken_delivery_link');

  const brokenAloneDiagnostics = orkas.rendererDiagnosticCheckpoint();
  appendFileSync(chatFile(cid), `${JSON.stringify({
    id: 'm_outputs_reply_broken_link_alone',
    ts: new Date().toISOString(),
    from: 'commander',
    to: ['user'],
    text: `Earlier cut:\n\n[Earlier cut](chat-media://local/${encodedReports}/%E8%BF%99%E6%98%AF%E护眼台灯/earlier-cut.mp4)`,
  })}\n`, 'utf8');
  await reopen();
  const alone = page.locator('#chat-history .chat-message.assistant').last();
  await expect(alone.locator('.chat-md-video-missing')).toHaveCount(1);
  for (const [language, width, height] of [['en', 1280, 720], ['zh', 900, 600]] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(lang => (window as any).setLang(lang), language);
    await alone.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('missing-media-' + language + '.png') });
  }
  await page.evaluate(() => (window as any).setLang('en'));
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(alone.locator('.chat-md-video-shell, video, .chat-md-video-load-failure')).toHaveCount(0);
  await orkas.acknowledgeRendererFailure({ surface: page, after: brokenAloneDiagnostics, count: 1,
    detail: 'Failed to load resource: the server responded with a status of 400 (Bad Request)' });
  retireFixtureFault('m_outputs_reply_broken_link_alone');

  // Revisit existing files in the body while the footer contains only this
  // reply's new output. The outside file needs the current conversation scope;
  // a custom link label must not replace the filename used to select a viewer.
  const htmlPath = path.join(wsDir, 'previous draft (1).html');
  writeFileSync(htmlPath, '<!doctype html><html><body><h1>Previous draft</h1></body></html>');
  const currentPath = path.join(wsDir, 'revision.txt');
  writeFileSync(currentPath, 'Current revision');
  appendFileSync(chatFile(cid), `${JSON.stringify({
    id: 'm_existing_files_reply',
    ts: new Date().toISOString(),
    from: 'commander',
    to: ['user'],
    text: `Existing references:\n\n[Read the summary](${notesPath}:21)\n\n[Read targets](${outsidePath})\n\n[Open previous draft](<${htmlPath}>)\n\n<span class="file-reference-baseline">正文对齐</span> [正文对齐](${notesPath}:21:5)\n\n[Read relative summary](reports/summary.md#L21)\n\n[Outside relative](<${path.relative(listing.root, outsidePath)}>)\n\n[Missing relative](reports/missing.md)`,
    produced: [currentPath],
  })}\n`, 'utf8');
  await reopen();

  const references = page.locator('#chat-history .chat-message.assistant').last();
  await expect(references.locator('[data-chat-md-file-open="1"]')).toHaveCount(5);
  await expect(references.getByRole('button', { name: 'Outside relative' })).toHaveCount(0);
  await expect(references.getByRole('button', { name: 'Missing relative' })).toHaveCount(0);
  await expect(references).toContainText('TARGETS.md');
  await expect(references).toContainText('missing.md');
  const baselineOffset = await references.evaluate((element) => {
    const textRect = (selector: string) => {
      const range = document.createRange();
      range.selectNodeContents(element.querySelector(selector)!);
      return range.getBoundingClientRect();
    };
    const prose = textRect('.file-reference-baseline');
    const label = textRect('.file-reference-baseline + .chat-attach-chip .chat-attach-label');
    return Math.abs(prose.bottom - label.bottom);
  });
  expect(baselineOffset).toBeLessThanOrEqual(1);
  await references.screenshot({ path: testInfo.outputPath('inline-file-references.png') });
  await expect(references.locator('.chat-msg-produced-item')).toHaveCount(1);
  await expect(references.locator('.chat-msg-produced-item')).toContainText('revision.txt');
  let preview: import('@playwright/test').Page;
  let viewer: import('@playwright/test').Locator;
  for (const [label, name, content] of [
    ['Read the summary', 'summary.md', 'Summary'],
    ['Read targets', 'TARGETS.md', 'Targets'],
    ['Read relative summary', 'summary.md', 'Summary'],
  ]) {
    preview = await orkas.openPreview(() => references.getByRole('button', { name: label, exact: true }).click());
    viewer = preview.locator('.chat-file-viewer');
    await expect(viewer).toHaveClass(/\bis-open\b/);
    await expect(viewer.locator('.chat-file-viewer-title')).toHaveText(name);
    await expect(viewer.locator('.chat-file-viewer-body')).toContainText(content);
    await orkas.closePreview(preview);
  }
  preview = await orkas.openPreview(() => references.getByRole('button', { name: 'Open previous draft', exact: true }).click());
  viewer = preview.locator('.chat-file-viewer');
  await expect(viewer.locator('.chat-file-viewer-title')).toHaveText('previous draft (1).html');
  await expect(preview.frameLocator('.chat-file-viewer-html').getByRole('heading', { name: 'Previous draft' })).toBeVisible();
  await orkas.closePreview(preview);

  // A stale reference gives feedback; it neither reopens stale preview content
  // nor adds the missing file to the turn's outputs.
  unlinkSync(notesPath);
  await references.getByRole('button', { name: 'Read the summary', exact: true }).click();
  await expect(page.locator('.ui-toast')).toContainText('no longer exists');
  await expect.poll(() => preview.isClosed()).toBe(true);
  await expect(references.locator('.chat-msg-produced-item')).toHaveCount(1);

  writeFileSync(notesPath, '# Restored summary\nFresh contents after recovery.\n');
  preview = await orkas.openPreview(() => references.getByRole('button', { name: 'Read the summary', exact: true }).click());
  viewer = preview.locator('.chat-file-viewer');
  await expect(viewer).toHaveClass(/\bis-open\b/);
  await expect(viewer.locator('.chat-file-viewer-body')).toContainText('Fresh contents after recovery.');
  await orkas.closePreview(preview);

  // A reference-only reply must stay usable after a full renderer reload,
  // including keyboard activation, without claiming an output for this turn.
  const longLabel = 'Read the previous summary and its detailed supporting notes from the earlier conversation';
  appendFileSync(chatFile(cid), `${JSON.stringify({
    id: 'm_reference_only_reply',
    ts: new Date().toISOString(),
    from: 'commander',
    to: ['user'],
    text: `Here is the existing reference: [${longLabel}](${notesPath})`,
  })}\n`, 'utf8');
  await page.reload();
  await page.waitForFunction(() => typeof (window as any).setView === 'function');
  await reopen();

  const referenceOnly = page.locator('#chat-history .chat-message.assistant').last();
  const card = referenceOnly.getByRole('button', { name: longLabel, exact: true });
  await expect(card).toBeVisible();
  await expect(referenceOnly.locator('.chat-msg-produced')).toHaveCount(0);
  // Long labels remain inside the chip; the full accessible name is retained.
  const label = card.locator('.chat-attach-label');
  await expect(label).toHaveCSS('text-overflow', 'ellipsis');
  expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await card.focus();
  preview = await orkas.openPreview(() => page.keyboard.press('Enter'));
  viewer = preview.locator('.chat-file-viewer');
  await expect(viewer).toHaveClass(/\bis-open\b/);
  await expect(viewer.locator('.chat-file-viewer-title')).toHaveText('summary.md');
  await expect(viewer.locator('.chat-file-viewer-body')).toContainText('Fresh contents after recovery.');
  await expect(referenceOnly.locator('.chat-msg-produced')).toHaveCount(0);
  await orkas.acknowledgeInvokeFailures('workspace.revealPath', 1, diagnostics);
});

test('opens code references from the project task selected directory', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  const uid = 'account-e2e';
  const { project } = await orkas.invoke<{ project: { project_id: string } }>('projects.create', { name: 'Code references' });
  const { conversation } = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', {
    title: 'Review the code', projectId: project.project_id,
  });
  const cid = conversation.conversation_id;
  // Real persisted device selection, outside the app's default workspace.
  // These existing source files have never been recorded as produced outputs.
  const repository = path.join(orkas.root, 'selected repository');
  mkdirSync(repository);
  const runner = path.join(repository, 'runner.ts');
  const bridge = path.join(repository, 'bridge.ts');
  writeFileSync(runner, 'export const assembleAgent = () => "agent ready";\n');
  writeFileSync(bridge, 'export const authorizeCli = () => "cli authorized";\n');
  const selection = path.join(orkas.workspaceRoot, uid, 'local', 'cli-directories', `${cid}.json`);
  mkdirSync(path.dirname(selection), { recursive: true });
  writeFileSync(selection, JSON.stringify({ version: 1, directory: repository, explicit: true }));
  // Ordinary local files can be previewed read-only. Managed data belonging to
  // another account is the denied boundary, even when referenced by this task.
  const unavailable = path.join(orkas.workspaceRoot, 'other-account', 'cloud', 'unselected.txt');
  mkdirSync(path.dirname(unavailable), { recursive: true });
  const privateSource = 'Private source belonging to another account';
  writeFileSync(unavailable, privateSource);
  const history = path.join(orkas.workspaceRoot, uid, 'cloud', 'projects', project.project_id, 'chats', `${cid}.jsonl`);
  appendFileSync(history, `${JSON.stringify({
    id: 'm_code_reference', ts: new Date().toISOString(), from: 'commander', to: ['user'],
    text: `按本次运行条件授予。[Agent 组装逻辑](<${runner}:646>)、[CLI 授权逻辑](bridge.ts#L212)\n\n[Unselected file](<${unavailable}>)`,
  })}\n`);
  await page.evaluate(async (id) => {
    await (window as any).loadConversations();
    (window as any).setView('conversation', id);
  }, cid);
  const reply = page.locator('#chat-history .chat-message.assistant').last();
  let preview: import('@playwright/test').Page;
  let viewer: import('@playwright/test').Locator;
  await expect(reply.getByRole('button', { name: 'Agent 组装逻辑', exact: true })).toBeVisible();
  await reply.screenshot({ path: testInfo.outputPath('coding-file-references.png') });
  for (const [label, name, content] of [
    ['Agent 组装逻辑', 'runner.ts', 'agent ready'],
    ['CLI 授权逻辑', 'bridge.ts', 'cli authorized'],
  ]) {
    preview = await orkas.openPreview(() => reply.getByRole('button', { name: label, exact: true }).click());
    viewer = preview.locator('.chat-file-viewer');
    await expect(viewer).toHaveClass(/\bis-open\b/);
    await expect(viewer.locator('.chat-file-viewer-title')).toHaveText(name);
    await expect(viewer.locator('.chat-file-viewer-body')).toContainText(content);
    await expect(reply.locator('.chat-msg-produced')).toHaveCount(0);
    if (name === 'runner.ts') await viewer.screenshot({ path: testInfo.outputPath('coding-file-preview.png') });
    await orkas.closePreview(preview);
  }

  const deniedReferenceDiagnostics = orkas.rendererDiagnosticCheckpoint();
  await reply.getByRole('button', { name: 'Unselected file', exact: true }).click();
  const dialog = page.locator('.ui-dialog-overlay:visible');
  await expect(dialog).toContainText('Could not read');
  await expect(page.locator('.ui-toast').filter({ hasText: 'no longer exists' })).toHaveCount(0);
  await dialog.locator('[data-act="cancel"]').click();
  await expect.poll(() => preview.isClosed()).toBe(true);
  preview = await orkas.openPreview(() => reply.getByRole('button', { name: 'Agent 组装逻辑', exact: true }).click());
  viewer = preview.locator('.chat-file-viewer');
  await expect(viewer.locator('.chat-file-viewer-body')).toContainText('agent ready');
  expect(readFileSync(unavailable, 'utf8')).toBe(privateSource);
  await orkas.acknowledgeInvokeFailures('workspace.statPath', 1, deniedReferenceDiagnostics);
});


// Preserve the independent audio-width/playback journey from the retired video
// drawer against the shared current side panel, without reviving its old model.
test('keeps narration inside the conversation while the current side panel resizes', async ({ orkas }, testInfo) => {
  const page = orkas.page!;
  const cid = (await orkas.invoke<any>('conversations.create', { title: 'Audio and panel width' })).conversation.conversation_id;
  await page.evaluate(async id => {
    await (window as any).loadConversations();
    await (window as any).setView('conversation', id);
  }, cid);
  const listing = await orkas.invoke<{ root: string }>('conversations.files.list', { cid });
  const narration = path.join(listing.root, 'narration.wav');
  mkdirSync(listing.root, { recursive: true });
  writeFileSync(narration, wavBytes());
  const history = path.join(orkas.workspaceRoot, 'account-e2e', 'cloud', 'chats', `${cid}.jsonl`);
  appendFileSync(history, JSON.stringify({
    id: 'm_audio_panel_width', ts: new Date().toISOString(), from: 'commander', to: ['user'],
    text: `Narration: [narration](<${narration}>)`, produced: [narration],
  }) + '\n');
  await page.evaluate(async id => {
    await (window as any).setView('new-chat');
    await (window as any).setView('conversation', id);
  }, cid);
  const card = page.locator('#chat-history .chat-message.assistant .chat-md-audio-card');
  const audio = card.locator('audio');
  await expect(audio).toBeVisible();
  const fits = () => card.evaluate(el => {
    const bounds = el.getBoundingClientRect();
    const body = el.closest('.markdown-body')!.getBoundingClientRect();
    const audio = el.querySelector('audio')!.getBoundingClientRect();
    return bounds.right <= body.right + 1 && bounds.width <= body.width + 1 && audio.right <= bounds.right;
  });
  await page.locator('#conversation-info-toggle').click();
  const panel = page.locator('#conversation-info-panel');
  await expect(panel).toBeVisible();
  await page.setViewportSize({ width: 1800, height: 900 });
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(540);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await panel.boundingBox())!.width).toBe(400);
  await expect.poll(fits).toBe(true);
  const before = (await card.boundingBox())!.width;
  const grip = (await page.locator('#conversation-info-resize').boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 100);
  await page.mouse.down();
  await page.mouse.move(grip.x - 150, grip.y + 100);
  await page.mouse.up();
  expect((await panel.boundingBox())!.width).toBeGreaterThan(500);
  await expect.poll(fits).toBe(true);
  expect((await card.boundingBox())!.width).toBeLessThan(before);
  await audio.evaluate(async (el: HTMLAudioElement) => { el.muted = true; await el.play(); });
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0);
  await audio.evaluate((el: HTMLAudioElement) => el.pause());
  await page.screenshot({ path: testInfo.outputPath('audio-and-current-side-panel.png') });
});
