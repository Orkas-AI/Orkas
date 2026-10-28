import path from 'node:path';
import { expect, test } from './fixtures/orkas';

const CONTENT_WRITER_ID = '173d4235a431';
const pcRoot = path.resolve(__dirname, '../..');


test('restores a running conversation with only user-selected attachments and its original turn time', async ({ modelOrkas: app }, info) => {
  const page = app.page!;
  app.setAgentHandoffScenario(CONTENT_WRITER_ID, 'Prepare the narration.',
    'The narration is ready.', { holdAgentReply: true });
  await page.locator('#new-chat-input').fill('Ask ContentWriter to prepare the narration.');
  await page.locator('#new-chat-send-btn').click();
  await expect.poll(() => app.hasPendingAgentHandoffReply(), { timeout: 30_000 }).toBe(true);
  const cid = await page.evaluate<string>('currentCid');
  const source = app.createFixtureFile('my-notes.txt', 'Keep these user-selected notes.');
  await app.selectFilesOnNextDialog([source]);
  await page.locator('#chat-attach-btn').click();
  await expect(page.locator('#chat-attachments .chat-attach-label')).toHaveText('my-notes.txt');

  // Replace only media generation with deterministic bytes. The attachment
  // owner, IPC, composer recovery, live turn and terminal cleanup are real.
  const start = await app.electronApp!.evaluate(async (_electron, input) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const uid = req(`${input.root}/src/main/features/users.ts`).getActiveUserId();
    const attachments = req(`${input.root}/src/main/features/chat_attachments.ts`);
    const root = req(`${input.root}/src/main/util/project-layout.ts`).chatAttachmentDirForConversation(uid, input.cid);
    const fs = req('node:fs');
    const path = req('node:path');
    fs.mkdirSync(root, { recursive: true });
    for (const name of ['narration-01.mp3', 'narration-02.mp3', 'narration-03.mp3']) {
      const file = path.join(root, name);
      fs.writeFileSync(file, 'deterministic generated audio');
      attachments.recordGeneratedAttachment(uid, input.cid, file);
    }
    return req(`${input.root}/src/main/features/group_chat/bus.ts`).runtimeSnapshot(uid, input.cid)
      .activeTurns.find((turn: any) => turn.actor === input.actor).started_at_ms;
  }, { root: pcRoot, cid, actor: CONTENT_WRITER_ID });

  await page.reload();
  const live = page.locator(`#chat-history .chat-message.assistant[data-from-actor="${CONTENT_WRITER_ID}"]`);
  await expect(live).toHaveCount(1);
  await expect(page.locator('#chat-attachments .chat-attach-label')).toHaveText('my-notes.txt');
  const expectedTime = await page.evaluate(start => (window as any).formatTime(new Date(start).toISOString()), start);
  await expect(live.locator('.chat-msg-time')).toHaveText(expectedTime);
  expect(app.hasPendingAgentHandoffReply()).toBe(true);
  const snapshot = await page.evaluate(async cid => (window as any)._chatAttachSnapshotForSend(cid), cid);
  expect(snapshot.names).toEqual(['my-notes.txt']);
  await page.screenshot({ path: info.outputPath('live-outputs-en.png') });
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.evaluate(async () => (window as any).setLang('zh'));
  await page.reload();
  await expect(page.locator('#chat-attachments .chat-attach-label')).toHaveText('my-notes.txt');
  await page.screenshot({ path: info.outputPath('live-outputs-zh.png') });

  app.releaseAgentHandoffReply();
  await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/, { timeout: 20_000 });
  await expect(page.locator('#chat-history')).toContainText('The narration is ready.');
  await expect(page.locator('#chat-task-board')).toBeHidden();
  await expect(page.locator('#chat-attachments .chat-attach-label')).toHaveText('my-notes.txt');
});
